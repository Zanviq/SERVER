"""캘린더 통합 서비스 — 유저별로 Google 또는 내부 저장소를 자동 선택.

라우터와 AI 스킬이 이 모듈만 쓰면, 유저에게 Google 설정이 있으면 Google을,
없으면 내부 캘린더를 일관되게 사용한다. (반복·알림은 내부 전용 기능)
"""
from __future__ import annotations

from . import calendar_store
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
    gc = get_google_calendar(settings, user.username)
    if gc:
        return gc.update(eid.split("@", 1)[0], payload)
    return calendar_store.update_event(user, settings, eid, payload)


def find_event(user: SessionUser, settings: Settings, eid: str) -> dict | None:
    """id로 일정 하나를 찾는다(반복은 인스턴스 id도 받는다). 삭제 전 보관용."""
    gc = get_google_calendar(settings, user.username)
    try:
        if gc:
            return gc.get(eid)
        return calendar_store.find_event(user, settings, eid)
    except Exception:  # noqa: BLE001 - 못 찾아도 삭제 자체는 진행한다
        return None


def delete_event(user: SessionUser, settings: Settings, eid: str) -> None:
    """삭제 전에 휴지통에 담는다 — 실수로 지워도 되돌릴 수 있게.

    보관에 실패해도 삭제는 진행한다(사용자가 요청한 동작을 막지 않는다).
    """
    snapshot = find_event(user, settings, eid)
    gc = get_google_calendar(settings, user.username)
    if gc:
        gc.delete(eid.split("@", 1)[0])
    else:
        calendar_store.delete_event(user, settings, eid)
    if snapshot:
        try:
            from . import trash

            trash.move_event_to_trash(snapshot, user, settings)
        except Exception:  # noqa: BLE001
            pass


def due_reminders(user: SessionUser, settings: Settings, now_iso: str, within: int) -> list[dict]:
    # 알림(remind_minutes)은 내부 캘린더 전용 기능
    if get_google_calendar(settings, user.username):
        return []
    return calendar_store.due_reminders(user, settings, now_iso, within)
