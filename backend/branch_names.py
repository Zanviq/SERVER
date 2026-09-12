"""가지에 이름을 붙인다 — 지도에서 "이 갈래가 무슨 이야기였지"를 알 수 있게.

노드에 적히는 것은 기본적으로 **질문의 앞 18자**다. 그런데 갈라지는 자리의 질문은
"1번 더 자세히", "그럼 두 번째 방법은?" 처럼 앞말에 기대는 짧은 말인 경우가 많다.
지도에서 그것만 보면 어느 갈래가 무슨 이야기였는지 알 수 없다 — 정작 갈래가 여럿일
때 가장 알고 싶은 것이 그것인데.

그래서 **갈라지는 자리의 가지에만** 이름을 붙인다. 형제가 하나뿐인 차례는 지도에서
줄줄이 이어질 뿐이라 이름이 필요 없다.

값이 싸야 자주 쓸 수 있으므로, 스킬 목록도 시스템 프롬프트도 싣지 않고 한 번에
모아서 묻는다(vocab_suggest 와 같은 자리).
"""
from __future__ import annotations

import json
import logging
import re

from .config import Settings

logger = logging.getLogger("server.ai.branches")

#: 한 번에 이름 지을 가지 수. 넘으면 나눠 부르지 않고 앞에서 자른다 —
#: 지도를 열 때마다 조금씩 채워지면 된다(못 채운 것은 원래대로 질문 앞부분이 보인다).
MAX_AT_ONCE = 24
#: 이름 길이. 노드 폭에 들어가야 한다.
MAX_NAME = 18
#: 가지가 무슨 이야기였는지 알려면 그 아래 몇 차례는 봐야 한다.
LOOK_AHEAD = 4
MAX_CHARS_PER_BRANCH = 700

_PROMPT = f"""대화의 갈래마다 **무슨 이야기인지** 짧은 이름을 붙여라.

각 갈래는 같은 자리에서 갈라져 나온 것이라, 이름이 서로 **구별되어야** 쓸모가 있다.
"자세한 설명", "추가 질문" 처럼 어느 갈래에나 맞는 말은 쓰지 마라.

규칙:
- 한국어 명사구로 {MAX_NAME}자 이내. 마침표·따옴표 없이.
- 그 갈래에서 실제로 다룬 **내용**을 적는다(예: "역전파 수식 유도", "논문 3장 실험 설계").
- 답은 JSON 객체 하나: {{"names": {{"<id>": "<이름>"}}}}. 산문도 코드펜스도 붙이지 않는다.
- 준 id 만 쓴다. 모르겠으면 그 id 는 빼라(지어내지 마라)."""


def _label(text: str, limit: int = MAX_NAME) -> str:
    one = re.sub(r"\s+", " ", str(text or "")).strip().strip("\"'`")
    return one[:limit]


def branch_starts(msgs: list[dict]) -> list[dict]:
    """갈라지는 자리의 가지들 — 이름이 필요한 것만.

    형제가 둘 이상인 **사용자 메시지**가 한 가지의 시작이다. 이미 이름이 있으면
    건너뛴다(지도를 열 때마다 다시 부르면 안 된다).
    """
    kids: dict[str, list[dict]] = {}
    for m in msgs:
        kids.setdefault(str(m.get("parent") or ""), []).append(m)
    out = []
    for group in kids.values():
        users = [m for m in group if m.get("role") == "user"]
        if len(users) < 2:
            continue
        for m in users:
            if not str((m.get("meta") or {}).get("branch_name") or "").strip():
                out.append(m)
    return out[:MAX_AT_ONCE]


def _walk_down(msgs: list[dict], start: str) -> list[dict]:
    """이 가지에서 아래로 몇 차례 — 이름을 지으려면 내용이 있어야 한다."""
    kids: dict[str, list[dict]] = {}
    for m in msgs:
        kids.setdefault(str(m.get("parent") or ""), []).append(m)
    by_id = {m.get("id"): m for m in msgs}
    out, cur, seen = [], start, set()
    while cur and cur not in seen and len(out) < LOOK_AHEAD * 2:
        seen.add(cur)
        m = by_id.get(cur)
        if not m:
            break
        out.append(m)
        nxt = kids.get(cur) or []
        if not nxt:
            break
        cur = nxt[0].get("id", "")
    return out


def payload_for(msgs: list[dict], starts: list[dict]) -> str:
    blocks = []
    for s in starts:
        budget = MAX_CHARS_PER_BRANCH
        lines = []
        for m in _walk_down(msgs, str(s.get("id") or "")):
            text = str(m.get("text") or "").strip()
            if not text:
                continue
            text = text[:budget]
            budget -= len(text)
            lines.append(f"[{'사용자' if m.get('role') == 'user' else 'AI'}] {text}")
            if budget <= 0:
                break
        blocks.append(f"<갈래 id={s.get('id')}>\n" + "\n".join(lines))
    return "\n\n".join(blocks)


def _ask(settings: Settings, payload: str, model: str = "") -> dict:
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
    raw = (getattr(resp, "text", "") or "").strip()
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.I)
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, flags=re.S)
        if not m:
            return {}
        try:
            obj = json.loads(m.group(0))
        except json.JSONDecodeError:
            return {}
    return obj if isinstance(obj, dict) else {}


def name_branches(settings: Settings, msgs: list[dict], *, model: str = "",
                  asker=None) -> dict[str, str]:
    """갈라지는 자리의 가지에 이름을 붙인다. {메시지 id: 이름}.

    실패해도 조용히 빈 것을 돌려준다 — 이름이 없으면 원래대로 질문 앞부분이
    보일 뿐이고, 그것 때문에 지도를 못 열면 손해가 더 크다.
    """
    starts = branch_starts(msgs)
    if not starts or not settings.gemini_api_key:
        return {}
    try:
        raw = (asker or _ask)(settings, payload_for(msgs, starts), model)
    except Exception:  # noqa: BLE001
        logger.exception("가지 이름 짓기 실패")
        return {}
    names = raw.get("names") if isinstance(raw, dict) else None
    if not isinstance(names, dict):
        return {}
    want = {str(s.get("id")) for s in starts}
    out = {}
    for k, v in names.items():
        # 모델이 안 준 id 를 얹어 오면 버린다 — 엉뚱한 노드에 이름이 붙는다
        if str(k) in want and _label(v):
            out[str(k)] = _label(v)
    return out
