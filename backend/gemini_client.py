"""Gemini API 래퍼. 키가 없으면 우아하게 503 처리하도록 헬퍼 제공."""
from __future__ import annotations

from functools import lru_cache

from fastapi import HTTPException

from .config import get_settings

# 텍스트로 읽을 수 있는 확장자 (AI 처리 대상)
TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".py", ".js", ".ts", ".tsx", ".jsx",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".csv", ".log",
    ".html", ".css", ".xml", ".sh", ".c", ".cpp", ".h", ".java", ".go",
    ".rs", ".sql", ".env",
}

MODEL_NAME = "gemini-2.0-flash"


@lru_cache
def _model():
    """google-generativeai 모델 인스턴스 (키 없으면 503)."""
    settings = get_settings()
    if not settings.gemini_api_key:
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY가 설정되지 않았습니다. .env에 키를 추가하세요.",
        )
    try:
        import google.generativeai as genai
    except ImportError as e:  # pragma: no cover
        raise HTTPException(
            status_code=503, detail="google-generativeai 패키지가 없습니다."
        ) from e

    genai.configure(api_key=settings.gemini_api_key)
    return genai.GenerativeModel(MODEL_NAME)


def generate(prompt: str, system: str | None = None) -> str:
    """단발 프롬프트 → 텍스트 응답."""
    model = _model()
    full = f"{system}\n\n{prompt}" if system else prompt
    try:
        resp = model.generate_content(full)
        return (resp.text or "").strip()
    except HTTPException:
        raise
    except Exception as e:  # pragma: no cover - 외부 API 예외
        raise HTTPException(status_code=502, detail=f"Gemini 호출 실패: {e}") from e
