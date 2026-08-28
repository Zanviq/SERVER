"""휴지통 스킬 — 지운 것을 되돌린다.

AI가 문서·일정을 지울 수 있는데 되돌릴 수단이 없었다. 사용자가 "방금 지운 거
되살려줘"라고 하면 UI로 직접 휴지통에 들어가는 수밖에 없었다.
지우는 힘을 준 곳에는 되돌리는 힘도 같이 있어야 한다.

영구 삭제(purge)·비우기(empty)는 스킬로 열지 않는다 — 되돌릴 수 없는 동작이라
모델이 "정리해줄까요?" 흐름에서 실행해 버리면 복구 수단이 없다. UI에서만 한다.
"""
from __future__ import annotations

from ... import trash
from ..skill_base import SkillBase, SkillResult

_KIND_LABEL = {trash.KIND_DOCUMENT: "문서", trash.KIND_EVENT: "일정"}

#: 한 번에 모델에게 보여줄 항목 수 상한(휴지통이 크면 컨텍스트를 다 먹는다)
_MAX_ITEMS = 100


def _row(e: dict) -> dict:
    """모델에게 줄 최소 정보. 복원에 필요한 id와 사람이 알아볼 이름·시각."""
    kind = trash.entry_kind(e)
    out = {
        "id": e.get("id", ""),
        "kind": kind,
        "kind_label": _KIND_LABEL.get(kind, kind),
        "name": e.get("name", ""),
        "deleted_at": e.get("deleted_at", 0),
    }
    if kind == trash.KIND_EVENT:
        out["event_start"] = e.get("event_start", "")
    else:
        out["orig_path"] = e.get("orig_rel", "")
    return out


class ListTrash(SkillBase):
    name = "list_trash"
    description = (
        "휴지통 목록을 본다. kind로 '문서'(document)나 '일정'(event)만 볼 수 있다. "
        "여기서 얻은 id를 restore_from_trash에 그대로 넘기면 복원된다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["document", "event"],
                "description": "생략하면 전체.",
            },
            "name_contains": {"type": "string", "description": "이름에 이 말이 든 것만."},
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
        total = len(entries)
        rows = [_row(e) for e in entries[:_MAX_ITEMS]]
        label = _KIND_LABEL.get(kind, "항목")
        msg = f"휴지통에 {label} {total}개"
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
        "(일정은 원래 id를 되살릴 수 없어 새 일정으로 생긴다)."
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
        except Exception as e:  # noqa: BLE001 - HTTPException 등
            return SkillResult(ok=False, message=getattr(e, "detail", str(e)), error_code="error")
        kind = str(result.get("kind") or trash.KIND_DOCUMENT)
        where = result.get("restored_to", "")
        label = _KIND_LABEL.get(kind, kind)
        return SkillResult(
            ok=True,
            message=f"{label} '{where}' 복원됨",
            data={"kind": kind, "restored_to": where},
            # 실제로 바뀐 화면을 알려야 프런트가 맞는 쪽을 새로고침한다
            mutates="calendar" if kind == trash.KIND_EVENT else "documents",
        )
