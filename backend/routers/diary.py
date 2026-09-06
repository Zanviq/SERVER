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
    #: 어느 하루를 여는가. 표는 이 하루에만 듣는다.
    date: str


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
    day = diary_store.check_date(body.date)
    if not diary_store.verify_pin(user, settings, body.pin):
        raise HTTPException(status_code=403, detail="비밀번호가 다릅니다.")
    return {"token": diary_store.issue_unlock(user, settings, day),
            "date": day, "ttl": diary_store.UNLOCK_TTL}


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
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """달력 한 화면치. **글은 절대 실어 보내지 않는다.**

    표가 하루짜리가 된 뒤로, 여러 날을 한 번에 주는 이 응답에는 열어 줄
    기준이 없다. 달력 칸에 필요한 것은 도형과 "글이 있는가"(has_text)뿐이고,
    글은 그 하루를 열어 단건으로 받는다.
    """
    rows = diary_store.list_range(user, settings, start, end)
    return [diary_store.hide_text(r) for r in rows]


@router.get("/{day}")
def get_day(
    day: str,
    x_diary_unlock: str = Header(""),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    entry = diary_store.get_day(user, settings, day)
    if diary_store.is_unlocked(x_diary_unlock, user, settings, day):
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
    unlocked = diary_store.is_unlocked(x_diary_unlock, user, settings, day)
    # 아직 글이 없는 날인가. 잠긴 화면이 덮어쓰지 못하게 막을지, 처음 쓰는
    # 글이라 그냥 받을지가 여기서 갈린다.
    had_text = diary_store.get_day(user, settings, day)["has_text"]
    # 잠긴 채로 **이미 있는** 글을 덮어쓰지 못하게 한다. 화면은 잠기면 글을 안
    # 보여 주므로 그때 오는 text 는 빈 문자열뿐인데, 그대로 저장하면 도형 하나
    # 누른 것이 그날 일기를 통째로 지운다.
    #
    # **아직 글이 없는 날까지 함께 막으면 안 된다.** 그러면 잠금을 켠 뒤로는 새
    # 일기를 아예 쓸 수 없다 — 서버가 조용히 버리는데 화면에는 "저장됨"만 뜬다.
    if not unlocked and had_text:
        patch.pop("text", None)
    saved = diary_store.save_day(user, settings, day, patch)
    if unlocked:
        return saved
    if not had_text and saved["has_text"]:
        # 방금 자기 손으로 쓴 글이다. 이어 쓰려면 표가 있어야 하므로(다음 자동
        # 저장부터는 '이미 글이 있는 날'이 된다) 그 하루짜리 표를 함께 준다.
        # 비밀번호를 다시 묻지 않는 이유는, 가리려는 대상이 바로 이 사람이
        # 지금 쓰고 있는 글이 아니기 때문이다.
        return {**saved, "unlock": diary_store.issue_unlock(user, settings, day)}
    return diary_store.hide_text(saved)
