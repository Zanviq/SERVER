"""기록(상태·일기) API — 캘린더 '기록' 모드가 쓴다."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from .. import diary_store
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/diary", tags=["diary"])


class DiaryPatch(BaseModel):
    body: str | None = None
    heart: str | None = None
    mind: str | None = None
    text: str | None = None


@router.get("")
def list_range(
    start: str = Query(..., alias="from"),
    end: str = Query(..., alias="to"),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return diary_store.list_range(user, settings, start, end)


@router.get("/{day}")
def get_day(
    day: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return diary_store.get_day(user, settings, day)


@router.put("/{day}")
def save_day(
    day: str,
    body: DiaryPatch,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return diary_store.save_day(user, settings, day, body.model_dump(exclude_none=True))
