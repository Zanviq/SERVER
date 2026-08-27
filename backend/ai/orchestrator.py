"""ReAct 오케스트레이터 — 스킬을 연속 실행하며 추론.

LLM이 function_call(스킬 호출)을 내면 디스패치하고 결과(observation)를
대화에 추가해 다음 스텝으로 넘긴다. 텍스트 응답이 나오면 종료.
LLM 객체는 주입 가능(테스트에서 가짜 LLM 사용).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Iterator

from ..config import Settings
from .prompt_builder import build_system
from .skill_base import SkillContext
from .skill_registry import SkillRegistry, default_registry

logger = logging.getLogger("server.ai")


@dataclass
class LLMResult:
    text: str
    tool_use: dict | None = None  # {"name": str, "args": dict} — 단일 호출(하위호환)
    tool_uses: list[dict] = field(default_factory=list)  # 한 응답에 여러 호출이 올 때

    def calls(self) -> list[dict]:
        """이번 응답이 요청한 스킬 호출 전부."""
        if self.tool_uses:
            return self.tool_uses
        return [self.tool_use] if self.tool_use else []


def parse_candidate(cand) -> tuple[str, list[dict]]:
    """응답 후보에서 텍스트와 스킬 호출 '전부'를 뽑는다.

    한 응답에 function_call이 여러 개 올 수 있다(병렬 함수 호출). 첫 개만 쓰고
    나머지를 버리면 모델이 요청한 작업이 조용히 누락되고, 다음 스텝에서 다시
    요청하느라 max_steps를 낭비한다.
    """
    text, tool_uses = "", []
    if cand and getattr(cand, "content", None) and cand.content.parts:
        for part in cand.content.parts:
            fc = getattr(part, "function_call", None)
            if fc and fc.name:
                tool_uses.append({"name": fc.name, "args": dict(fc.args) if fc.args else {}})
            elif getattr(part, "text", ""):
                text += part.text
    return text, tool_uses


class GeminiLLM:
    """google-genai(신 SDK) 기반 function-calling LLM."""

    def __init__(self, settings: Settings, model: str = ""):
        self._settings = settings
        # 설정 화면에서 고른 모델. 비어 있으면 서버 기본(GEMINI_MODEL).
        self._model = model or settings.gemini_model

    def chat(self, contents: list[dict], catalog: list[dict], system: str) -> LLMResult:
        from google import genai
        from google.genai import types

        if not self._settings.gemini_api_key:
            return LLMResult(text="GEMINI_API_KEY가 설정되지 않았습니다 (.env 확인).", tool_use=None)

        client = genai.Client(api_key=self._settings.gemini_api_key)
        config = types.GenerateContentConfig(
            system_instruction=system,
            tools=[types.Tool(function_declarations=catalog)] if catalog else None,
        )
        try:
            resp = client.models.generate_content(
                model=self._model, contents=contents, config=config
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("Gemini 호출 실패")
            return LLMResult(text=f"LLM 오류: {e}", tool_use=None)

        cand = resp.candidates[0] if resp.candidates else None
        text, tool_uses = parse_candidate(cand)
        return LLMResult(text=text, tool_uses=tool_uses)


def run(
    user,
    settings: Settings,
    message: str,
    today: str,
    llm=None,
    registry: SkillRegistry | None = None,
    history: list[dict] | None = None,
) -> Iterator[dict]:
    """ReAct 루프 실행. 이벤트 dict를 순차적으로 yield.

    이벤트: {type: tool_call|tool_result|text|done|error, ...}
    """
    registry = registry or default_registry()
    ctx = SkillContext(user=user, settings=settings, today=today)
    catalog = registry.build_catalog()

    prefs = _user_ai_prefs(user, settings)
    # 모델은 사용자 설정을 따르므로 prefs를 읽은 뒤에 만든다
    llm = llm or GeminiLLM(settings, prefs.get("model", ""))
    system = build_system(user, prefs["tone"], today, prefs.get("calendar"))
    max_steps = max(1, min(16, int(prefs["max_steps"])))

    # 이전 대화(멀티턴): [{role: user|assistant, text}] → genai 형식
    contents: list[dict] = []
    for turn in history or []:
        role = "model" if turn.get("role") == "assistant" else "user"
        text = str(turn.get("text", ""))
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})
    contents.append({"role": "user", "parts": [{"text": message}]})

    final_text = ""

    for step in range(max_steps):
        result = llm.chat(contents, catalog, system)

        calls = result.calls()
        if calls:
            # 모델이 요청한 호출을 모두 실행하고, 호출/응답을 짝지어 한 턴으로 기록한다.
            # Gemini는 function_call 개수와 function_response 개수가 맞기를 기대한다.
            call_parts, response_parts = [], []
            for call in calls:
                name = call["name"]
                # proto Map/Repeated 값을 순수 파이썬으로 정규화 (재전송 직렬화 안전)
                args = _plain(call.get("args", {}))
                yield {"type": "tool_call", "name": name, "args": args}

                skill_result = registry.dispatch(name, args, ctx)
                yield {
                    "type": "tool_result",
                    "name": name,
                    "ok": skill_result.ok,
                    "message": skill_result.message,
                    # 무엇이 바뀌었는지 스킬이 직접 알려준다 → 프런트가 해당 화면만 새로고침
                    "mutates": getattr(registry.get(name), "mutates", "") or "",
                }

                call_parts.append({"function_call": {"name": name, "args": args}})
                response_parts.append(
                    {
                        "function_response": {
                            "name": name,
                            "response": {
                                "ok": skill_result.ok,
                                "message": skill_result.message,
                                "data": skill_result.data,
                            },
                        }
                    }
                )

            # 모델의 호출 + 결과(observation)를 대화에 추가
            contents.append({"role": "model", "parts": call_parts})
            contents.append({"role": "user", "parts": response_parts})
            continue

        final_text = result.text
        break
    else:
        final_text = final_text or "최대 단계에 도달했습니다."

    yield {"type": "text", "text": final_text}
    yield {"type": "done"}


def _user_ai_prefs(user, settings: Settings) -> dict:
    try:
        from .. import user_settings

        loaded = user_settings.load(user, settings)
        ai = loaded.get("ai", {})
        return {
            "tone": ai.get("tone", "assistant"),
            "max_steps": ai.get("max_steps", settings.ai_max_steps),
            "model": str(ai.get("model") or "") or settings.gemini_model,
            "calendar": loaded.get("calendar", {}),
        }
    except Exception:  # noqa: BLE001
        return {"tone": "assistant", "max_steps": settings.ai_max_steps,
                "model": settings.gemini_model, "calendar": {}}


def _plain(obj):
    """proto MapComposite/RepeatedComposite 등을 순수 dict/list로 변환."""
    if isinstance(obj, dict):
        return {k: _plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_plain(v) for v in obj]
    try:
        # MapComposite/RepeatedComposite는 items()/iter 지원
        if hasattr(obj, "items"):
            return {k: _plain(v) for k, v in obj.items()}
    except Exception:  # noqa: BLE001
        pass
    return obj


def sse_format(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
