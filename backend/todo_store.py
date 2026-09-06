"""내부 Todo 저장소 — 사용자별 todo.json (카테고리 + 할 일).

캘린더와 **일부러 분리했다.** 구글과 동기화하지 않는 이 사이트 전용 개념이고,
캘린더 이벤트로 저장하면 구글 계정을 연결한 순간 밖으로 새 나간다.

모델:
  카테고리 {id, name, color, parent_id, order}
    - parent_id 로 한 단계 이상 중첩(폴더처럼). 순환은 만들 수 없다.
  할 일     {id, title, description, category_id, due(ISO|""), all_day,
             color, done, done_at, created_at, updated_at, order}
    - due 가 있으면 캘린더에 함께 보인다. 없으면 Todo 화면에만 있다.
    - color 가 비면 카테고리 색을 따른다(화면에서 해석).

파일 하나에 {categories: [...], todos: [...]} 로 담는다. 캘린더처럼 배열 두 개를
따로 두면 두 파일이 서로 어긋날 수 있고(카테고리는 지웠는데 할 일이 남는 식),
한 번의 원자적 쓰기로 함께 갱신하는 편이 안전하다.
"""
from __future__ import annotations

import time
import uuid
from pathlib import Path

from fastapi import HTTPException

from . import json_store
from .auth import SessionUser
from .config import Settings
from .datetimes import BadDateTime
from .datetimes import has_time as dt_has_time
from .datetimes import to_iso as dt_to_iso

#: 한 사용자가 가질 수 있는 최대 개수. 무한히 쌓이면 조회가 통째로 느려진다.
MAX_TODOS = 5000
MAX_CATEGORIES = 200
#: 카테고리 중첩 깊이 상한(화면이 감당할 수 있는 만큼)
MAX_DEPTH = 5

_DEFAULT_COLOR = "2"


def _path(user: SessionUser, settings: Settings) -> Path:
    base = settings.user_root(user.username) / "todo"
    base.mkdir(parents=True, exist_ok=True)
    return base / "todo.json"


def _blank() -> dict:
    return {"categories": [], "todos": []}


def _load(user: SessionUser, settings: Settings) -> dict:
    # strict: 위 calendar_store 와 같은 이유(깨진 파일을 빈 목록으로 보면 덮어쓴다)
    data = json_store.read_json_strict(_path(user, settings), None)
    if not isinstance(data, dict):
        return _blank()
    cats = data.get("categories")
    todos = data.get("todos")
    return {
        "categories": cats if isinstance(cats, list) else [],
        "todos": todos if isinstance(todos, list) else [],
    }


def _save(data: dict, user: SessionUser, settings: Settings) -> None:
    json_store.write_atomic(_path(user, settings), data)


def _now() -> float:
    return time.time()


# ── 값 정리 ──────────────────────────────────────────────────────────

def _clean_due(value, all_day: bool) -> str:
    """마감 시각을 정규화한다. 빈 값은 '기한 없음'.

    캘린더와 같은 규칙을 쓴다(backend/datetimes) — 여기만 느슨하게 두면
    "todo는 되는데 캘린더에 안 보인다" 같은 어긋남이 생긴다.
    """
    if value in (None, ""):
        return ""
    return dt_to_iso(value, field="마감", date_only=all_day or not dt_has_time(value))


def _clean_color(value, fallback: str = "") -> str:
    s = str(value or "").strip()
    return s if s else fallback


