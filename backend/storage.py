"""사용자 문서 저장소 경로 해석.

한 사용자의 문서는 **한 곳**에만 있다: `STORAGE_ROOT/users/<username>/data`.
(2026-08 개편 전에는 common/ · users/<u>/files · users/<u>/notes 로 나뉘어
있었고, 같은 문서를 두 페이지에서 다르게 보게 되는 원인이었다.)

경로는 항상 **세션 사용자**의 것으로만 해석되므로 다른 사용자의 문서에는
접근할 수 없다(UI·AI 공통).
"""
from __future__ import annotations

from pathlib import Path

from .auth import SessionUser
from .config import Settings
from .security_paths import safe_join


def user_data_root(user: SessionUser, settings: Settings) -> Path:
    """이 사용자의 문서 루트(없으면 생성)."""
    root = settings.user_root(user.username) / "data"
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def resolve(rel: str, user: SessionUser, settings: Settings) -> Path:
    """문서 루트 기준으로 상대경로를 안전하게 해석(루트 밖 탈출 차단)."""
    return safe_join(user_data_root(user, settings), rel)
