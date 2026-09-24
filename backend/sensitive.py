"""민감 문서 판정 — 이 문서의 **내용을 외부 모델(Gemini)로 보내도 되는가.**

파일 이름·경로에 아래 낱말이 들어 있으면 내용을 모델에게 보내지 않는다. 판정은 이
한 곳에서만 한다 — AI 문서 스킬, 링크 풀기, 전체 검색이 같은 규칙을 써야 한 길로는
막혀 있는데 옆길로 새는 일이 없다.

예전에는 이 규칙이 `ai/skills/_common.py` 안에 있어서, 링크 모듈이 이 함수 하나를 쓰려고
AI 스킬 묶음 전체(`ai/skills/__init__`)를 불러왔다. 스킬 하나가 import 에 실패하면 링크
열기까지 500 이 됐다(실측: 개발 서버가 옛 모듈을 물고 있을 때).
"""
from __future__ import annotations

#: 파일명·경로에 이 낱말이 있으면 민감 문서로 본다(대소문자 무시).
SENSITIVE_KEYWORDS = {
    "비밀", "민감", "주민등록", "주민번호", "계좌", "여권", "비밀번호",
    "secret", "private", "password", "passwd", "ssn", "card", "credential",
    "token", "apikey", "api_key", ".key", ".pem",
    # .env는 file_kinds에서 'text'로 분류돼 읽기가 가능하다(UI 편집은 되어야 하므로
    # 그대로 둔다). AI로 내보내는 것만 여기서 막는다.
    ".env",
}


def is_sensitive(rel: str) -> bool:
    """이 경로의 내용을 모델에게 보내면 안 되는가."""
    low = rel.lower()
    return any(kw.lower() in low for kw in SENSITIVE_KEYWORDS)