def _norm_todo(payload: dict, existing: dict | None = None) -> dict:
    base = dict(existing or {})
    for k in ("title", "description", "category_id", "color"):
        if k in payload and payload[k] is not None:
            base[k] = str(payload[k])
    if "all_day" in payload and payload["all_day"] is not None:
        base["all_day"] = bool(payload["all_day"])
    if "due" in payload:
        # all_day 를 함께 주지 않았으면 **새 마감에서 판단한다**. 예전 값을 쓰면
        # 종일이던 할 일에 "9월 5일 14시"를 넣었을 때 시각이 조용히 잘렸다.
        raw = payload["due"]
        if "all_day" in payload and payload["all_day"] is not None:
            all_day = bool(payload["all_day"])
        else:
            all_day = bool(raw) and not dt_has_time(raw)
            base["all_day"] = all_day
        base["due"] = _clean_due(raw, all_day)
    if "done" in payload and payload["done"] is not None:
        now_done = bool(payload["done"])
        # 완료 시각은 완료 상태가 '바뀔 때만' 찍는다. 매 수정마다 갱신하면
        # "언제 끝냈나"가 마지막 편집 시각으로 덮인다.
        if now_done != bool(base.get("done")):
            base["done_at"] = _now() if now_done else 0.0
        base["done"] = now_done
    if "order" in payload and payload["order"] is not None:
        try:
            base["order"] = int(payload["order"])
        except (TypeError, ValueError):
            pass
    base["title"] = str(base.get("title", "")).strip() or "(제목 없음)"
    base.setdefault("description", "")
    base.setdefault("category_id", "")
    base.setdefault("color", "")
    base.setdefault("all_day", False)
    base.setdefault("due", "")
    base.setdefault("done", False)
    base.setdefault("done_at", 0.0)
    base.setdefault("order", 0)
    base["updated_at"] = _now()
    return base


# ── 카테고리 ─────────────────────────────────────────────────────────

def _depth_of(cats: list[dict], cid: str) -> int:
    by_id = {c["id"]: c for c in cats}
    depth, seen = 0, set()
    cur = by_id.get(cid)
    while cur and cur.get("parent_id"):
        if cur["id"] in seen:  # 손상된 데이터의 순환 방지
            break
        seen.add(cur["id"])
        cur = by_id.get(cur["parent_id"])
        depth += 1
    return depth


def _subtree_height(cats: list[dict], cid: str) -> int:
    """cid 아래로 몇 단계나 더 있는가(자식이 없으면 0).

    옮기기는 그 밑에 달린 것을 통째로 데려간다 — 옮길 자리의 깊이만 보면
    자손이 상한을 넘어가는 것을 못 잡는다.
    """
    kids: dict[str, list[str]] = {}
    for c in cats:
        kids.setdefault(str(c.get("parent_id") or ""), []).append(str(c.get("id")))
    height, level, seen = 0, [cid], {cid}
    while level:
        nxt = [k for p in level for k in kids.get(p, []) if k not in seen]
        if not nxt:
            break
        seen.update(nxt)
        level = nxt
        height += 1
    return height


def _would_cycle(cats: list[dict], cid: str, new_parent: str) -> bool:
    """new_parent 가 cid 자신이거나 그 자손이면 순환이다."""
    if not new_parent:
        return False
    if new_parent == cid:
        return True
    by_id = {c["id"]: c for c in cats}
    cur = by_id.get(new_parent)
    seen = set()
    while cur:
        if cur["id"] == cid:
            return True
        if cur["id"] in seen:
            return False
        seen.add(cur["id"])
        pid = cur.get("parent_id") or ""
        cur = by_id.get(pid) if pid else None
    return False


def list_categories(user: SessionUser, settings: Settings) -> list[dict]:
    cats = _load(user, settings)["categories"]
    return sorted(cats, key=lambda c: (int(c.get("order", 0)), str(c.get("name", ""))))


