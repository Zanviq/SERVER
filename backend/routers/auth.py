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
from .. import user_settings

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

    ttl = user_settings.get_session_ttl(req.username, settings)  # 사용자 설정 TTL(전역 폴백)
    token = issue_token(req.username, settings, ttl=ttl)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=ttl,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,  # HTTPS 운영 시 COOKIE_SECURE=true
        path="/",
    )
    acc = settings.find_user(req.username)
    return SessionInfo(
        username=acc.username,
        display_name=acc.display_name,
        expires_at=time.time() + ttl,
        remaining=ttl,
    )


@router.post("/logout")
def logout(response: Response, settings: Settings = Depends(get_settings)):
    """세션 쿠키 제거."""
    response.delete_cookie(
        COOKIE_NAME, path="/", samesite="lax", secure=settings.cookie_secure
    )
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
