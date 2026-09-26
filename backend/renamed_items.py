"""이름(제목)을 바꾼 항목의 **옛 이름 → id** — 옛 링크가 새 이름을 찾아가게(57차).

할 일·회의·논문·단어·일정의 링크는 `[todo/분류/제목]` 처럼 **이름**으로 적힌다(사람이 읽고 칠 수 있게).
그래서 제목을 바꾸면 그 항목을 가리키던 링크가 모두 "찾지 못한 링크"가 됐다(실측: 할 일·회의 모두).
문서는 옮김 기록(moved.py)으로 이미 따라가는데 나머지 갈래에는 그런 것이 없었다.

남의 글 속 링크를 몰래 고쳐 쓰지 않는다는 규칙은 같다 — 대신 바꿀 때 옛 이름과 id 를 적어 두고,
링크가 지금 이름과 맞지 않으면 여기서 id 를 찾아 지금의 그 항목을 연다(links.resolve).

옛 이름은 **바꾼 그대로**(날것) 둔다. 링크 경로의 모양(`/`→`_`, 대괄호 escape)으로 맞대는 일은 links 가
한다 — 저장소들이 links 를 불러오지 않게(links 가 저장소들을 불러온다).
기록은 사용자 자료가 아니라 길잡이다. 망가지면 빈 것으로 본다.
"""
from __future__ import annotations

import time

from . import json_store
from .auth import SessionUser
from .config import Settings

#: 기억해 둘 이름 바꾸기 수. 넘으면 오래된 것부터 잊는다.
MAX_ENTRIES = 2000


def _path(user: SessionUser, settings: Settings):
    # 문서 루트(data) 밖 — 문서 목록에 나오지 않는다(moved.json 옆)
    return settings.user_root(user.username) / "renamed_items.json"


def rows(user: SessionUser, settings: Settings) -> list[dict]:
    """기록 전부(오래된 것부터). 모양이 틀린 줄은 버린다."""
    got = json_store.read_json(_path(user, settings), [])
    if not isinstance(got, list):
        return []
    return [r for r in got if isinstance(r, dict) and all(isinstance(r.get(k), str) for k in ("kind", "title", "id"))]


def record(user: SessionUser, settings: Settings, kind: str, ident: str, old_title: str, new_title: str) -> None:
    """kind 의 ident 항목이 old_title → new_title 로 이름을 바꿨다. 같으면 아무것도 적지 않는다."""
    old, new = str(old_title or "").strip(), str(new_title or "").strip()
    if not ident or not old or old == new:
        return
    path = _path(user, settings)
    with json_store.lock_for(path):
        kept = [r for r in rows(user, settings)
                if not (r["kind"] == kind and r["title"] == old and r["id"] == ident)]
        kept.append({"kind": kind, "title": old, "id": str(ident), "at": time.time()})
        json_store.write_atomic(path, kept[-MAX_ENTRIES:])
