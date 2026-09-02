"""파일 종류 분류 — 프런트가 어떤 뷰어를 쓸지 정하는 기준.

노트 페이지가 문서 공간 전체를 다루므로, 마크다운뿐 아니라 이미지·PDF·미디어도
같은 트리에서 열린다. 분류를 백엔드가 내려주면 프런트가 확장자 목록을 따로
관리하지 않아도 된다(두 곳이 어긋나는 것을 막는다).
"""
from __future__ import annotations

import re
from pathlib import Path

MARKDOWN = {".md", ".markdown"}

# CodeMirror로 편집 가능한 평문. 확장자가 없으면 텍스트로 본다.
TEXT = {
    ".txt", ".text", ".log", ".csv", ".tsv",
    ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env",
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".css", ".scss", ".html", ".htm", ".xml", ".svg",
    ".sh", ".bash", ".zsh", ".ps1", ".bat",
    ".sql", ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".go", ".rs", ".rb", ".php",
    ".gitignore", ".dockerignore",
}

IMAGE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".ico", ".svg"}
PDF = {".pdf"}
VIDEO = {".mp4", ".webm", ".ogv", ".mov", ".m4v"}
AUDIO = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"}

# 브라우저에 그대로 표시해도 되는 종류의 MIME (inline 응답용)
_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".avif": "image/avif", ".ico": "image/x-icon", ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg",
    ".mov": "video/quicktime", ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
    ".opus": "audio/opus",
}


#: 확장자로 볼 꼬리 — 글자가 하나는 있어야 한다.
#: `2026.08`·`v1.2` 는 확장자가 아니다(날짜·버전을 확장자로 보면 이름이 망가진다).
_EXT_RE = re.compile(r"\.(?=[A-Za-z0-9]{1,8}$)[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$")


def looks_like_extension(name: str) -> bool:
    """이름의 꼬리가 확장자인가.

    **이 판단은 여기 한 곳에만 둔다.** 예전에는 같은 정규식이 세 파일에 복사돼
    있었고, 네 번째 자리(휴지통 복원)가 Path.suffixes 라는 다른 규칙을 쓰는 바람에
    `2026.08 회고` 의 확장자를 `.08 회고` 로 보고 이름을 망가뜨렸다.
    """
    return bool(_EXT_RE.search(name.rsplit("/", 1)[-1]))


def split_ext(name: str) -> tuple[str, str]:
    """이름을 (몸통, 확장자)로 나눈다. 확장자로 볼 수 없으면 확장자는 빈 문자열."""
    tail = name.rsplit("/", 1)[-1]
    m = _EXT_RE.search(tail)
    return (name[: len(name) - len(tail) + m.start()], tail[m.start():]) if m else (name, "")


def kind_of(name: str) -> str:
    """'md' | 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'other'."""
    ext = Path(name).suffix.lower()
    if ext in MARKDOWN:
        return "md"
    # .svg는 이미지이면서 텍스트지만, 보는 쪽이 자연스러우므로 이미지로 둔다.
    if ext in IMAGE:
        return "image"
    if ext in PDF:
        return "pdf"
    if ext in VIDEO:
        return "video"
    if ext in AUDIO:
        return "audio"
    if ext in TEXT or ext == "":
        return "text"
    return "other"


def is_editable(name: str) -> bool:
    """텍스트 편집기로 열 수 있는가(자동저장 대상)."""
    return kind_of(name) in ("md", "text")


def inline_media_type(name: str) -> str | None:
    """브라우저에 인라인으로 보여줄 수 있으면 그 MIME, 아니면 None(다운로드)."""
    return _MIME.get(Path(name).suffix.lower())
