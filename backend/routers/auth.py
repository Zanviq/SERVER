"""인증 라우터: 로그인·로그아웃·세션 조회."""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from ..auth import (
    COOKIE_NAME,
    SessionUser,
    issue_token,
    require_session,
)
from ..config import Settings, get_settings
from .. import accounts, user_settings

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class SignupRequest(BaseModel):
    username: str
    password: str
    display_name: str = ""


class SessionInfo(BaseModel):
    username: str
    display_name: str
    expires_at: float
    remaining: int
    role: str = "user"
    origin: str = "signup"


@router.post("/login", response_model=SessionInfo)
def login(
    req: LoginRequest,
    response: Response,
    settings: Settings = Depends(get_settings),
):
    """비밀번호 검증 후 세션 쿠키 발급. 승인 전 계정은 로그인할 수 없다."""
    acc = accounts.authenticate(req.username, req.password, settings)
    if acc is None:
        # 아이디 존재 여부를 흘리지 않도록 한 가지 메시지로 통일
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다.")
    if acc.status == accounts.STATUS_PENDING:
        raise HTTPException(status_code=403, detail="가입 승인을 기다리는 중입니다. 관리자 승인 후 로그인할 수 있습니다.")
    if acc.status == accounts.STATUS_REJECTED:
        raise HTTPException(status_code=403, detail="가입이 거절되었습니다.")
    if not acc.can_login:
        raise HTTPException(status_code=403, detail="비활성화된 계정입니다.")

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
    return SessionInfo(
        username=acc.username,
        display_name=acc.display_name,
        expires_at=time.time() + ttl,
        remaining=ttl,
        role=acc.role,
        origin=acc.origin,
    )


@router.post("/signup", status_code=201)
def signup(req: SignupRequest, settings: Settings = Depends(get_settings)):
    """가입 신청. 관리자가 승인해야 로그인할 수 있다(개인 서버)."""
    acc = accounts.signup(req.username, req.password, req.display_name, settings)
    return {
        "ok": True,
        "username": acc.username,
        "status": acc.status,
        "message": "가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.",
    }


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
        role=user.role,
        origin=user.origin,
    )
