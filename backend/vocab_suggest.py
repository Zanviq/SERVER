"""답에서 단어장 후보를 뽑는다 — 모델이 잊었을 때 서버가 채운다.

논문·영어 화면의 프롬프트는 이렇게 약속한다:

  "사용자가 영어 단어·문장·문법을 물으면(예: '이 문장 무슨 뜻이야',
   'degrade 설명해줘') 답한 뒤 propose_vocab_words 로 어려운 것들을 후보로
   올려 '단어장에 넣을까요?' 하세요."

그런데 실측하면 **6번 중 2번만** 올렸다. "이 문장 무슨 뜻이야"는 프롬프트에 적힌
바로 그 예시인데도 0/2 였다. 답은 잘 하고 그 다음 한 걸음을 잊는다 — 부탁으로
고쳐지지 않는 종류다(30·47·60·71·90차와 같은 자리).

그래서 서버가 보장한다. 조건이 맞는데 모델이 후보를 안 올렸으면, **작은 호출
하나**로 답에서 후보를 뽑아 화면에 올린다. 스킬 목록도 대화 기록도 싣지 않으므로
본 대화(논문 화면은 9~15k 토큰)보다 훨씬 싸다.

뽑기만 하고 **저장하지 않는다.** 고르는 것은 사용자다(71차 규칙).
"""
from __future__ import annotations

import json
import logging
import re

from .config import Settings

logger = logging.getLogger("server.vocab")

#: 이 화면들에서만 채운다. 캘린더·비서 화면은 단어장과 상관이 없다.
MODES = ("paper", "english")

#: "이게 무슨 뜻이야" 류의 물음인가. 답에 나온 어려운 말을 후보로 올릴 자리다.
#: 넓게 잡아도 손해가 적다 — 후보는 **올릴 뿐 저장하지 않는다**.
_ASKS_MEANING = re.compile(
    r"뜻|의미|무슨 말|해석|설명|정의|번역|풀이|무엇인가|뭐야|뭔가요|알려\s?줘"
    r"|\bmean\b|\bmeaning\b|explain|translate|definition",
    re.I,
)

#: 답이 이보다 짧으면 뽑을 것이 없다고 본다(인사·되묻기).
MIN_ANSWER_CHARS = 40
#: 한 번에 올리는 후보 수
MAX_SUGGEST = 6

_PROMPT = """You are picking study-notebook candidates from an assistant's answer.

아래는 사용자가 물었고 비서가 답한 내용이다. 그 답에서 **사용자가 단어장에 넣어
둘 만한 것**을 고르라 — 어려운 낱말·숙어·문장·문법 항목·전문 용어.

규칙:
- 답에서 실제로 다룬 것만 고른다. 새로 지어내지 않는다.
- 전문 용어·개념·약어도 넣는다(영어가 아니어도 된다). kind=term.
- 사용자가 물어본 바로 그 말이 있으면 반드시 넣는다.
- 너무 쉬운 낱말(the, is, 그리고)은 넣지 않는다.
- 고를 것이 없으면 빈 목록을 준다.

형식(JSON 객체 하나, 산문·코드펜스 없이):
{"words": [{"word": "표제어", "kind": "word|phrase|sentence|grammar|term",
            "pos": "품사(없으면 빈 문자열)", "meaning": "한국어 뜻 한 줄"}]}"""


def should_suggest(mode: str, user_message: str, answer: str, already: bool) -> bool:
    """서버가 후보를 채워야 하는 자리인가."""
    if already or mode not in MODES:
        return False
    if len((answer or "").strip()) < MIN_ANSWER_CHARS:
        return False
    return bool(_ASKS_MEANING.search(user_message or ""))


def _parse(text: str) -> list[dict]:
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip(), flags=re.I)
    try:
        obj = json.loads(s)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", s, flags=re.S)
        if not m:
            return []
        try:
            obj = json.loads(m.group(0))
        except json.JSONDecodeError:
            return []
    words = obj.get("words") if isinstance(obj, dict) else None
    return [w for w in words if isinstance(w, dict) and str(w.get("word") or "").strip()] \
        if isinstance(words, list) else []


def _ask(settings: Settings, payload: str, model: str) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=settings.gemini_api_key)
    resp = client.models.generate_content(
        model=model or settings.gemini_model,
        contents=[types.Content(role="user", parts=[
            types.Part.from_text(text=_PROMPT),
            types.Part.from_text(text=payload),
        ])],
        config=types.GenerateContentConfig(response_mime_type="application/json"),
    )
    return getattr(resp, "text", "") or ""


def suggest(settings: Settings, user_message: str, answer: str, *,
            model: str = "", asker=None) -> list[dict]:
    """답에서 후보를 뽑는다. 실패하면 빈 목록 — 대화를 막지 않는다."""
    if not settings.gemini_api_key and asker is None:
        return []
    payload = f"[사용자]\n{user_message[:2000]}\n\n[비서의 답]\n{answer[:6000]}"
    try:
        raw = (asker or _ask)(settings, payload, model)
    except Exception:  # noqa: BLE001
        logger.debug("후보 뽑기 실패", exc_info=True)
        return []
    out = []
    seen: set[str] = set()
    from . import vocab_store

    for w in _parse(raw)[:MAX_SUGGEST * 2]:
        head = str(w.get("word") or "").strip()
        key = head.lower()
        if not head or key in seen:
            continue
        seen.add(key)
        kind = str(w.get("kind") or "").strip().lower()
        out.append({
            "word": head[:vocab_store.MAX_WORD],
            "kind": kind if kind in vocab_store.KINDS else vocab_store.guess_kind(head),
            "pos": str(w.get("pos") or "")[:60],
            "meaning": str(w.get("meaning") or "")[:200],
        })
        if len(out) >= MAX_SUGGEST:
            break
    return out