def create_category(user: SessionUser, settings: Settings, payload: dict) -> dict:
    name = str(payload.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="카테고리 이름이 필요합니다.")
    parent_id = str(payload.get("parent_id") or "")
    p = _path(user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        cats = data["categories"]
        if len(cats) >= MAX_CATEGORIES:
            raise HTTPException(status_code=409, detail=f"카테고리는 {MAX_CATEGORIES}개까지입니다.")
        if parent_id and not any(c["id"] == parent_id for c in cats):
            raise HTTPException(status_code=404, detail="상위 카테고리를 찾을 수 없습니다.")
        if parent_id and _depth_of(cats, parent_id) + 1 >= MAX_DEPTH:
            raise HTTPException(status_code=409, detail=f"카테고리는 {MAX_DEPTH}단계까지 중첩할 수 있습니다.")
        cat = {
            "id": uuid.uuid4().hex,
            "name": name,
            "color": _clean_color(payload.get("color"), _DEFAULT_COLOR),
            "parent_id": parent_id,
            "order": int(payload.get("order") or len(cats)),
        }
        cats.append(cat)
        _save(data, user, settings)
    return cat


def update_category(user: SessionUser, settings: Settings, cid: str, payload: dict) -> dict:
    p = _path(user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        cats = data["categories"]
        cat = next((c for c in cats if c["id"] == cid), None)
        if cat is None:
            raise HTTPException(status_code=404, detail="카테고리를 찾을 수 없습니다.")
        if payload.get("name") is not None:
            nm = str(payload["name"]).strip()
            if not nm:
                raise HTTPException(status_code=400, detail="카테고리 이름이 비었습니다.")
            cat["name"] = nm
        if payload.get("color") is not None:
            cat["color"] = _clean_color(payload["color"], cat.get("color", _DEFAULT_COLOR))
        if "parent_id" in payload:
            new_parent = str(payload.get("parent_id") or "")
            if new_parent and not any(c["id"] == new_parent for c in cats):
                raise HTTPException(status_code=404, detail="상위 카테고리를 찾을 수 없습니다.")
            # 자기 자신이나 자손 밑으로 넣으면 트리가 끊긴 고리가 되어 화면에서 사라진다
            if _would_cycle(cats, cid, new_parent):
                raise HTTPException(status_code=409, detail="자기 자신이나 하위 카테고리 아래로 옮길 수 없습니다.")
            # 만들 때만 깊이를 봤다. 편집 창에서 상위를 바꿀 수 있게 된 뒤로는
            # 옮기기로도 상한을 넘길 수 있다 — 데려가는 자손까지 함께 센다.
            if new_parent and _depth_of(cats, new_parent) + 1 + _subtree_height(cats, cid) >= MAX_DEPTH:
                raise HTTPException(status_code=409, detail=f"카테고리는 {MAX_DEPTH}단계까지 중첩할 수 있습니다.")
            cat["parent_id"] = new_parent
        if payload.get("order") is not None:
            try:
                cat["order"] = int(payload["order"])
            except (TypeError, ValueError):
                pass
        _save(data, user, settings)
    return cat


def delete_category(user: SessionUser, settings: Settings, cid: str) -> dict:
    """카테고리 삭제. 하위 카테고리와 할 일은 **지우지 않고** 위로 올린다.

    같이 지우면 "카테고리 정리"가 할 일 대량 삭제가 된다. 되돌릴 수단이 없으므로
    보수적으로 간다(할 일 삭제는 명시적으로 요청해야 한다).
    """
    p = _path(user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        cats, todos = data["categories"], data["todos"]
        cat = next((c for c in cats if c["id"] == cid), None)
        if cat is None:
            raise HTTPException(status_code=404, detail="카테고리를 찾을 수 없습니다.")
        parent = cat.get("parent_id", "")
        moved_cats = 0
        for c in cats:
            if c.get("parent_id") == cid:
                c["parent_id"] = parent
                moved_cats += 1
        moved_todos = 0
        for t in todos:
            if t.get("category_id") == cid:
                t["category_id"] = parent
                moved_todos += 1
        data["categories"] = [c for c in cats if c["id"] != cid]
        _save(data, user, settings)
    return {"ok": True, "moved_categories": moved_cats, "moved_todos": moved_todos,
            "moved_to": parent}


# ── 할 일 ────────────────────────────────────────────────────────────

def list_todos(
    user: SessionUser,
    settings: Settings,
    *,
    category_id: str | None = None,
    include_done: bool = True,
    frm: str = "",
    to: str = "",
    include_undated: bool = True,
) -> list[dict]:
    """할 일 목록.

    frm/to 를 주면 **기한이 있는 것만** 그 범위로 거른다(캘린더 표시용).
    include_undated=False 면 기한 없는 것을 아예 뺀다.
    """
    data = _load(user, settings)
    return filter_todos(
        data["todos"],
        category_id=category_id, include_done=include_done,
        frm=frm, to=to, include_undated=include_undated,
        categories=data["categories"],
    )


def filter_todos(
    todos: list[dict],
    *,
    category_id: str | None = None,
    include_done: bool = True,
    frm: str = "",
    to: str = "",
    include_undated: bool = True,
    categories: list[dict] | None = None,
) -> list[dict]:
    """이미 읽어 둔 목록을 거른다(파일을 다시 읽지 않는다).

    board() 로 한 번에 읽은 쪽이 이걸 쓴다.
    """
    # 카테고리를 지정하면 **그 아래 하위 카테고리까지** 포함한다. 화면의 개수는
    # 자손까지 세는데 여기만 정확히 일치를 봐서, AI 의 카테고리 지정 조회·일괄완료·
    # 일괄삭제가 자식 카테고리의 할 일을 통째로 빠뜨렸다.
    wanted: set[str] | None = None
    if category_id is not None:
        wanted = {category_id} | _descendant_ids(categories or [], category_id)

    out = []
    for t in todos:
        if wanted is not None and str(t.get("category_id", "")) not in wanted:
            continue
        if not include_done and t.get("done"):
            continue
        due = str(t.get("due", ""))
        if not due:
            if not include_undated:
                continue
        elif frm or to:
            day = due[:10]
            if frm and day < frm[:10]:
                continue
            if to and day > to[:10]:
                continue
        out.append(t)
    return _sorted(out)


def _descendant_ids(categories: list[dict], root_id: str) -> set[str]:
    """root_id 아래 모든 하위 카테고리 id. 고리가 있어도 멈춘다."""
    if not root_id:
        # 빈 값은 카테고리가 아니라 **미분류**다. 여기서 막지 않으면 아래 kids[""]
        # 가 최상위 카테고리 전부라서, 미분류 조회가 모든 할 일을 돌려준다.
        return set()
    kids: dict[str, list[str]] = {}
    for c in categories:
        kids.setdefault(str(c.get("parent_id") or ""), []).append(str(c.get("id")))
    out: set[str] = set()
    stack = list(kids.get(root_id, []))
    while stack:
        cid = stack.pop()
        if cid in out:
            continue
        out.add(cid)
        stack.extend(kids.get(cid, []))
    return out


def get_todo(user: SessionUser, settings: Settings, tid: str) -> dict | None:
    return next((t for t in _load(user, settings)["todos"] if t["id"] == tid), None)


def create_todo(user: SessionUser, settings: Settings, payload: dict) -> dict:
    p = _path(user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        todos, cats = data["todos"], data["categories"]
        if len(todos) >= MAX_TODOS:
            raise HTTPException(status_code=409, detail=f"할 일은 {MAX_TODOS}개까지입니다.")
        cid = str(payload.get("category_id") or "")
        if cid and not any(c["id"] == cid for c in cats):
            raise HTTPException(status_code=404, detail="카테고리를 찾을 수 없습니다.")
        try:
            todo = _norm_todo(payload)
        except BadDateTime as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        todo["id"] = uuid.uuid4().hex
        todo["created_at"] = _now()
        # len(todos) 로 잡으면 하나라도 지운 뒤 추가할 때 기존 항목과 값이 겹치고,
        # 같은 order 안에서는 제목순으로 밀려 맨 아래가 아닌 중간에 나타난다.
        next_order = max((int(t.get("order", 0) or 0) for t in todos), default=-1) + 1
        todo["order"] = int(payload.get("order") or next_order)
        todos.append(todo)
        _save(data, user, settings)
    return todo


def update_todo(user: SessionUser, settings: Settings, tid: str, payload: dict) -> dict:
    p = _path(user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        todos, cats = data["todos"], data["categories"]
        idx = next((i for i, t in enumerate(todos) if t["id"] == tid), -1)
        if idx < 0:
            raise HTTPException(status_code=404, detail="할 일을 찾을 수 없습니다.")
        if payload.get("category_id"):
            cid = str(payload["category_id"])
            if not any(c["id"] == cid for c in cats):
                raise HTTPException(status_code=404, detail="카테고리를 찾을 수 없습니다.")
        try:
            merged = _norm_todo(payload, todos[idx])
        except BadDateTime as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        merged["id"] = tid
        merged.setdefault("created_at", todos[idx].get("created_at", _now()))
        todos[idx] = merged
        _save(data, user, settings)
    return merged


def delete_todo(user: SessionUser, settings: Settings, tid: str) -> dict:
    """할 일 삭제. **먼저 휴지통에 담고** 지운다.

    반대로 하면(지우고 나서 보관) 보관이 실패했을 때 되돌릴 방법이 없다.
    이 순서면 최악이라도 휴지통에 항목 하나가 더 남을 뿐이고, 그건 눈에 보인다.
    """
    from . import trash

    p = _path(user, settings)
    with json_store.lock_for(p):
        target = next((t for t in _load(user, settings)["todos"] if t["id"] == tid), None)
    if target is None:
        raise HTTPException(status_code=404, detail="할 일을 찾을 수 없습니다.")

    trash.move_todo_to_trash(target, user, settings)

    with json_store.lock_for(p):
        data = _load(user, settings)
        before = len(data["todos"])
        data["todos"] = [t for t in data["todos"] if t["id"] != tid]
        if len(data["todos"]) != before:
            _save(data, user, settings)
    return {"ok": True, "id": tid, "title": target.get("title", "")}


def restore_todo(user: SessionUser, settings: Settings, payload: dict) -> dict:
    """휴지통에서 되돌린다. 원래 id를 그대로 되살린다(캘린더와 달리 우리 것이다).

    같은 id가 이미 있으면(복원 두 번) 새 id로 만든다 — 덮어쓰면 그 사이의 편집이
    사라진다.
    """
    p = _path(user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        todos, cats = data["todos"], data["categories"]
        item = dict(payload)
        tid = str(item.get("id") or "")
        if not tid or any(t["id"] == tid for t in todos):
            tid = uuid.uuid4().hex
        item["id"] = tid
        # 그 사이 카테고리가 사라졌으면 미분류로
        if item.get("category_id") and not any(c["id"] == item["category_id"] for c in cats):
            item["category_id"] = ""
        item.setdefault("created_at", _now())
        item["updated_at"] = _now()
        todos.append(item)
        _save(data, user, settings)
    return item


def board(user: SessionUser, settings: Settings) -> dict:
    """카테고리·할 일·개수를 **파일 한 번 읽어** 함께 돌려준다.

    화면과 AI 스킬이 셋을 따로 부르면 같은 파일을 세 번 읽는다(실측: 할 일
    화면 최초 로드가 todo.json 3회 + accounts.json 3회).
    """
    data = _load(user, settings)
    cats = sorted(data["categories"],
                  key=lambda c: (int(c.get("order", 0)), str(c.get("name", ""))))
    todos = _sorted(data["todos"])
    return {"categories": cats, "todos": todos, "counts": _counts_of(todos)}


def _counts_of(todos: list[dict]) -> dict:
    out: dict[str, dict] = {}
    for t in todos:
        row = out.setdefault(str(t.get("category_id", "")), {"total": 0, "done": 0})
        row["total"] += 1
        if t.get("done"):
            row["done"] += 1
    return out


def _sorted(todos: list[dict]) -> list[dict]:
    """기한 있는 것 먼저(날짜순), 그다음 order·제목."""
    return sorted(todos, key=lambda t: (not t.get("due"), str(t.get("due", "")),
                                        int(t.get("order", 0)), str(t.get("title", ""))))


def counts(user: SessionUser, settings: Settings) -> dict:
    """카테고리별 개수 — 화면의 트리 배지용."""
    return _counts_of(_load(user, settings)["todos"])
