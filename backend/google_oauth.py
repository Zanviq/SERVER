"""Google OAuth 연동 — 사용자별 refresh token 발급·보관.

개편 전에는 사용자가 직접 구글에서 refresh token을 받아 .env에 유저별 접두사로
넣어야 했다. 이제 웹에서 동의 한 번으로 끝난다.

OAuth 클라이언트(client_id/secret)는 앱 하나를 공유하고, 발급된 토큰만
사용자별로 users/<username>/google.json 에 저장한다.
"""
from __future__ import annotations

import json
import logging
import time
import urllib.parse
import urllib.request
from pathlib import Path

from fastapi import HTTPException
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import Settings
from .json_store import lock_for, read_json, write_atomic

logger = logging.getLogger("server.google")

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo"
SCOPES = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email"

_STATE_SALT = "google-oauth-state-v1"
_STATE_MAX_AGE = 600  # 10분


def _store_path(username: str, settings: Settings) -> Path:
    return settings.user_root(username) / "google.json"


def load_tokens(username: str, settings: Settings) -> dict | None:
    return read_json(_store_path(username, settings), None)


def save_tokens(username: str, data: dict, settings: Settings) -> None:
    p = _store_path(username, settings)
    with lock_for(p):
        write_atomic(p, data)


def disconnect(username: str, settings: Settings) -> None:
    p = _store_path(username, settings)
    with lock_for(p):
        p.unlink(missing_ok=True)


def is_configured(settings: Settings) -> bool:
    """앱 수준 OAuth 클라이언트가 설정돼 있는가."""
    return bool(settings.google_client_id and settings.google_client_secret)


def _require_config(settings: Settings) -> None:
    if not is_configured(settings):
        raise HTTPException(
            status_code=503,
            detail="서버에 GOOGLE_CLIENT_ID/SECRET이 설정되지 않았습니다.",
        )
    if not settings.google_redirect_uri:
        raise HTTPException(
            status_code=503, detail="서버에 GOOGLE_REDIRECT_URI가 설정되지 않았습니다."
        )


def _serializer(settings: Settings) -> URLSafeTimedSerializer:
    if not settings.session_secret:
        raise HTTPException(status_code=503, detail="SESSION_SECRET이 설정되지 않았습니다.")
    return URLSafeTimedSerializer(settings.session_secret, salt=_STATE_SALT)


def make_state(username: str, settings: Settings) -> str:
    """CSRF 방지 — 사용자명을 서명해 담는다(콜백에서 세션 사용자와 대조)."""
    return _serializer(settings).dumps({"u": username})


def verify_state(state: str, settings: Settings) -> str:
    """유효하면 서명된 사용자명 반환. 위조·만료면 400."""
    try:
        data = _serializer(settings).loads(state, max_age=_STATE_MAX_AGE)
    except SignatureExpired as e:
        raise HTTPException(status_code=400, detail="연동 요청이 만료되었습니다. 다시 시도하세요.") from e
    except BadSignature as e:
        raise HTTPException(status_code=400, detail="잘못된 연동 요청입니다.") from e
    username = (data or {}).get("u")
    if not username:
        raise HTTPException(status_code=400, detail="잘못된 연동 요청입니다.")
    return username


def auth_url(username: str, settings: Settings) -> str:
    _require_config(settings)
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        # refresh token을 받으려면 둘 다 필요하다. prompt를 빼면 이미 동의한
        # 계정에서는 refresh token이 오지 않아 연동이 조용히 반쪽이 된다.
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": make_state(username, settings),
    }
    return f"{AUTH_ENDPOINT}?{urllib.parse.urlencode(params)}"


def _post_form(url: str, form: dict, timeout: int = 15) -> dict:
    body = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - 고정 엔드포인트
        return json.loads(resp.read().decode("utf-8"))


def _get_json(url: str, access_token: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


def exchange_code(code: str, username: str, settings: Settings) -> dict:
    """인가 코드를 refresh token으로 교환해 저장하고, 저장된 값을 돌려준다."""
    _require_config(settings)
    try:
        tok = _post_form(
            TOKEN_ENDPOINT,
            {
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": settings.google_redirect_uri,
                "grant_type": "authorization_code",
            },
        )
    except Exception as e:  # noqa: BLE001 - 외부 호출
        logger.exception("Google 토큰 교환 실패")
        raise HTTPException(status_code=502, detail="Google 토큰 교환에 실패했습니다.") from e

    refresh = tok.get("refresh_token")
    if not refresh:
        # prompt=consent를 줬는데도 없으면 사용자가 재동의를 건너뛴 경우
        raise HTTPException(
            status_code=400,
            detail="refresh token을 받지 못했습니다. Google 계정 설정에서 이 앱의 권한을 해제한 뒤 다시 시도하세요.",
        )

    email = ""
    try:
        email = _get_json(USERINFO_ENDPOINT, tok.get("access_token", "")).get("email", "")
    except Exception:  # noqa: BLE001 - 이메일은 표시용이라 실패해도 진행
        logger.warning("Google 사용자 정보 조회 실패(연동은 계속)")

    prev = load_tokens(username, settings) or {}
    data = {
        "refresh_token": refresh,
        "calendar_id": prev.get("calendar_id") or "primary",
        "email": email,
        "connected_at": time.time(),
    }
    save_tokens(username, data, settings)
    return data


def status(username: str, settings: Settings) -> dict:
    tokens = load_tokens(username, settings)
    env_configured = settings.google_env_config(username) is not None
    return {
        "server_ready": is_configured(settings) and bool(settings.google_redirect_uri),
        "connected": bool(tokens) or env_configured,
        "via": "oauth" if tokens else ("env" if env_configured else None),
        "email": (tokens or {}).get("email", ""),
        "calendar_id": (tokens or {}).get("calendar_id", "primary"),
        "connected_at": (tokens or {}).get("connected_at"),
    }
