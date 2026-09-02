"""사용자 문서 저장소 경로 해석.

한 사용자의 문서는 **한 곳**에만 있다: `STORAGE_ROOT/users/<username>/data`.
(2026-08 개편 전에는 common/ · users/<u>/files · users/<u>/notes 로 나뉘어
있었고, 같은 문서를 두 페이지에서 다르게 보게 되는 원인이었다.)

경로는 항상 **세션 사용자**의 것으로만 해석되므로 다른 사용자의 문서에는
접근할 수 없다(UI·AI 공통).
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from .auth import SessionUser
from .config import Settings
from .security_paths import safe_join

logger = logging.getLogger("server.storage")


def user_data_root(user: SessionUser, settings: Settings) -> Path:
    """이 사용자의 문서 루트(없으면 생성)."""
    root = settings.user_root(user.username) / "data"
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def resolve(rel: str, user: SessionUser, settings: Settings) -> Path:
    """문서 루트 기준으로 상대경로를 안전하게 해석(루트 밖 탈출 차단)."""
    return safe_join(user_data_root(user, settings), rel)


@dataclass(frozen=True)
class WalkedFile:
    """순회로 찾은 파일 하나. stat 은 디렉터리를 읽을 때 딸려온 값이라 공짜다."""

    rel: str          # 루트 기준 상대경로(POSIX)
    path: Path
    stat: os.stat_result

    @property
    def name(self) -> str:
        return self.rel.rsplit("/", 1)[-1]


def walk_files(root: Path, *, sort: bool = True) -> list[WalkedFile]:
    """루트 아래 모든 파일을 stat 과 함께 한 번에 훑는다.

    `Path.rglob` 대신 `os.scandir` 을 쓴다. rglob 은 항목마다 Path 를 만들고
    is_file()·stat() 에서 각각 다시 파일시스템을 두드리는데, scandir 은
    디렉터리를 읽을 때 이미 받아 둔 정보를 그대로 준다.
    실측(문서 200개): rglob 78ms → scandir 3.1ms.

    심볼릭 링크인 디렉터리는 따라가지 않는다(루프 방지).
    """
    files, _ = _walk(root, want_files=True, want_dirs=False)
    if sort:
        files.sort(key=lambda f: f.rel)
    return files


def walk_dirs(root: Path, *, sort: bool = True) -> list[str]:
    """루트 아래 모든 폴더의 상대경로."""
    _, dirs = _walk(root, want_files=False, want_dirs=True)
    if sort:
        dirs.sort()
    return dirs


def walk_all(root: Path) -> tuple[list[WalkedFile], list[str]]:
    """파일과 폴더를 **한 번의 순회로** 함께. 둘 다 필요한 곳(트리 화면)이 쓴다."""
    files, dirs = _walk(root, want_files=True, want_dirs=True)
    files.sort(key=lambda f: f.rel)
    dirs.sort()
    return files, dirs


def _walk(root: Path, *, want_files: bool, want_dirs: bool):
    """공통 순회. 파일·폴더 중 필요한 것만 담는다."""
    files: list[WalkedFile] = []
    dirs: list[str] = []
    stack: list[tuple[str, str]] = [("", str(root))]
    while stack:
        rel, cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for e in it:
                    # 이름이 UTF-8로 표현되지 않는 항목은 건너뛴다. 리눅스는 파일명을
                    # 바이트로 다루므로 UTF-8이 아닌 이름이 서로게이트 이스케이프로
                    # 들어오는데, 그게 응답 JSON에 실리는 순간 인코딩이 실패해서
                    # **그 사용자의 문서 목록·트리·그래프가 통째로 500**이 됐다.
                    # 어차피 그런 이름은 경로로 주고받을 수 없어 다룰 방법도 없다.
                    try:
                        e.name.encode("utf-8")
                    except UnicodeEncodeError:
                        logger.warning("이름을 다룰 수 없어 건너뜀: %r", e.path)
                        continue
                    child = f"{rel}/{e.name}" if rel else e.name
                    try:
                        if e.is_dir(follow_symlinks=False):
                            if want_dirs:
                                dirs.append(child)
                            stack.append((child, e.path))
                        elif want_files:
                            files.append(WalkedFile(child, Path(e.path), e.stat()))
                    except OSError:
                        continue
        except OSError:
            continue
    return files, dirs
