"""사용량 API — **수치만** 오간다.

내 것은 누구나 볼 수 있고(자기 사용량), 남의 것은 서버 주인만 본다.
어느 쪽이든 나가는 값은 개수·시간·토큰뿐이다 — 문서 제목도, 일정 이름도,
대화 한 줄도 이 길로는 나가지 않는다(backend/usage.py 참고).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .. import accounts, usage
from ..auth import SessionUser, require_owner, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/usage", tags=["usage"])


class PageBeat(BaseModel):
    """화면 한 곳에 머문 시간. 화면 이름은 서버가 알려진 라우트로 접는다."""
    route: str
    seconds: float
    came_from: str = ""


@router.post("/page")
def page(
    body: PageBeat,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """내 체류 시간을 더한다. 자기 것만 쌓을 수 있다(사용자 이름을 받지 않는다)."""
    usage.add_page(user, settings, route=body.route, seconds=body.seconds,
                   came_from=body.came_from)
    return {"ok": True}


@router.get("/me")
def mine(
    month: str = Query(""),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return usage.summary(user, settings, month)


@router.get("/users")
def users(
    month: str = Query(""),
    _owner: SessionUser = Depends(require_owner),
    settings: Settings = Depends(get_settings),
):
    """계정 목록 + **이번 달 토큰만**. 목록에는 그 이상 싣지 않는다."""
    ym = usage.check_month(month or usage.this_month())
    rows = []
    for row in accounts.list_all(settings):
        name = str(row.get("username") or "")
        if not name:
            continue
        rows.append({
            "username": name,
            "display_name": str(row.get("display_name") or name),
            "role": str(row.get("role") or "user"),
            "status": str(row.get("status") or ""),
            "tokens": usage.month_tokens(name, settings, ym),
        })
    rows.sort(key=lambda r: -r["tokens"])
    return {"month": ym, "users": rows}


@router.get("/user/{username}")
def one(
    username: str,
    month: str = Query(""),
    _owner: SessionUser = Depends(require_owner),
    settings: Settings = Depends(get_settings),
):
    """한 사용자의 수치 요약. **그 사람의 자료는 한 글자도 나가지 않는다.**"""
    known = {str(r.get("username") or "") for r in accounts.list_all(settings)}
    if username not in known:
        raise HTTPException(status_code=404, detail="없는 계정입니다.")
    return usage.summary(username, settings, month)
