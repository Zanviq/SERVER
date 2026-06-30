"""인증 라우터: 로그인·로그아웃·세션 조회."""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from ..auth import (
    COOKIE_NAME,
    SessionUser,
    authenticate,
    issue_token,
    require_session,
)
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class SessionInfo(BaseModel):
    username: str
    display_name: str
    expires_at: float
    remaining: int


@router.post("/login", response_model=SessionInfo)
def login(
    req: LoginRequest,
    response: Response,
    settings: Settings = Depends(get_settings),
):
    """비밀번호 검증 후 세션 쿠키 발급."""
    if not authenticate(req.username, req.password, settings):
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다.")

    token = issue_token(req.username, settings)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=settings.session_ttl,
        httponly=True,
        samesite="lax",
        secure=False,  # https 운영 시 리버스프록시/터널에서 처리
        path="/",
    )
    acc = settings.find_user(req.username)
    expires_at = time.time() + settings.session_ttl
    return SessionInfo(
        username=acc.username,
        display_name=acc.display_name,
        expires_at=expires_at,
        remaining=settings.session_ttl,
    )


@router.post("/logout")
def logout(response: Response):
    """세션 쿠키 제거."""
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/session", response_model=SessionInfo)
def session(user: SessionUser = Depends(require_session)):
    """현재 세션 정보 + 남은 시간."""
    return SessionInfo(
        username=user.username,
        display_name=user.display_name,
        expires_at=user.expires_at,
        remaining=user.remaining,
    )
