"""캘린더 통합 서비스 — 유저별로 Google 또는 내부 저장소를 자동 선택.

라우터와 AI 스킬이 이 모듈만 쓰면, 유저에게 Google 설정이 있으면 Google을,
없으면 내부 캘린더를 일관되게 사용한다. (반복·알림은 내부 전용 기능)
"""
from __future__ import annotations

from . import calendar_store
from .calendar_ids import is_instance
from .auth import SessionUser
from .calendar_google import get_google_calendar
from .config import Settings


def backend_kind(user: SessionUser, settings: Settings) -> str:
    return "google" if get_google_calendar(settings, user.username) else "internal"


def list_events(user: SessionUser, settings: Settings, frm=None, to=None) -> list[dict]:
    gc = get_google_calendar(settings, user.username)
    if gc:
        return gc.list(frm, to)
    return calendar_store.list_events(user, settings, frm, to)


def create_event(user: SessionUser, settings: Settings, payload: dict) -> dict:
    gc = get_google_calendar(settings, user.username)
    if gc:
        return gc.create(payload)
    return calendar_store.create_event(user, settings, payload)


def update_event(user: SessionUser, settings: Settings, eid: str, payload: dict) -> dict:
    """단건 수정.

    **id를 접지 않고 그대로 넘긴다.** 구글은 인스턴스 id(`시리즈_20260305T...`)를
    그 회차로 해석하므로, base_id로 접으면 "그날 것만" 요청이 시리즈 전체를 바꾼다.
    시리즈 단위로 다뤄야 하는 것은 일괄 스킬(update_many)이고 거기서만 접는다.
    """
    gc = get_google_calendar(settings, user.username)
    if gc:
        return gc.update(eid, payload)
    return calendar_store.update_event(user, settings, eid, payload)


def create_many(
    user: SessionUser, settings: Settings, payloads: list[dict]
) -> tuple[list[dict], list[tuple[str, str]]]:
    """여러 건을 한 번에 만든다(구글은 배치, 내부는 파일 접근 1회)."""
    gc = get_google_calendar(settings, user.username)
    if gc:
        return gc.create_many(payloads)
    return calendar_store.create_many(user, settings, payloads)


def update_many(
    user: SessionUser, settings: Settings, items: list[tuple[str, dict, dict]]
) -> tuple[list[str], list[tuple[str, str]]]:
    """여러 건을 한 번에 수정. items = [(eid, payload, current)].

    낱개 update_event를 반복 호출하면 안 된다 — Google에서는 건마다 get+patch로
    왕복 2회, 내부 저장소에서는 건마다 파일 read/write다. 78건에서 실제로
    1분을 넘겨 nginx가 응답을 끊었다.
    """
    gc = get_google_calendar(settings, user.username)
    if gc:
        return gc.patch_many(items)
    return calendar_store.update_many(user, settings, [(eid, payload) for eid, payload, _ in items])


def delete_many(
    user: SessionUser, settings: Settings, events: list[dict]
) -> tuple[list[str], list[tuple[str, str]]]:
    """여러 건을 한 번에 삭제. 지우기 전에 전부 휴지통에 담는다.

    events는 (id를 포함한) 일정 dict 목록 — 이미 조회해 둔 것을 그대로 넘기면
    삭제 전 스냅샷을 위해 다시 조회할 필요가 없다.
    """
    from . import trash

    # **id를 접지 않는다.** 예전에는 base_id로 접어 넘겨서, 조회가 준 인스턴스 id
    # 하나가 시리즈 전체 삭제가 됐다(실측: 52회차 → 0). 단건 delete_event는 그
    # 회차만 지우므로 같은 식별자를 정반대로 해석한 셈이었다.
    for ev in events:
        try:
            eid = str(ev.get("id", ""))
            # 인스턴스면 '그 날짜의 단발 일정'으로 담는다. 시리즈째 담으면
            # 복원할 때 없던 회차까지 되살아나거나(중복), 시작일이 밀린다.
            snap = {k: v for k, v in _occurrence_snapshot(ev, eid).items()
                    if not k.startswith("_")}  # 스킬 내부 표식은 담지 않는다
            trash.move_event_to_trash(snap, user, settings)
        except Exception:  # noqa: BLE001 - 보관 실패가 삭제를 막지는 않는다
            pass
    eids = [str(e.get("id", "")) for e in events]
    gc = get_google_calendar(settings, user.username)
    if gc:
        return gc.delete_many(eids)
    _trash_split_offs(user, settings, eids)
    return calendar_store.delete_many(user, settings, eids)


