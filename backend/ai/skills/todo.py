"""할 일(Todo) 스킬 — 조회·생성·수정·완료·삭제, 카테고리까지.

캘린더와 별개의 저장소다(구글 동기화 없음). 비서가 "할 일"과 "일정"을 헷갈리면
사용자가 기대한 곳과 다른 데에 쌓이므로, 설명에서 둘의 차이를 분명히 한다.

계약(이 저장소가 반복해서 깨뜨렸던 지점):
- 조회가 준 id를 수정·완료·삭제에 **그대로** 넘길 수 있어야 한다.
- 카테고리는 이름으로도 지목할 수 있게 한다 — 모델은 id를 기억하지 못하고,
  매번 목록을 다시 부르면 단계를 낭비한다. 이름이 여러 개면 고르라고 되묻는다.
- 실패는 분류(error_code)를 붙인다. 목록을 다시 부를지 포기할지 모델이 판단한다.
"""
from __future__ import annotations

from fastapi import HTTPException

from ... import todo_store
from ...calendar_colors import COLOR_NAMES, resolve_color
from ...datetimes import BadDateTime
from ...datetimes import has_time as dt_has_time
from ...datetimes import to_iso as dt_to_iso
from ..skill_base import SkillBase, SkillResult

#: 한 번에 모델에게 보여줄 개수 상한(컨텍스트를 다 먹지 않도록)
_MAX_ROWS = 200


def _fail(e: Exception) -> SkillResult:
    """서비스 예외를 분류해 돌려준다(스킬이 삼켜서 'error'로 뭉개지 않도록)."""
    status = int(getattr(e, "status_code", 0) or 0)
    code = {400: "invalid", 403: "forbidden", 404: "not_found",
            409: "conflict", 410: "gone"}.get(status, "error")
    return SkillResult(ok=False, message=str(getattr(e, "detail", e)), error_code=code)


def _path_map(cats: list[dict]) -> dict[str, str]:
    """카테고리 id → '상위/하위' 경로. **한 번에 전부 만든다.**

    예전에는 줄마다 _cat_path 를 불렀고 그 안에서 매번 id 색인을 새로 만들었다
    (할 일 n개 × 카테고리 m개 = O(n·m)).
    """
    by_id = {c["id"]: c for c in cats}
    out: dict[str, str] = {}

    def path_of(cid: str, seen: frozenset) -> str:
        if cid in out:
            return out[cid]
        cur = by_id.get(cid)
        if cur is None or cid in seen:
            return ""
        parent = str(cur.get("parent_id") or "")
        prefix = path_of(parent, seen | {cid}) if parent else ""
        val = f"{prefix}/{cur['name']}" if prefix else str(cur["name"])
        out[cid] = val
        return val

    for c in cats:
        path_of(c["id"], frozenset())
    return out


def _cat_path(cats: list[dict], cid: str) -> str:
    """단건용. 목록을 만들 때는 _path_map 을 써라."""
    return _path_map(cats).get(cid, "")


def _row(t: dict, paths: dict[str, str]) -> dict:
    cid = str(t.get("category_id", ""))
    return {
        "id": t["id"],
        "title": t.get("title", ""),
        "done": bool(t.get("done")),
        "due": str(t.get("due", "")),
        "all_day": bool(t.get("all_day")),
        "category_id": cid,
        "category": paths.get(cid, ""),
        "color": str(t.get("color", "")),
        "description": t.get("description", ""),
    }


class _Ambiguous(Exception):
    def __init__(self, name: str, hits: list[dict]):
        self.name = name
        self.hits = hits


