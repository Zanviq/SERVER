"""캘린더 API: 유저별 내부 저장소 또는 Google Calendar."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, field_validator

from .. import calendar_service
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings
from ..datetimes import MAX_INTERVAL, BadDateTime
from ..datetimes import has_time as dt_has_time
from ..datetimes import to_iso as dt_to_iso

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


def _check_time(v, field: str):
    """UI가 보내는 시각도 저장 전에 검증한다.

    AI 스킬 쪽만 막으면 반쪽이다. 여기로 이상한 값이 들어오면 마찬가지로
    일정이 조회에서 사라지거나(파싱 실패) 캘린더 전체가 죽는다(타임존).
    """
    if v in (None, ""):
        return v
    try:
        return dt_to_iso(v, field=field, date_only=not dt_has_time(v))
    except BadDateTime as e:
        raise ValueError(str(e)) from e


class EventInput(BaseModel):
    title: str
    description: str = ""
    start: str
    end: str | None = None
    allDay: bool = False
    color: str = "2"
    recurrence: str = "none"  # none|daily|weekly|monthly|yearly
    interval: int = Field(1, ge=1, le=MAX_INTERVAL)
    recur_until: str = ""
    remind_minutes: int = 0

    @field_validator("start", "end")
    @classmethod
    def _times(cls, v, info):
        return _check_time(v, "시작" if info.field_name == "start" else "종료")


class EventPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    start: str | None = None
    end: str | None = None
    allDay: bool | None = None
    color: str | None = None
    recurrence: str | None = None
    interval: int | None = Field(None, ge=1, le=MAX_INTERVAL)
    recur_until: str | None = None
    remind_minutes: int | None = None

    @field_validator("start", "end")
    @classmethod
    def _times(cls, v, info):
        return _check_time(v, "시작" if info.field_name == "start" else "종료")


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