def _trash_split_offs(user: SessionUser, settings: Settings, eids: list[str]) -> None:
    """시리즈를 지우면 거기서 떼어낸 회차도 함께 사라진다 — 그것도 담아 둔다.

    저장소 안에서 조용히 일어나는 삭제라, 담지 않으면 사용자가 따로 시간·제목을
    고쳐 둔 그 회차를 되돌릴 방법이 아예 없다(휴지통에는 시리즈만 남는다).
    """
    from . import trash

    try:
        extras = calendar_store.split_offs_for(user, settings, eids)
    except Exception:  # noqa: BLE001 - 보관 실패가 삭제를 막지는 않는다
        return
    for ev in extras:
        try:
            trash.move_event_to_trash(
                {k: v for k, v in ev.items() if not k.startswith("_")}, user, settings)
        except Exception:  # noqa: BLE001
            pass


def find_event(user: SessionUser, settings: Settings, eid: str) -> dict | None:
    """id로 일정 하나를 찾는다(반복은 인스턴스 id도 받는다). 삭제 전 보관용."""
    gc = get_google_calendar(settings, user.username)
    try:
        if gc:
            return gc.get(eid)
        return calendar_store.find_event(user, settings, eid)
    except Exception:  # noqa: BLE001 - 못 찾아도 삭제 자체는 진행한다
        return None


def _occurrence_snapshot(snapshot: dict, eid: str) -> dict:
    """반복 일정의 '한 회차'를 되살릴 수 있는 형태로 만든다.

    find_event는 시리즈 원본을 준다. 그대로 휴지통에 넣으면 회차 하나를 지웠는데
    복원할 때 반복 일정이 통째로 다시 생겨 중복된다. 인스턴스 id면 그 날짜의
    단발 일정으로 바꿔 담는다.
    """
    if not is_instance(eid):
        return snapshot
    one = dict(snapshot)
    one.pop("id", None)
    one["recurrence"] = "none"
    one.pop("exdates", None)
    one.pop("recur_until", None)
    day = str(eid).split("@", 1)[1][:10] if "@" in str(eid) else ""
    if day:
        # 회차의 시작·끝은 **한 곳**에서 낸다(calendar_store._occurrence_times).
        # 여기에 복사본을 두었더니 여러 날에 걸친 '종일' 반복 일정의 끝이
        # 시작일로 뭉개져, 3일짜리를 지웠다 복원하면 하루짜리로 돌아왔다.
        one["start"], one["end"] = calendar_store._occurrence_times(snapshot, day)
    return one


def delete_event(user: SessionUser, settings: Settings, eid: str) -> None:
    """삭제 전에 휴지통에 담는다 — 실수로 지워도 되돌릴 수 있게.

    **id를 접지 않는다.** 구글은 인스턴스 id를 그 회차로 해석하므로, base_id로
    접으면 "그날 것만 지워줘"가 시리즈 전체를 지운다(내부 저장소는 @날짜를
    exdate로 처리한다). 시리즈 단위 삭제는 일괄 스킬(delete_many)이 담당한다.

    보관에 실패해도 삭제는 진행한다(사용자가 요청한 동작을 막지 않는다).
    """
    snapshot = find_event(user, settings, eid)
    gc = get_google_calendar(settings, user.username)
    if gc:
        gc.delete(eid)
    else:
        _trash_split_offs(user, settings, [eid])
        calendar_store.delete_event(user, settings, eid)
    if snapshot:
        try:
            from . import trash

            trash.move_event_to_trash(_occurrence_snapshot(snapshot, eid), user, settings)
        except Exception:  # noqa: BLE001
            pass


def due_reminders(user: SessionUser, settings: Settings, now_iso: str, within: int) -> list[dict]:
    # 알림(remind_minutes)은 내부 캘린더 전용 기능
    if get_google_calendar(settings, user.username):
        return []
    return calendar_store.due_reminders(user, settings, now_iso, within)