def _resolve_category(cats: list[dict], ident: str) -> str:
    """id 또는 이름(또는 '상위/하위' 경로) → 카테고리 id. 없으면 ''(미분류)."""
    ident = str(ident or "").strip()
    if not ident:
        return ""
    if any(c["id"] == ident for c in cats):
        return ident
    low = ident.lower()
    paths = _path_map(cats)
    # 경로로 지정한 경우가 가장 정확하다
    exact_path = [c for c in cats if paths[c["id"]].lower() == low]
    if len(exact_path) == 1:
        return exact_path[0]["id"]
    hits = [c for c in cats if str(c.get("name", "")).lower() == low]
    if len(hits) == 1:
        return hits[0]["id"]
    if len(hits) > 1:
        raise _Ambiguous(ident, hits)
    part = [c for c in cats if low in str(c.get("name", "")).lower()]
    if len(part) == 1:
        return part[0]["id"]
    if len(part) > 1:
        raise _Ambiguous(ident, part)
    raise HTTPException(status_code=404, detail=f"'{ident}' 카테고리를 찾을 수 없습니다.")


def _ambiguous_result(cats: list[dict], e: _Ambiguous) -> SkillResult:
    paths = _path_map(cats)
    names = [{"id": c["id"], "category": paths.get(c["id"], "")} for c in e.hits]
    return SkillResult(
        ok=False, error_code="ambiguous",
        message=(f"'{e.name}'에 해당하는 카테고리가 여러 개입니다. "
                 "어느 것인지 골라 주세요(id를 그대로 쓰면 됩니다)."),
        data={"candidates": names},
    )


class _Stop(Exception):
    """바로 돌려줄 결과가 정해졌을 때(카테고리 해석 실패·모호)."""

    def __init__(self, result: SkillResult):
        self.result = result


def _need_category(cats: list[dict], ident) -> str:
    """카테고리 지목을 id로 바꾼다. 실패하면 _Stop 으로 결과를 던진다.

    이 try/except 짝이 여섯 군데에 복붙돼 있었다 — 한 곳만 고치면 나머지가
    조용히 다르게 동작한다(이 저장소에서 이미 두 번 겪은 패턴이다).
    """
    try:
        return _resolve_category(cats, ident)
    except _Ambiguous as e:
        raise _Stop(_ambiguous_result(cats, e)) from e
    except HTTPException as e:
        raise _Stop(_fail(e)) from e


_CAT_PROP = {
    "type": "string",
    "description": "카테고리 id 또는 이름('상위/하위' 경로도 가능). 생략하면 미분류.",
}


class ListTodos(SkillBase):
    name = "list_todos"
    description = (
        "할 일 목록을 본다. 할 일은 캘린더 일정과 다른 저장소다 — "
        "'해야 할 것/체크리스트'는 여기, '몇 시에 어디서'는 일정이다. "
        "여기서 얻은 id를 update_todo·complete_todo·delete_todo에 그대로 넘기면 된다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "category": _CAT_PROP,
            "include_done": {"type": "boolean", "description": "완료한 것도 볼지(기본 true)."},
            "only_done": {"type": "boolean", "description": "완료한 것만 본다."},
            "from_date": {"type": "string", "description": "마감 시작일 YYYY-MM-DD"},
            "to_date": {"type": "string", "description": "마감 종료일 YYYY-MM-DD(포함)"},
            "include_undated": {"type": "boolean", "description": "기한 없는 것도 볼지(기본 true)."},
            "title_contains": {"type": "string", "description": "제목에 이 말이 든 것만."},
        },
    }

    def run(self, args, ctx):
        try:
            # 카테고리와 할 일을 따로 부르면 같은 파일을 두 번 읽는다
            loaded = todo_store.board(ctx.user, ctx.settings)
            cats = loaded["categories"]
            cid = None
            if args.get("category"):
                cid = _need_category(cats, args["category"])
            try:
                frm = dt_to_iso(args["from_date"], field="from_date", date_only=True) if args.get("from_date") else ""
                to = dt_to_iso(args["to_date"], field="to_date", date_only=True) if args.get("to_date") else ""
            except BadDateTime as e:
                return SkillResult(ok=False, message=str(e), error_code="invalid")

            items = todo_store.filter_todos(
                loaded["todos"],
                category_id=cid,
                include_done=bool(args.get("include_done", True)),
                frm=frm, to=to,
                include_undated=bool(args.get("include_undated", True)),
            )
            if args.get("only_done"):
                items = [t for t in items if t.get("done")]
            needle = str(args.get("title_contains") or "").strip().lower()
            if needle:
                items = [t for t in items if needle in str(t.get("title", "")).lower()]

            total = len(items)
            paths = _path_map(cats)
            rows = [_row(t, paths) for t in items[:_MAX_ROWS]]
            left = sum(1 for t in items if not t.get("done"))
            msg = f"할 일 {total}개(남은 것 {left}개)"
            data: dict = {"todos": rows, "count": total, "remaining": left}
            if total > _MAX_ROWS:
                data["truncated"] = True
                msg += f" — {_MAX_ROWS}개만 표시(카테고리·기간으로 좁히세요)"
            if not total:
                # 왜 없는지 알려 준다 — "없습니다"로 끝내면 다음 수를 모른다
                data["categories"] = [
                    {"id": c["id"], "category": paths.get(c["id"], "")} for c in cats
                ]
            return SkillResult(ok=True, message=msg, data=data)


        except _Stop as stop:
            return stop.result
