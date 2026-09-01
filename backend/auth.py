"""세션 인증: 서명된 토큰 발급/검증 + FastAPI 의존성.

- 계정은 accounts 저장소(STORAGE_ROOT/accounts.json)가 단일 출처.
  active 상태가 아니면(승인 대기·거절·비활성) 토큰이 있어도 무효다.
- 토큰은 itsdangerous로 서명(SESSION_SECRET) + 발급시각 포함 → TTL 만료 강제.
- 토큰은 HttpOnly 쿠키(server_session)로 전달.
"""
from __future__ import annotations

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
    role: str = "user"
    origin: str = "signup"  # bootstrap(.env 주인) | signup

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_owner(self) -> bool:
        """.env로 만들어진 서버 주인. 관리 화면·시스템 상태·터미널·Google 연동 전용."""
        return self.origin == "bootstrap" and self.role == "admin"


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


def _verify(token: str, settings: Settings):
    """토큰 검증. 유효하면 (username, Account, 만료epoch), 아니면 None.

    계정을 함께 돌려주는 이유: 예전에는 여기서 한 번, require_session에서 또 한 번
    accounts.json을 읽었다. 인증된 요청마다 같은 파일을 두 번 읽고 두 번 파싱했고,
    그 사이에 계정이 지워지면 두 번째 조회가 None이 되어 500이 났다.
    """
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
    # 계정이 삭제됐거나 active가 아니게 되면(승인 취소·비활성) 즉시 무효
    from . import accounts

    acc = accounts.find(username, settings)
    if acc is None or not acc.can_login:
        return None
    return username, acc, ts.timestamp() + ttl


def require_session(
    request: Request, settings: Settings = Depends(get_settings)
) -> SessionUser:
    """모든 보호 라우트가 의존. 유효 세션 없으면 401."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    got = _verify(token, settings)
    if got is None:
        raise HTTPException(status_code=401, detail="세션이 만료되었거나 유효하지 않습니다.")

    _username, acc, expires_at = got
    remaining = max(0, int(expires_at - time.time()))
    return SessionUser(
        username=acc.username,
        display_name=acc.display_name,
        expires_at=expires_at,
        remaining=remaining,
        role=acc.role,
        origin=acc.origin,
    )


def require_admin(user: SessionUser = Depends(require_session)) -> SessionUser:
    """관리자 전용 라우트가 의존."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다.")
    return user


def require_owner(user: SessionUser = Depends(require_session)) -> SessionUser:
    """서버 주인(.env로 만들어진 계정) 전용 라우트가 의존.

    클라이언트에서 화면을 숨기는 것만으로는 막히지 않는다 — 서버가 거절해야 한다.
    """
    if not user.is_owner:
        raise HTTPException(status_code=403, detail="서버 관리자만 사용할 수 있습니다.")
    return user
