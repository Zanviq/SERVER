"""애플리케이션 설정. 환경변수(.env)로 주입."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


class Settings:
    """환경변수 기반 설정 객체."""

    def __init__(self) -> None:
        # 사용자 파일이 저장되는 루트. 라즈베리파이에선 /mnt/hdd,
        # 로컬 개발(Windows)에선 ./data 등으로 오버라이드.
        self.storage_root: Path = Path(
            os.getenv("STORAGE_ROOT", "/mnt/hdd")
        ).resolve()

        # CORS 허용 오리진 (콤마 구분). 개발 중엔 * 허용.
        self.cors_origins: list[str] = [
            o.strip()
            for o in os.getenv("CORS_ORIGINS", "*").split(",")
            if o.strip()
        ]

        # Gemini API 키 (3단계에서 사용).
        self.gemini_api_key: str | None = os.getenv("GEMINI_API_KEY")

        # 업로드 1건 최대 크기 (바이트). 기본 2GB.
        self.max_upload_bytes: int = int(
            os.getenv("MAX_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024))
        )

    def ensure_storage(self) -> None:
        """저장소 루트가 없으면 생성."""
        self.storage_root.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