class ListTodoCategories(SkillBase):
    name = "list_todo_categories"
    description = "할 일 카테고리 목록(트리). 여기서 얻은 id나 이름을 다른 할 일 스킬에 쓴다."
    parameters = {"type": "object", "properties": {}}

    def run(self, args, ctx):
        # 카테고리와 개수를 따로 부르면 같은 파일을 두 번 읽는다
        data = todo_store.board(ctx.user, ctx.settings)
        cats, cnt = data["categories"], data["counts"]
        paths = _path_map(cats)
        rows = [{
            "id": c["id"],
            "name": c["name"],
            "category": paths.get(c["id"], ""),
            "parent_id": c.get("parent_id", ""),
            "color": c.get("color", ""),
            "total": cnt.get(c["id"], {}).get("total", 0),
            "done": cnt.get(c["id"], {}).get("done", 0),
        } for c in cats]
        un = cnt.get("", {})
        return SkillResult(
            ok=True,
            message=f"카테고리 {len(rows)}개" + (f", 미분류 {un.get('total', 0)}개" if un else ""),
            data={"categories": rows, "uncategorized": un},
        )


class CreateTodoCategory(SkillBase):
    mutates = "todo"
    name = "create_todo_category"
    description = "할 일 카테고리를 만든다. parent로 상위 카테고리 아래에 넣을 수 있다."
    parameters = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "parent": _CAT_PROP,
            "color": {"type": "string", "description": "색 이름(보라 등) 또는 colorId 1~11"},
        },
        "required": ["name"],
    }

    def run(self, args, ctx):
        try:
            cats = todo_store.list_categories(ctx.user, ctx.settings)
            parent = ""
            if args.get("parent"):
                parent = _need_category(cats, args["parent"])
            payload = {"name": args["name"], "parent_id": parent}
            if args.get("color"):
                payload["color"] = resolve_color(args["color"], "2")
            try:
                cat = todo_store.create_category(ctx.user, ctx.settings, payload)
            except HTTPException as e:
                return _fail(e)
            fresh = todo_store.list_categories(ctx.user, ctx.settings)
            return SkillResult(
                ok=True,
                message=f"카테고리 '{_cat_path(fresh, cat['id'])}' 생성됨",
                data={"category_id": cat["id"], "category": _cat_path(fresh, cat["id"])},
            )


        except _Stop as stop:
            return stop.result
