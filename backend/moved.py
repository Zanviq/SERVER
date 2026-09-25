"""이름을 바꾸거나 옮긴 문서의 **옛 자리 → 새 자리** — 옛 링크가 새 자리를 찾아가게.

문서 속 `[[제목]]`·`[note/경로]` 는 적어 둔 그대로 남는다. 이름을 바꾸면 그 링크는 아무
데도 가지 않았고("찾지 못한 링크"), `[[옛이름]]` 을 누르면 **빈 옛이름 문서가 새로
생겼다** — 위키링크는 없는 제목이면 만들기 때문이다. 내용은 새 이름에 있는데(10차 실측).

남의 문서를 몰래 고쳐 쓰지 않는다. 링크를 다시 적는 대신 이 기록을 따라간다 — 옛 링크를
누르면 새 자리가 열리고 "이름이 바뀐 문서"라고 알린다.

기록은 사용자 자료가 아니라 길잡이다. 망가지면 빈 것으로 보고(따라가지 못할 뿐) 새로 쓴다.
"""
from __future__ import annotations

import time
from collections.abc import Callable

from . import json_store
from .auth import SessionUser
from .config import Settings
from .file_kinds import doc_title

#: 기억해 둘 옮김 수. 넘으면 오래된 것부터 잊는다.
MAX_ENTRIES = 1000


def _path(user: SessionUser, settings: Settings):
    # 문서 루트(data) 밖 — 문서 목록에 나오지 않는다
    return settings.user_root(user.username) / "moved.json"


def _rows(user: SessionUser, settings: Settings) -> list[dict]:
    rows = json_store.read_json(_path(user, settings), [])
    return [r for r in rows if isinstance(r, dict) and isinstance(r.get("from"), str)
            and isinstance(r.get("to"), str)] if isinstance(rows, list) else []


def record(user: SessionUser, settings: Settings, old_rel: str, new_rel: str,
           *, folder: bool = False) -> None:
    """old_rel 이 new_rel 로 갔다. 폴더면 그 아래 전부가 함께 간 것으로 본다."""
    old, new = old_rel.strip("/"), new_rel.strip("/")
    if not old or not new or old == new:
        return
    if folder:
        old, new = old + "/", new + "/"
    path = _path(user, settings)
    with json_store.lock_for(path):
        rows = [r for r in _rows(user, settings) if r["from"] != old]
        rows.append({"from": old, "to": new, "at": time.time()})
        json_store.write_atomic(path, rows[-MAX_ENTRIES:])


def _apply(r: dict, rel: str) -> str | None:
    """옮김 하나가 rel 에 닿으면 옮겨 간 자리. 폴더 옮김은 그 아래 전부에 닿는다."""
    f, t = r["from"], r["to"]
    if f.endswith("/"):
        return t + rel[len(f):] if rel.startswith(f) else None
    return t if rel == f else None


def follow(user: SessionUser, settings: Settings, rel: str,
           exists: Callable[[str], bool]) -> str | None:
    """rel 이 옮겨 갔으면 **지금 있는** 자리. 모르거나 끝내 없으면 None.

    옮김을 **일어난 차례대로** 다시 밟는다. 최신 것부터 보면 "폴더 안에서 이름을 바꾸고
    나서 폴더 이름을 바꾼" 경우에 폴더 규칙이 먼저 걸려 옛 파일 이름을 새 폴더에서 찾고
    끝났다(시험이 잡았다).

    다만 **어디서부터** 밟을지는 가장 최근의 것부터 고른다(46차). 같은 자리에는 시간에 따라
    다른 문서가 살 수 있다 — 폴더 X 를 Y 로 옮긴 뒤 새로 X 를 만들고 그 안의 B 를 B2 로 바꾸면,
    처음부터 밟은 예전 방식은 먼저 "X/ → Y/" 를 적용해 Y/B 로 가 버리고 방금의 "X/B → X/B2" 는
    닿지 못해 링크가 죽었다(실측: 이름 한 번 바꾼 문서의 링크가 "찾지 못한 링크"). 링크는 대개
    그 자리의 **가장 최근** 문서를 가리키므로, rel 에 직접 닿는 옮김 중 최근 것부터 거기서 끝까지
    밟아 보고, 지금 있는 자리에 닿으면 그것을 준다.
    """
    return follow_rows(_rows(user, settings), rel, exists)


def follow_rows(rows: list[dict], rel: str, exists: Callable[[str], bool]) -> str | None:
    """follow 의 알맹이 — 기록을 이미 읽어 둔 쪽(여러 경로를 한꺼번에 따라가는 그래프)이 쓴다.
    규칙과 그 까닭은 follow 에 있다."""
    start = rel.strip("/")
    for s in range(len(rows) - 1, -1, -1):
        if _apply(rows[s], start) in (None, start):
            continue  # 이 옮김은 rel 에 닿지 않는다 — 여기서 시작할 까닭이 없다
        cur = start
        for r in rows[s:]:
            nxt = _apply(r, cur)
            if nxt is not None:
                cur = nxt
        if cur != start and exists(cur):
            return cur
    return None


def follow_title(user: SessionUser, settings: Settings, title: str,
                 exists: Callable[[str], bool]) -> str | None:
    """`[[옛제목]]` — 옛 이름의 제목이 title 인 문서가 지금 있는 자리. 하나로 정해질 때만.

    위키링크는 제목(확장자 뺀 이름)으로 찾고 대소문자를 가리지 않는다(그래프와 같은 규칙).
    옛 제목이 같은 문서가 둘 이상 옮겨 갔으면 고르지 않는다 — 엉뚱한 것을 여느니 만든다.
    """
    want = title.strip().lower()
    olds = {r["from"] for r in _rows(user, settings)
            if not r["from"].endswith("/") and doc_title(r["from"]).lower() == want}
    found = {x for x in (follow(user, settings, o, exists) for o in olds) if x}
    return found.pop() if len(found) == 1 else None
