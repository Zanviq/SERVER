"""사용자 입력 경로를 안전하게 저장소 루트 내부로 한정하는 유틸.

핵심: 클라이언트가 보낸 상대경로(`a/b.txt`, `../../etc/passwd` 등)를
무조건 storage_root 하위로만 해석하고, 루트를 벗어나면 거부한다.
"""
from __future__ import annotations

from pathlib import Path, PurePosixPath

from fastapi import HTTPException


def safe_join(root: Path, rel: str) -> Path:
    """root 기준으로 rel을 해석하되 root를 벗어나면 400 에러.

    Args:
        root: 절대경로로 resolve된 저장소 루트.
        rel: 클라이언트가 보낸 상대경로 (POSIX 스타일 권장).

    Returns:
        root 하위로 보장된 절대 Path.
    """
    # 항상 POSIX 구분자로 정규화하고 선행 슬래시 제거.
    rel_clean = PurePosixPath(rel.replace("\\", "/").lstrip("/"))

    # '..' 세그먼트는 명시적으로 차단 (심볼릭/상대 탈출 방지).
    if any(part == ".." for part in rel_clean.parts):
        raise HTTPException(status_code=400, detail="잘못된 경로입니다 ('..' 불가).")

    target = (root / rel_clean).resolve()

    # resolve 후에도 루트 내부인지 최종 검증 (심볼릭 링크 대비).
    if root != target and root not in target.parents:
        raise HTTPException(status_code=400, detail="저장소 범위를 벗어난 경로입니다.")

    return target


def to_rel(root: Path, target: Path) -> str:
    """저장소 루트 기준 상대경로 문자열(POSIX)로 변환."""
    return target.relative_to(root).as_posix()
