"""스킬 공용 상수/헬퍼."""
from __future__ import annotations

_MAX_READ = 20000

# AI(외부 Gemini)로 내용이 전송되면 안 되는 민감 키워드 — 파일명/경로 기준.
SENSITIVE_KEYWORDS = {
    "비밀", "민감", "주민등록", "주민번호", "계좌", "여권", "비밀번호",
    "secret", "private", "password", "passwd", "ssn", "card", "credential",
    "token", "apikey", "api_key", ".key", ".pem",
}


def _is_sensitive(rel: str) -> bool:
    low = rel.lower()
    return any(kw.lower() in low for kw in SENSITIVE_KEYWORDS)