class CreateTodo(SkillBase):
    mutates = "todo"
    name = "create_todo"
    description = (
        "할 일을 만든다. 마감(due)을 주면 캘린더에도 함께 보인다. "
        "'장을 봐야 한다', '보고서 마무리' 같은 것은 할 일이고, "
        "'3시에 회의' 처럼 시각이 정해진 약속은 create_calendar_event를 쓴다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "description": {"type": "string"},
            "category": _CAT_PROP,
            "due": {"type": "string", "description": "마감 YYYY-MM-DD 또는 YYYY-MM-DDTHH:MM:SS. 없으면 기한 없음."},
            "all_day": {"type": "boolean", "description": "날짜만 있는 마감이면 true."},
            "color": {"type": "string", "description": "색 이름 또는 colorId. 생략하면 카테고리 색."},
        },
        "required": ["title"],
    }

    def run(self, args, ctx):
        try:
            cats = todo_store.list_categories(ctx.user, ctx.settings)
            cid = ""
            if args.get("category"):
                cid = _need_category(cats, args["category"])
            due = str(args.get("due") or "")
            all_day = bool(args.get("all_day")) or (bool(due) and not dt_has_time(due))
            payload = {
                "title": args["title"],
                "description": args.get("description", ""),
                "category_id": cid,
                "due": due,
                "all_day": all_day,
                "color": resolve_color(args["color"], "2") if args.get("color") else "",
            }
            try:
                todo = todo_store.create_todo(ctx.user, ctx.settings, payload)
            except HTTPException as e:
                return _fail(e)
            where = f" [{_cat_path(cats, cid)}]" if cid else ""
            when = f" (마감 {todo['due'][:16].replace('T', ' ')})" if todo.get("due") else ""
            return SkillResult(
                ok=True,
                message=f"할 일 '{todo['title']}'{where}{when} 추가됨",
                data={"todo_id": todo["id"], "todo": _row(todo, _path_map(cats))},
            )


        except _Stop as stop:
            return stop.result
class UpdateTodo(SkillBase):
    mutates = "todo"
    name = "update_todo"
    description = "할 일을 고친다(제목·설명·마감·카테고리·색). id는 list_todos가 준 값."
    parameters = {
        "type": "object",
        "properties": {
            "todo_id": {"type": "string"},
            "title": {"type": "string"},
            "description": {"type": "string"},
            "category": _CAT_PROP,
            "due": {"type": "string", "description": "마감. 빈 문자열을 주면 기한을 없앤다."},
            "all_day": {"type": "boolean"},
            "color": {"type": "string"},
        },
        "required": ["todo_id"],
    }

    def run(self, args, ctx):
        try:
            cats = todo_store.list_categories(ctx.user, ctx.settings)
            payload: dict = {}
            for k in ("title", "description"):
                if args.get(k) is not None:
                    payload[k] = args[k]
            if args.get("category") is not None:
                payload["category_id"] = _need_category(cats, args["category"])
            if args.get("color"):
                payload["color"] = resolve_color(args["color"], "2")
            if args.get("all_day") is not None:
                payload["all_day"] = bool(args["all_day"])
            if "due" in args and args["due"] is not None:
                payload["due"] = str(args["due"])
                if payload["due"] and "all_day" not in payload:
                    payload["all_day"] = not dt_has_time(payload["due"])
            if not payload:
                return SkillResult(
                    ok=False, error_code="invalid",
                    message="무엇을 바꿀지 없습니다. title·description·due·category·color 중 하나는 주세요.",
                )
            try:
                todo = todo_store.update_todo(ctx.user, ctx.settings, str(args["todo_id"]), payload)
            except HTTPException as e:
                return _fail(e)
            return SkillResult(
                ok=True, message=f"할 일 '{todo['title']}' 수정됨",
                data={"todo_id": todo["id"], "todo": _row(todo, _path_map(cats))},
            )


        except _Stop as stop:
            return stop.result
class CompleteTodo(SkillBase):
    mutates = "todo"
    name = "complete_todo"
    description = "할 일을 완료 처리한다(done=false를 주면 다시 미완료로 되돌린다)."
    parameters = {
        "type": "object",
        "properties": {
            "todo_id": {"type": "string"},
            "done": {"type": "boolean", "description": "생략하면 완료(true)."},
        },
        "required": ["todo_id"],
    }

    def run(self, args, ctx):
        done = True if args.get("done") is None else bool(args["done"])
        try:
            todo = todo_store.update_todo(
                ctx.user, ctx.settings, str(args["todo_id"]), {"done": done}
            )
        except HTTPException as e:
            return _fail(e)
        cats = todo_store.list_categories(ctx.user, ctx.settings)
        word = "완료" if done else "미완료로 되돌림"
        return SkillResult(
            ok=True, message=f"'{todo['title']}' {word}",
            data={"todo_id": todo["id"], "todo": _row(todo, _path_map(cats))},
        )


