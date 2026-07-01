"""세션 인증: 서명된 토큰 발급/검증 + FastAPI 의존성.

- .env(AUTH_USERS)의 계정만 로그인 가능.
- 토큰은 itsdangerous로 서명(SESSION_SECRET) + 발급시각 포함 → TTL 만료 강제.
- 토큰은 HttpOnly 쿠키(tw_session)로 전달.
"""
from __future__ import annotations

import hmac
import time
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import Settings, get_settings

COOKIE_NAME = "tw_session"
_SALT = "twomes-session-v1"


@dataclass
class SessionUser:
    username: str
    display_name: str
    expires_at: float  # epoch seconds
    remaining: int  # seconds


def _serializer(settings: Settings) -> URLSafeTimedSerializer:
    if not settings.session_secret:
        raise HTTPException(
            status_code=503,
            detail="SESSION_SECRET이 설정되지 않았습니다 (.env 확인).",
        )
    return URLSafeTimedSerializer(settings.session_secret, salt=_SALT)


def issue_token(username: str, settings: Settings | None = None) -> str:
    """username에 대한 서명 세션 토큰 발급."""
    settings = settings or get_settings()
    return _serializer(settings).dumps({"u": username})


def verify_token(token: str, settings: Settings | None = None) -> dict | None:
    """토큰 검증. 유효하면 {'username'} 반환, 만료/위조면 None."""
    settings = settings or get_settings()
    try:
        # itsdangerous가 발급시각을 토큰에 포함 → max_age로 만료 강제
        data = _serializer(settings).loads(token, max_age=settings.session_ttl)
    except SignatureExpired:
        return None
    except BadSignature:
        return None
    except Exception:
        return None

    username = data.get("u")
    if not username:
        return None
    # 계정이 .env에서 제거되었으면 무효
    if settings.find_user(username) is None:
        return None
    return {"username": username}


def authenticate(username: str, password: str, settings: Settings) -> bool:
    """상수시간 비교로 비밀번호 검증."""
    acc = settings.find_user(username)
    if acc is None:
        # 타이밍 공격 완화: 더미 비교
        hmac.compare_digest(password, password)
        return False
    return hmac.compare_digest(password, acc.password)


def _decode_expiry(token: str, settings: Settings) -> float:
    """서명 토큰에서 발급시각을 복원해 만료 epoch 계산."""
    try:
        # signer가 base64(timestamp)를 포함 — loads는 검증만 하므로
        # 발급시각은 내부 API로 추출
        s = _serializer(settings)
        ts = s.loads(token, max_age=settings.session_ttl, return_timestamp=True)[1]
        return ts.timestamp() + settings.session_ttl
    except Exception:
        return time.time() + settings.session_ttl


def require_session(
    request: Request, settings: Settings = Depends(get_settings)
) -> SessionUser:
    """모든 보호 라우트가 의존. 유효 세션 없으면 401."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    payload = verify_token(token, settings)
    if payload is None:
        raise HTTPException(status_code=401, detail="세션이 만료되었거나 유효하지 않습니다.")

    acc = settings.find_user(payload["username"])
    expires_at = _decode_expiry(token, settings)
    remaining = max(0, int(expires_at - time.time()))
    return SessionUser(
        username=acc.username,
        display_name=acc.display_name,
        expires_at=expires_at,
        remaining=remaining,
    )
