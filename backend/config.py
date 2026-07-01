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
            os.getenv("STORAGE_ROOT", "/mnt/hdd")
        ).resolve()

        # ── 인증 ──
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

        # ── Google Calendar (선택, 유저별) ──
        # 환경변수는 유저 아이디 접두사로 구분한다. 예) admin_GOOGLE_CLIENT_ID
        # 접두사 없는 값은 사용하지 않음 → 유저별 캘린더 격리.

        # ── 운영/보안 ──
        self.debug: bool = os.getenv("DEBUG", "false").lower() in ("1", "true", "yes")
        self.max_upload_bytes: int = int(
            os.getenv("MAX_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024))
        )

    # ── 저장소 경로 헬퍼 ──
    @property
    def common_root(self) -> Path:
        return self.storage_root / "common"

    @property
    def users_root(self) -> Path:
        return self.storage_root / "users"

    def user_root(self, username: str) -> Path:
        return self.users_root / username

    def find_user(self, username: str) -> UserAccount | None:
        for u in self.users:
            if u.username == username:
                return u
        return None

    def google_config(self, username: str) -> dict | None:
        """유저별 Google Calendar 설정. `<username>_GOOGLE_*` 환경변수에서 읽는다.

        설정이 없으면 None → 해당 유저는 내부 캘린더를 사용한다.
        다른 유저의 설정에는 접근하지 않는다(격리).
        """
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
        """공통 폴더 + 모든 사용자 개인 폴더 골격 생성."""
        self.common_root.mkdir(parents=True, exist_ok=True)
        for acc in self.users:
            base = self.user_root(acc.username)
            for sub in ("files", "notes", "calendar", "ai/logs"):
                (base / sub).mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
