"""애플리케이션 설정. 환경변수(.env)로 주입."""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

try:
    # 로컬 개발 편의: backend/../.env 자동 로드 (없어도 무방)
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover - dotenv 미설치 환경
    pass

logger = logging.getLogger("server.config")


@dataclass(frozen=True)
class UserAccount:
    username: str
    password: str
    display_name: str


def _parse_users(raw: str) -> list[UserAccount]:
    """AUTH_USERS JSON 파싱. 형식: [{"username","password","display_name?"}]."""
    if not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("AUTH_USERS JSON 파싱 실패 — 로그인 불가")
        return []
    users: list[UserAccount] = []
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        u = str(item.get("username", "")).strip()
        p = str(item.get("password", ""))
        if not u or not p:
            continue
        users.append(
            UserAccount(
                username=u,
                password=p,
                display_name=str(item.get("display_name") or u),
            )
        )
    return users


class Settings:
    """환경변수 기반 설정 객체."""

    def __init__(self) -> None:
        # 저장소 루트. 하위에 common/ 과 users/<id>/ 가 생성된다.
        self.storage_root: Path = Path(
            os.getenv("STORAGE_ROOT", "/mnt/server")
        ).resolve()

        # ── 인증 ──
        # AUTH_USERS는 최초 관리자 부트스트랩 전용. 계정의 단일 출처는
        # accounts 저장소(STORAGE_ROOT/accounts.json)다.
        self.users: list[UserAccount] = _parse_users(os.getenv("AUTH_USERS", ""))
        self.session_secret: str = os.getenv("SESSION_SECRET", "")
        self.session_ttl: int = int(os.getenv("SESSION_TTL_SECONDS", "3600"))
        # HTTPS(터널/리버스프록시) 운영 시 true 권장 — 쿠키를 암호화 연결로만 전송.
        self.cookie_secure: bool = os.getenv("COOKIE_SECURE", "false").lower() in (
            "1", "true", "yes",
        )

        # ── CORS (자격증명 사용 → 와일드카드 금지) ──
        self.cors_origins: list[str] = [
            o.strip()
            for o in os.getenv(
                "CORS_ORIGINS", "http://localhost:5173,http://localhost:4173"
            ).split(",")
            if o.strip()
        ]

        # ── AI ──
        self.gemini_api_key: str | None = os.getenv("GEMINI_API_KEY") or None
        self.gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        self.ai_max_steps: int = int(os.getenv("AI_MAX_STEPS", "8"))

        # ── Google Calendar ──
        # OAuth 클라이언트는 앱 하나를 공유하고, 발급된 refresh token만
        # 사용자별로 저장한다(users/<u>/google.json).
        self.google_client_id: str = os.getenv("GOOGLE_CLIENT_ID", "").strip()
        self.google_client_secret: str = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
        self.google_redirect_uri: str = os.getenv("GOOGLE_REDIRECT_URI", "").strip()

        # ── 웹 터미널 (admin 전용, 옵트인) ──
        self.terminal_enabled: bool = os.getenv("ENABLE_TERMINAL", "false").lower() in (
            "1", "true", "yes",
        )
        self.terminal_admins: list[str] = [
            a.strip()
            for a in os.getenv("TERMINAL_ADMINS", "admin").split(",")
            if a.strip()
        ]

        # ── 운영/보안 ──
        self.debug: bool = os.getenv("DEBUG", "false").lower() in ("1", "true", "yes")
        self.max_upload_bytes: int = int(
            os.getenv("MAX_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024))
        )


    # ── 저장소 경로 헬퍼 ──
    @property
    def users_root(self) -> Path:
        return self.storage_root / "users"

    def user_root(self, username: str) -> Path:
        return self.users_root / username

    def google_config(self, username: str) -> dict | None:
        """유저별 Google Calendar 설정.

        1) 웹 OAuth로 저장된 토큰(users/<u>/google.json)을 먼저 본다.
        2) 없으면 기존 `<username>_GOOGLE_*` 환경변수로 폴백한다(하위호환).
        설정이 없으면 None → 해당 유저는 내부 캘린더를 사용한다.
        """
        from .google_oauth import load_tokens

        tokens = load_tokens(username, self)
        if tokens and tokens.get("refresh_token") and self.google_client_id:
            return {
                "service_account_json": "",
                "client_id": self.google_client_id,
                "client_secret": self.google_client_secret,
                "refresh_token": tokens["refresh_token"],
                "calendar_id": tokens.get("calendar_id") or "primary",
            }
        return self.google_env_config(username)

    def google_env_config(self, username: str) -> dict | None:
        """구 방식: `<username>_GOOGLE_*` 환경변수. 유저별로 격리된다."""
        p = f"{username}_"
        sa = os.getenv(p + "GOOGLE_SERVICE_ACCOUNT_JSON", "")
        cid = os.getenv(p + "GOOGLE_CLIENT_ID", "")
        csec = os.getenv(p + "GOOGLE_CLIENT_SECRET", "")
        rt = os.getenv(p + "GOOGLE_REFRESH_TOKEN", "")
        calid = os.getenv(p + "GOOGLE_CALENDAR_ID", "primary")
        if sa or (cid and rt):
            return {
                "service_account_json": sa,
                "client_id": cid,
                "client_secret": csec,
                "refresh_token": rt,
                "calendar_id": calid,
            }
        return None

    def ensure_storage(self) -> None:
        """저장소 루트 보장. 사용자 폴더는 계정 승인 시점에 만든다."""
        self.storage_root.mkdir(parents=True, exist_ok=True)
        self.users_root.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
