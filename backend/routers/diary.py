"""기록(상태·일기) API — 캘린더 '기록' 모드가 쓴다.

일기 본문에는 잠금이 있다(숫자 4자리, 초기 0000). 잠긴 동안 서버는 text 를
아예 보내지 않는다 — 화면에서만 가리면 개발자 도구로 그대로 읽히기 때문이다.
도형과 "일기가 있다"는 사실은 잠겨 있어도 나간다(달력 칸에 그려야 한다).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query
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


class UnlockBody(BaseModel):
    pin: str


class PinBody(BaseModel):
    current: str
    next: str


# ── 잠금 ──
# **고정 경로를 /{day} 보다 먼저 선언한다.** 아래에 두면 FastAPI 가 먼저 만나는
# /{day} 가 "lock" 을 날짜로 받아 400 으로 끝낸다.

@router.get("/lock")
def lock_state(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """설정 화면 표시용. 해시는 절대 내보내지 않는다."""
    return {"is_default": diary_store.pin_is_default(user, settings)}


@router.post("/unlock")
def unlock(
    body: UnlockBody,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    if not diary_store.verify_pin(user, settings, body.pin):
        raise HTTPException(status_code=403, detail="비밀번호가 다릅니다.")
    return {"token": diary_store.issue_unlock(user, settings),
            "ttl": diary_store.UNLOCK_TTL}


@router.put("/pin")
def change_pin(
    body: PinBody,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """지금 비밀번호를 맞혀야 바꿀 수 있다 — 아니면 잠가 둔 의미가 없다."""
    if not diary_store.verify_pin(user, settings, body.current):
        raise HTTPException(status_code=403, detail="지금 비밀번호가 다릅니다.")
    diary_store.set_pin(user, settings, body.next)
    return {"ok": True, "is_default": diary_store.pin_is_default(user, settings)}


# ── 기록 ──

@router.get("")
def list_range(
    start: str = Query(..., alias="from"),
    end: str = Query(..., alias="to"),
    x_diary_unlock: str = Header(""),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    rows = diary_store.list_range(user, settings, start, end)
    if diary_store.is_unlocked(x_diary_unlock, user, settings):
        return rows
    return [diary_store.hide_text(r) for r in rows]


@router.get("/{day}")
def get_day(
    day: str,
    x_diary_unlock: str = Header(""),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    entry = diary_store.get_day(user, settings, day)
    if diary_store.is_unlocked(x_diary_unlock, user, settings):
        return entry
    return diary_store.hide_text(entry)


@router.put("/{day}")
def save_day(
    day: str,
    body: DiaryPatch,
    x_diary_unlock: str = Header(""),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    patch = body.model_dump(exclude_none=True)
    unlocked = diary_store.is_unlocked(x_diary_unlock, user, settings)
    # 잠긴 채로 글을 덮어쓰지 못하게 한다. 화면은 잠기면 글을 안 보여 주므로
    # 잠긴 상태에서 오는 text 는 **빈 문자열**뿐인데, 그대로 저장하면 도형 하나
    # 누른 것이 그날 일기를 통째로 지운다.
    if not unlocked:
        patch.pop("text", None)
    saved = diary_store.save_day(user, settings, day, patch)
    return saved if unlocked else diary_store.hide_text(saved)
