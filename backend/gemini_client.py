"""AI 관련 공용 상수.

Gemini 호출은 ai/orchestrator.py(google-genai 신 SDK)에서 처리한다.
여기서는 텍스트로 읽을 수 있는 확장자 집합만 제공한다.
"""
from __future__ import annotations

# 텍스트로 읽을 수 있는 확장자 (AI 읽기/요약 대상)
TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".py", ".js", ".ts", ".tsx", ".jsx",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".csv", ".log",
    ".html", ".css", ".xml", ".sh", ".c", ".cpp", ".h", ".java", ".go",
    ".rs", ".sql", ".env",
}
