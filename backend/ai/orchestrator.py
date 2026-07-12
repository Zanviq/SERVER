"""ReAct 오케스트레이터 — 스킬을 연속 실행하며 추론.

LLM이 function_call(스킬 호출)을 내면 디스패치하고 결과(observation)를
대화에 추가해 다음 스텝으로 넘긴다. 텍스트 응답이 나오면 종료.
LLM 객체는 주입 가능(테스트에서 가짜 LLM 사용).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Iterator

from ..config import Settings
from .prompt_builder import build_system
from .skill_base import SkillContext
from .skill_registry import SkillRegistry, default_registry

logger = logging.getLogger("server.ai")


@dataclass
class LLMResult:
    text: str
    tool_use: dict | None  # {"name": str, "args": dict}


class GeminiLLM:
    """google-genai(신 SDK) 기반 function-calling LLM."""

    def __init__(self, settings: Settings):
        self._settings = settings

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
                model=self._settings.gemini_model, contents=contents, config=config
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("Gemini 호출 실패")
            return LLMResult(text=f"LLM 오류: {e}", tool_use=None)

        text, tool_use = "", None
        cand = resp.candidates[0] if resp.candidates else None
        if cand and cand.content and cand.content.parts:
            for part in cand.content.parts:
                fc = getattr(part, "function_call", None)
                if fc and fc.name:
                    tool_use = {"name": fc.name, "args": dict(fc.args) if fc.args else {}}
                    break
                if getattr(part, "text", ""):
                    text += part.text
        return LLMResult(text=text, tool_use=tool_use)


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
    llm = llm or GeminiLLM(settings)
    ctx = SkillContext(user=user, settings=settings, today=today)
    catalog = registry.build_catalog()

    prefs = _user_ai_prefs(user, settings)
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

        if result.tool_use:
            name = result.tool_use["name"]
            # proto Map/Repeated 값을 순수 파이썬으로 정규화 (재전송 직렬화 안전)
            args = _plain(result.tool_use.get("args", {}))
            yield {"type": "tool_call", "name": name, "args": args}

            skill_result = registry.dispatch(name, args, ctx)
            yield {
                "type": "tool_result",
                "name": name,
                "ok": skill_result.ok,
                "message": skill_result.message,
            }

            # 모델의 호출 + 결과(observation)를 대화에 추가
            contents.append({"role": "model", "parts": [{"function_call": {"name": name, "args": args}}]})
            contents.append(
                {
                    "role": "user",
                    "parts": [
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
                    ],
                }
            )
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
            "calendar": loaded.get("calendar", {}),
        }
    except Exception:  # noqa: BLE001
        return {"tone": "assistant", "max_steps": settings.ai_max_steps, "calendar": {}}


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
