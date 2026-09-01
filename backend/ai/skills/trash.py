"""휴지통 스킬 — 지운 것을 되돌린다.

AI가 문서·일정을 지울 수 있는데 되돌릴 수단이 없었다. 사용자가 "방금 지운 거
되살려줘"라고 하면 UI로 직접 휴지통에 들어가는 수밖에 없었다.
지우는 힘을 준 곳에는 되돌리는 힘도 같이 있어야 한다.

영구 삭제(purge)·비우기(empty)는 스킬로 열지 않는다 — 되돌릴 수 없는 동작이라
모델이 "정리해줄까요?" 흐름에서 실행해 버리면 복구 수단이 없다. UI에서만 한다.
"""
from __future__ import annotations

import time
from datetime import datetime

from fastapi import HTTPException

from ... import trash
from ..skill_base import SkillBase, SkillResult

_KIND_LABEL = {trash.KIND_DOCUMENT: "문서", trash.KIND_EVENT: "일정", trash.KIND_TODO: "할 일"}

#: 한 번에 모델에게 보여줄 항목 수 상한(휴지통이 크면 컨텍스트를 다 먹는다)
_MAX_ITEMS = 100


def _ago(seconds: float) -> str:
    """'방금 지운 거 되살려줘'에 답하려면 상대 시간이 필요하다."""
    if seconds < 90:
        return "방금"
    if seconds < 3600:
        return f"{int(seconds // 60)}분 전"
    if seconds < 86400:
        return f"{int(seconds // 3600)}시간 전"
    return f"{int(seconds // 86400)}일 전"


def _row(e: dict, now: float) -> dict:
    """모델에게 줄 최소 정보. 복원에 필요한 id와 사람이 알아볼 이름·시각."""
    kind = trash.entry_kind(e)
    at = float(e.get("deleted_at", 0) or 0)
    out = {
        "id": e.get("id", ""),
        "kind": kind,
        "kind_label": _KIND_LABEL.get(kind, kind),
        "name": e.get("name", ""),
        # epoch 숫자만 주면 모델이 "방금"인지 "지난달"인지 알 수 없다.
        # 사람이 읽는 형태와 상대 시간을 함께 준다.
        "deleted_at": datetime.fromtimestamp(at).strftime("%Y-%m-%dT%H:%M:%S") if at else "",
        "deleted_ago": _ago(max(0.0, now - at)) if at else "",
    }
    if kind == trash.KIND_EVENT:
        out["event_start"] = e.get("event_start", "")
    elif kind == trash.KIND_TODO:
        out["todo_due"] = e.get("todo_due", "")
        out["todo_done"] = bool(e.get("todo_done"))
    else:
        out["orig_path"] = e.get("orig_rel", "")
    return out


class ListTrash(SkillBase):
    name = "list_trash"
    description = (
        "휴지통 목록을 본다. kind로 '문서'(document)·'일정'(event)·'할 일'(todo)만 볼 수 있다. "
        "여기서 얻은 id를 restore_from_trash에 그대로 넘기면 복원된다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["document", "event", "todo"],
                "description": "생략하면 전체.",
            },
            "name_contains": {"type": "string", "description": "이름에 이 말이 든 것만."},
            "within_hours": {
                "type": "number",
                "description": "최근 N시간 안에 지운 것만. '방금/오늘 지운 것'은 이걸로 좁히세요.",
            },
        },
    }

    def run(self, args, ctx):
        kind = str(args.get("kind") or "")
        try:
            entries = trash.list_trash(ctx.user, ctx.settings, kind)
        except Exception as e:  # noqa: BLE001
            return SkillResult(ok=False, message=f"휴지통 조회 실패: {e}", error_code="error")
        needle = str(args.get("name_contains") or "").strip().lower()
        if needle:
            entries = [e for e in entries if needle in str(e.get("name", "")).lower()]

        now = time.time()
        window = ""
        if args.get("within_hours") not in (None, ""):
            try:
                hours = float(args["within_hours"])
            except (TypeError, ValueError):
                return SkillResult(ok=False, error_code="invalid",
                                   message="within_hours는 숫자여야 합니다(예: 1, 24).")
            if hours <= 0:
                return SkillResult(ok=False, error_code="invalid",
                                   message="within_hours는 0보다 커야 합니다.")
            cutoff = now - hours * 3600
            entries = [e for e in entries if float(e.get("deleted_at", 0) or 0) >= cutoff]
            window = f" (최근 {hours:g}시간)"

        total = len(entries)
        rows = [_row(e, now) for e in entries[:_MAX_ITEMS]]
        label = _KIND_LABEL.get(kind, "항목")
        msg = f"휴지통에 {label} {total}개{window}"
        data: dict = {"items": rows}
        if total > _MAX_ITEMS:
            data["truncated"] = True
            data["total"] = total
            msg += f" (최근 {_MAX_ITEMS}개만 표시 — name_contains로 좁히세요)"
        return SkillResult(ok=True, message=msg, data=data)


class RestoreFromTrash(SkillBase):
    mutates = "documents"  # 기본값. 실제 갈래는 결과가 알려준다(아래 SkillResult.mutates)
    name = "restore_from_trash"
    description = (
        "휴지통에서 되돌린다. id는 list_trash로 얻는다. "
        "문서는 원래 경로로, 일정은 캘린더에 다시 만들어진다"
        "(일정은 원래 id를 되살릴 수 없어 새 일정으로 생긴다). 할 일은 원래 id로 돌아온다."
    )
    parameters = {
        "type": "object",
        "properties": {"id": {"type": "string", "description": "list_trash가 준 id"}},
        "required": ["id"],
    }

    def run(self, args, ctx):
        entry_id = str(args.get("id") or "").strip()
        if not entry_id:
            return SkillResult(ok=False, message="복원할 id가 없습니다.", error_code="invalid")
        try:
            result = trash.restore(entry_id, ctx.user, ctx.settings)
        except HTTPException as e:
            # 없는 id(404)와 내용이 사라진 항목(410)을 "error" 한 덩어리로 주면
            # 모델이 다시 list_trash를 부를지 포기할지 판단하지 못한다.
            return SkillResult(
                ok=False, message=str(e.detail),
                error_code="not_found" if e.status_code == 404 else "gone",
            )
        except Exception as e:  # noqa: BLE001
            return SkillResult(ok=False, message=str(e), error_code="error")
        kind = str(result.get("kind") or trash.KIND_DOCUMENT)
        where = result.get("restored_to", "")
        label = _KIND_LABEL.get(kind, kind)
        data: dict = {"kind": kind, "restored_to": where}
        if kind == trash.KIND_TODO:
            # 할 일은 원래 id를 되살린다 — 이어서 수정·완료할 수 있게 그대로 준다
            data["todo_id"] = str(result.get("todo_id") or "")
            data["todo"] = result.get("todo") or {}
        elif kind == trash.KIND_EVENT:
            # 일정은 원래 id를 되살릴 수 없어 **새 id**로 생긴다. 그 값을 안 주면
            # "복원하고 시간도 바꿔줘"에서 다음 스킬이 쓸 식별자가 없어 끊긴다.
            data["event_id"] = str(result.get("event_id") or "")
            data["event"] = result.get("event") or {}
        elif kind == trash.KIND_DOCUMENT:
            data["path"] = where
        return SkillResult(
            ok=True,
            message=f"{label} '{where}' 복원됨",
            data=data,
            # 실제로 바뀐 화면을 알려야 프런트가 맞는 쪽을 새로고침한다
            mutates="calendar" if kind == trash.KIND_EVENT else "documents",
        )
