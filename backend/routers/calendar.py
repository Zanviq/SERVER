"""캘린더 API: 유저별 내부 저장소 또는 Google Calendar."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from .. import calendar_service
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


class EventInput(BaseModel):
    title: str
    description: str = ""
    start: str
    end: str | None = None
    allDay: bool = False
    color: str = "2"
    recurrence: str = "none"  # none|daily|weekly|monthly|yearly
    interval: int = 1
    recur_until: str = ""
    remind_minutes: int = 0


class EventPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    start: str | None = None
    end: str | None = None
    allDay: bool | None = None
    color: str | None = None
    recurrence: str | None = None
    interval: int | None = None
    recur_until: str | None = None
    remind_minutes: int | None = None


@router.get("/source")
def source(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """현재 유저의 캘린더 백엔드(google|internal)."""
    return {"source": calendar_service.backend_kind(user, settings)}


@router.get("/events")
def list_events(
    frm: str | None = Query(None, alias="from"),
    to: str | None = Query(None),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return calendar_service.list_events(user, settings, frm, to)


@router.post("/events")
def create_event(
    body: EventInput,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return calendar_service.create_event(user, settings, body.model_dump())


@router.put("/events/{eid}")
def update_event(
    eid: str,
    body: EventPatch,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    return calendar_service.update_event(user, settings, eid, payload)


@router.delete("/events/{eid}")
def delete_event(
    eid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    calendar_service.delete_event(user, settings, eid)
    return {"ok": True}


@router.get("/reminders")
def reminders(
    within: int = Query(1440, description="지금부터 몇 분 이내"),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """알림이 설정된 다가오는 일정 (내부 캘린더 전용)."""
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    return calendar_service.due_reminders(user, settings, now, within)
