"""스코프 기반 저장소 경로 해석.

스코프:
  - common : 모든 사용자 공유 공간  (STORAGE_ROOT/common)
  - me     : 로그인 사용자의 개인 파일 (STORAGE_ROOT/users/<username>/files)

개인 스코프는 항상 **세션 사용자**의 username으로만 해석되므로,
다른 사용자의 폴더에는 접근할 수 없다(UI·AI 공통).
"""
from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

from .auth import SessionUser
from .config import Settings
from .security_paths import safe_join, to_rel

VALID_SCOPES = ("common", "me")


def scope_root(scope: str, user: SessionUser, settings: Settings) -> Path:
    """스코프의 실제 디스크 루트 반환(없으면 생성)."""
    if scope == "common":
        root = settings.common_root
    elif scope == "me":
        root = settings.user_root(user.username) / "files"
    else:
        raise HTTPException(status_code=400, detail="잘못된 스코프입니다.")
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def notes_root(scope: str, user: SessionUser, settings: Settings) -> Path:
    """노트 전용 루트. common/notes 또는 users/<u>/notes."""
    if scope == "common":
        root = settings.common_root / "notes"
    elif scope == "me":
        root = settings.user_root(user.username) / "notes"
    else:
        raise HTTPException(status_code=400, detail="잘못된 스코프입니다.")
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def resolve(scope: str, rel: str, user: SessionUser, settings: Settings) -> Path:
    """파일 스코프 내에서 상대경로를 안전하게 해석."""
    return safe_join(scope_root(scope, user, settings), rel)


def rel_of(scope: str, target: Path, user: SessionUser, settings: Settings) -> str:
    return to_rel(scope_root(scope, user, settings), target)