class DeleteTodo(SkillBase):
    mutates = "todo"
    name = "delete_todo"
    description = (
        "할 일을 삭제한다. 휴지통의 '할 일'로 들어가 되돌릴 수 있다. "
        "'다 했다'는 뜻이면 삭제가 아니라 complete_todo를 쓰세요."
    )
    parameters = {
        "type": "object",
        "properties": {"todo_id": {"type": "string"}},
        "required": ["todo_id"],
    }

    def run(self, args, ctx):
        try:
            res = todo_store.delete_todo(ctx.user, ctx.settings, str(args["todo_id"]))
        except HTTPException as e:
            return _fail(e)
        return SkillResult(
            ok=True,
            message=f"할 일 '{res['title']}' 삭제됨 — 휴지통의 '할 일'에서 되돌릴 수 있습니다",
            data=res,
        )


class BulkCompleteTodos(SkillBase):
    mutates = "todo"
    name = "bulk_complete_todos"
    description = (
        "여러 할 일을 한 번에 완료 처리한다. id를 직접 주거나 카테고리로 고른다. "
        "'A 카테고리 다 했어' 같은 요청에 낱개 호출을 반복하지 말고 이걸 쓰세요."
    )
    parameters = {
        "type": "object",
        "properties": {
            "todo_ids": {"type": "array", "items": {"type": "string"}},
            "category": _CAT_PROP,
            "done": {"type": "boolean", "description": "생략하면 완료(true)."},
            "dry_run": {"type": "boolean", "description": "true면 바꾸지 않고 대상만 돌려준다."},
        },
    }

    MAX = 200

    def run(self, args, ctx):
        try:
            cats = todo_store.list_categories(ctx.user, ctx.settings)
            ids = [str(i) for i in (args.get("todo_ids") or [])]
            if not ids and not args.get("category"):
                return SkillResult(
                    ok=False, error_code="invalid",
                    message="대상이 너무 넓습니다. todo_ids나 category로 좁혀 주세요.",
                )
            done = True if args.get("done") is None else bool(args["done"])
            if ids:
                targets = []
                missing = []
                for i in ids:
                    t = todo_store.get_todo(ctx.user, ctx.settings, i)
                    (targets if t else missing).append(t or i)
                if missing:
                    return SkillResult(
                        ok=False, error_code="not_found",
                        message="찾지 못한 할 일이 있습니다: " + ", ".join(missing),
                        data={"missing": missing},
                    )
            else:
                cid = _need_category(cats, args["category"])
                targets = todo_store.list_todos(ctx.user, ctx.settings, category_id=cid)
            # 이미 그 상태인 것은 건드리지 않는다(같은 지시를 두 번 받아도 안전)
            targets = [t for t in targets if bool(t.get("done")) != done]
            if not targets:
                return SkillResult(ok=True, message="바꿀 할 일이 없습니다(이미 반영돼 있습니다).",
                                   data={"count": 0, "changed": []})
            if len(targets) > self.MAX:
                return SkillResult(
                    ok=False, error_code="too_many",
                    message=f"대상이 {len(targets)}개로 너무 많습니다(최대 {self.MAX}).",
                    data={"count": len(targets)},
                )
            paths = _path_map(cats)
            listing = [_row(t, paths) for t in targets]
            if args.get("dry_run"):
                return SkillResult(
                    ok=True,
                    message=f"{len(listing)}개가 바뀝니다(아직 적용 안 함). 확인 후 dry_run 없이 다시 요청하세요.",
                    data={"planned": listing, "count": len(listing), "dry_run": True},
                )
            changed, failed = [], []
            for t in targets:
                try:
                    todo_store.update_todo(ctx.user, ctx.settings, t["id"], {"done": done})
                    changed.append(t["id"])
                except HTTPException as e:
                    failed.append({"id": t["id"], "error": str(e.detail)})
            word = "완료" if done else "미완료"
            msg = f"{len(changed)}개를 {word} 처리했습니다"
            if failed:
                msg += f" — {len(failed)}개 실패"
            return SkillResult(ok=bool(changed) or not failed, message=msg,
                               data={"changed": changed, "failed": failed, "count": len(changed)})


        except _Stop as stop:
            return stop.result
