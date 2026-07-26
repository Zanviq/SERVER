"""세션 인증: 서명된 토큰 발급/검증 + FastAPI 의존성.

- .env(AUTH_USERS)의 계정만 로그인 가능.
- 토큰은 itsdangerous로 서명(SESSION_SECRET) + 발급시각 포함 → TTL 만료 강제.
- 토큰은 HttpOnly 쿠키(server_session)로 전달.
"""
from __future__ import annotations

import hmac
import time
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import Settings, get_settings

COOKIE_NAME = "server_session"
_SALT = "server-session-v1"


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


# TTL 안전 범위(초): 최소 5분 ~ 최대 30일
_TTL_MIN = 300
_TTL_MAX = 2_592_000


def clamp_ttl(seconds, settings: Settings) -> int:
    """사용자가 지정한 TTL(초)을 안전 범위로 클램프. 잘못된 값이면 전역 기본."""
    try:
        s = int(seconds)
    except (TypeError, ValueError):
        return settings.session_ttl
    return max(_TTL_MIN, min(s, _TTL_MAX))


def _payload_ttl(data: dict, settings: Settings) -> int:
    """토큰 payload의 ttl(있으면)로 만료 기준을 정한다. 없으면 전역(구 토큰 호환)."""
    raw = data.get("ttl")
    return clamp_ttl(raw, settings) if raw is not None else settings.session_ttl


def issue_token(username: str, settings: Settings | None = None, ttl: int | None = None) -> str:
    """username에 대한 서명 세션 토큰 발급. ttl(초) 지정 시 토큰에 포함해 그 값으로 만료."""
    settings = settings or get_settings()
    payload: dict = {"u": username}
    if ttl is not None:
        payload["ttl"] = int(ttl)
    return _serializer(settings).dumps(payload)


def verify_token(token: str, settings: Settings | None = None) -> dict | None:
    """토큰 검증. 유효하면 {'username'} 반환, 만료/위조면 None."""
    settings = settings or get_settings()
    try:
        # 발급시각을 함께 복원(max_age 미지정) → payload의 ttl로 직접 만료 판정
        data, ts = _serializer(settings).loads(token, return_timestamp=True)
    except (SignatureExpired, BadSignature):
        return None
    except Exception:
        return None

    username = data.get("u")
    if not username:
        return None
    ttl = _payload_ttl(data, settings)
    if (time.time() - ts.timestamp()) > ttl:
        return None  # 만료
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
    """서명 토큰에서 발급시각을 복원해 만료 epoch 계산(토큰 ttl 반영)."""
    try:
        data, ts = _serializer(settings).loads(token, return_timestamp=True)
        return ts.timestamp() + _payload_ttl(data, settings)
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
