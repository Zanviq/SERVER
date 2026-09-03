"""인증 라우터: 로그인·로그아웃·세션 조회."""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from ..auth import (
    COOKIE_NAME,
    SessionUser,
    issue_token,
    require_session,
)
from ..config import Settings, get_settings
from .. import accounts, login_guard, user_settings

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _cookie_secure(request: Request, settings: Settings) -> bool:
    """이 요청이 HTTPS로 왔으면 세션 쿠키에 Secure를 붙인다.

    설정으로 못 박지 않는 이유는 접속 경로가 둘이기 때문이다 — 밖에서는
    https://server.zanviq.dev(클라우드플레어 터널), 집 안에서는 http://192.168.0.43.
    COOKIE_SECURE=true로 고정하면 LAN 접속이 로그인 자체를 못 하고(브라우저가
    Secure 쿠키를 평문 연결에 보내지 않는다), false로 고정하면 HTTPS로 들어온
    사람의 쿠키가 평문으로도 오갈 수 있다. 그래서 요청마다 정한다.

    X-Forwarded-Proto는 지어낼 수 있지만, 거짓으로 https라고 하면 자기 쿠키가
    안 붙을 뿐 남에게 피해가 없다(방어가 강해지는 쪽으로만 틀린다).
    """
    if settings.cookie_secure:
        return True
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return proto == "https" or request.url.scheme == "https"


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
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
):
    """비밀번호 검증 후 세션 쿠키 발급. 승인 전 계정은 로그인할 수 없다."""
    # 무차별 대입 차단: 잠겨 있으면 비밀번호를 확인조차 하지 않는다.
    # (확인해 주면 맞았는지 틀렸는지가 새어 나가 제한이 무의미해진다)
    # 확인과 동시에 '진행 중'으로 잡는다 — 따로 하면 동시에 들어온 요청이 전부
    # 통과해 한 번에 수십 개를 시험해 볼 수 있다.
    # nginx 가 덮어써서 넘겨주는 값이라 바깥에서 지어낼 수 없다. 없으면(직접 호출)
    # 빈 문자열이 되어 예전처럼 아이디만으로 센다.
    ip = (request.headers.get("x-client-ip") or "").strip()
    wait = login_guard.begin_attempt(req.username, client_ip=ip)
    locked = bool(wait)
    too_many = HTTPException(
        status_code=429,
        detail=f"로그인 시도가 너무 많습니다. {wait}초 후 다시 시도해 주세요.",
        headers={"Retry-After": str(wait or 1)},
    )
    if locked and not login_guard.allow_probe(req.username, client_ip=ip):
        # 이번 잠금의 확인 기회를 이미 썼다. 여기서는 비밀번호를 보지 않는다.
        raise too_many
    try:
        # 잠겨 있어도 **한 번은** 확인해 준다. 안 그러면 아이디만 아는 사람이
        # 잠금이 풀릴 때마다 5번씩 틀리는 것만으로 주인을 자기 서버에서 영영
        # 몰아낼 수 있다(대기시간이 상한 10분에 눌러앉는다).
        acc = accounts.authenticate(req.username, req.password, settings)
    finally:
        if not locked:
            # inflight 는 잠기지 않은 경로에서만 올라간다. 잠긴 채로 여기서
            # 내리면 남의 진행 중 시도를 대신 지운다.
            login_guard.end_attempt(req.username, client_ip=ip)

    if acc is None:
        if locked:
            # 잠긴 중의 확인이 틀렸다 — 맞았는지 틀렸는지는 429 로 덮는다.
            raise too_many
        login_guard.record_failure(req.username, client_ip=ip)
        # 아이디 존재 여부를 흘리지 않도록 한 가지 메시지로 통일.
        # 한도를 넘었다는 안내(429)는 다음 시도의 begin_attempt 가 준다 — 여기서도
        # 판단하면 규칙이 두 곳으로 갈라진다.
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다.")
    login_guard.record_success(req.username, client_ip=ip)
    if acc.status == accounts.STATUS_PENDING:
        raise HTTPException(status_code=403, detail="가입 승인을 기다리는 중입니다. 관리자 승인 후 로그인할 수 있습니다.")
    if acc.status == accounts.STATUS_REJECTED:
        raise HTTPException(status_code=403, detail="가입이 거절되었습니다.")
    if not acc.can_login:
        raise HTTPException(status_code=403, detail="비활성화된 계정입니다.")

    # **저장된 이름**으로 발급한다. 사용자가 친 문자열을 그대로 쓰면 대소문자에 따라
    # 설정이 따로 놀고(세션 시간이 무시된다) 세션 신원도 흔들린다.
    ttl = user_settings.get_session_ttl(acc.username, settings)  # 사용자 설정 TTL(전역 폴백)
    token = issue_token(acc.username, settings, ttl=ttl)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=ttl,
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(request, settings),
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
def logout(
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
):
    """세션 쿠키 제거."""
    # 지울 때도 발급 때와 같은 속성이어야 브라우저가 같은 쿠키로 알아본다.
    response.delete_cookie(
        COOKIE_NAME, path="/", samesite="lax", secure=_cookie_secure(request, settings)
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
