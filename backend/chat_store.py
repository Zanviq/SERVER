"""화면별로 이어지는 AI 대화 기록.

비서 화면의 대화는 브라우저에만 있다(새로고침하면 사라진다). 영어 학습과 논문
화면은 다르다 — "지난주에 물어본 단어", "저 논문에서 했던 질문"이 다음 대화의
맥락이어야 하므로 서버에 남긴다.

한 공간(space) = 파일 하나: {messages: [{id, role, text, ts, meta}]}.
  - 영어 학습:  users/<u>/chats/english.json
  - 논문:       users/<u>/papers/<id>/chat.json  (논문 폴더에 두어 휴지통과 함께 움직인다)

메시지 수는 MAX_MESSAGES 로 자른다(오래된 것부터). 모델에 넣는 것은 그중 최근
일부뿐이고, 나머지는 검색(search)으로 찾는다.
"""
from __future__ import annotations

import time
import uuid
from pathlib import Path

from . import json_store
from .auth import SessionUser
from .config import Settings

MAX_MESSAGES = 600
MAX_TEXT = 20000


def english_path(user: SessionUser, settings: Settings) -> Path:
    base = settings.user_root(user.username) / "chats"
    base.mkdir(parents=True, exist_ok=True)
    return base / "english.json"


def load(path: Path) -> list[dict]:
    data = json_store.read_json_strict(path, None)
    if not isinstance(data, dict):
        return []
    msgs = data.get("messages")
    return [m for m in msgs if isinstance(m, dict)] if isinstance(msgs, list) else []


def _save(path: Path, msgs: list[dict]) -> None:
    # **폴더를 만들지 않는다.** 논문·회의 대화는 그 항목 폴더 안에 있어서, 폴더를
    # 만드는 것이 곧 지워진 항목을 되살리는 것이다(목록에도 휴지통에도 없는 미아가
    # 된다). 고정 공간(영어 학습 등)의 chats/ 는 위 경로 함수들이 미리 만든다.
    json_store.write_atomic(path, {"messages": msgs[-MAX_MESSAGES:]}, create_parents=False)


def message(role: str, text: str, meta: dict | None = None) -> dict:
    return {
        "id": uuid.uuid4().hex,
        "role": "assistant" if role == "assistant" else "user",
        "text": str(text or "")[:MAX_TEXT],
        "ts": time.time(),
        "meta": dict(meta or {}),
    }


def append(path: Path, *msgs: dict) -> list[dict]:
    """메시지를 덧붙이고 전체를 돌려준다."""
    with json_store.lock_for(path):
        cur = load(path)
        cur.extend(m for m in msgs if m)
        _save(path, cur)
    return cur


def clear(path: Path) -> None:
    with json_store.lock_for(path):
        _save(path, [])


def delete_message(path: Path, mid: str) -> bool:
    with json_store.lock_for(path):
        cur = load(path)
        nxt = [m for m in cur if m.get("id") != mid]
        if len(nxt) == len(cur):
            return False
        _save(path, nxt)
    return True


def history_for_llm(msgs: list[dict], *, max_turns: int, max_chars: int) -> list[dict]:
    """모델에 넣을 최근 대화. 라우터의 history 제한과 같은 규칙(턴 수 + 총량)."""
    out: list[dict] = []
    budget = max_chars
    for m in reversed(msgs[-max_turns:]):
        text = str(m.get("text") or "")
        if not text.strip():
            continue
        if budget - len(text) < 0:
            break
        budget -= len(text)
        out.append({"role": m.get("role", "user"), "text": text})
    out.reverse()
    return out


def search(msgs: list[dict], query: str, *, limit: int = 20, window: int = 160) -> list[dict]:
    """대화에서 검색어가 든 메시지를 찾아 앞뒤 조금과 함께 돌려준다."""
    q = str(query or "").strip().lower()
    if not q:
        return []
    hits = []
    for m in msgs:
        text = str(m.get("text") or "")
        i = text.lower().find(q)
        if i < 0:
            continue
        start = max(0, i - window)
        end = min(len(text), i + len(q) + window)
        hits.append({
            "id": m.get("id", ""),
            "role": m.get("role", ""),
            "ts": m.get("ts", 0),
            "snippet": ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else ""),
        })
    return hits[-limit:]