class BulkDeleteTodos(SkillBase):
    mutates = "todo"
    name = "bulk_delete_todos"
    description = (
        "여러 할 일을 한 번에 삭제한다(휴지통으로). 카테고리나 '완료된 것'으로 고른다. "
        "삭제는 되돌리기 번거로우니 먼저 dry_run=true로 보여주고 확인을 받으세요."
    )
    parameters = {
        "type": "object",
        "properties": {
            "todo_ids": {"type": "array", "items": {"type": "string"}},
            "category": _CAT_PROP,
            "only_done": {"type": "boolean", "description": "완료된 것만 지운다(정리용)."},
            "dry_run": {"type": "boolean"},
        },
    }

    MAX = 100

    def run(self, args, ctx):
        try:
            cats = todo_store.list_categories(ctx.user, ctx.settings)
            ids = [str(i) for i in (args.get("todo_ids") or [])]
            if not ids and not args.get("category") and not args.get("only_done"):
                return SkillResult(
                    ok=False, error_code="invalid",
                    message="대상이 너무 넓습니다. todo_ids·category·only_done 중 하나로 좁혀 주세요.",
                )
            if ids:
                targets, missing = [], []
                for i in ids:
                    t = todo_store.get_todo(ctx.user, ctx.settings, i)
                    if t:
                        targets.append(t)
                    else:
                        missing.append(i)
                if missing:
                    return SkillResult(ok=False, error_code="not_found",
                                       message="찾지 못한 할 일이 있습니다: " + ", ".join(missing),
                                       data={"missing": missing})
            else:
                cid = None
                if args.get("category"):
                    cid = _need_category(cats, args["category"])
                targets = todo_store.list_todos(ctx.user, ctx.settings, category_id=cid)
            if args.get("only_done"):
                targets = [t for t in targets if t.get("done")]
            if not targets:
                return SkillResult(ok=True, message="지울 할 일이 없습니다.", data={"count": 0, "deleted": []})
            if len(targets) > self.MAX:
                return SkillResult(ok=False, error_code="too_many",
                                   message=f"대상이 {len(targets)}개로 너무 많습니다(최대 {self.MAX}).",
                                   data={"count": len(targets)})
            paths = _path_map(cats)
            listing = [_row(t, paths) for t in targets]
            if args.get("dry_run"):
                return SkillResult(
                    ok=True,
                    message=f"{len(listing)}개가 삭제됩니다(아직 지우지 않음). 확인 후 dry_run 없이 다시 요청하세요.",
                    data={"planned": listing, "count": len(listing), "dry_run": True},
                )
            deleted, failed = [], []
            for t in targets:
                try:
                    todo_store.delete_todo(ctx.user, ctx.settings, t["id"])
                    deleted.append(t["id"])
                except HTTPException as e:
                    failed.append({"id": t["id"], "error": str(e.detail)})
            msg = f"{len(deleted)}개를 삭제했습니다 — 휴지통의 '할 일'에서 되돌릴 수 있습니다"
            if failed:
                msg += f" ({len(failed)}개 실패)"
            return SkillResult(ok=bool(deleted) or not failed, message=msg,
                               data={"deleted": deleted, "failed": failed, "count": len(deleted)})
        except _Stop as stop:
            return stop.result
