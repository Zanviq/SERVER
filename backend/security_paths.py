"""사용자 입력 경로를 안전하게 저장소 루트 내부로 한정하는 유틸.

핵심: 클라이언트가 보낸 상대경로(`a/b.txt`, `../../etc/passwd` 등)를
무조건 storage_root 하위로만 해석하고, 루트를 벗어나면 거부한다.
"""
from __future__ import annotations

import re
from pathlib import Path, PurePosixPath

from fastapi import HTTPException

#: 파일 이름에 쓸 수 없는 문자. 널바이트와 제어문자가 그대로 통과하면
#: os 계층에서 ValueError/OSError가 나 500이 됐다(사용자 입력인데 서버 오류다).
_BAD_CHARS = re.compile(r"[\x00-\x1f\x7f]")

#: 한 구성요소의 최대 길이. ext4·APFS 모두 파일명은 255**바이트**가 한계라,
#: 한글 300자는 900바이트가 되어 OSError로 500이 났다.
_MAX_COMPONENT_BYTES = 200

#: 문서 루트 기준 **전체** 경로의 최대 길이(75차). 칸마다 200바이트 안이어도 25겹을 쌓으면 4.5KB 가 되어 리눅스의
#: 경로 한계(4096바이트, 루트 앞부분 포함)를 넘는다 — 그러면 OS 가 거절한 것을 디스크 탈이로 읽어 500 "외장하드가
#: 빠졌는지 확인하세요" 가 났다(실측). 한글 폴더 열 겹도 1KB 안이라 실제 쓰임에는 넉넉하다.
_MAX_PATH_BYTES = 1024


def safe_join(root: Path, rel: str) -> Path:
    """root 기준으로 rel을 해석하되 root를 벗어나면 400 에러.

    Args:
        root: 절대경로로 resolve된 저장소 루트.
        rel: 클라이언트가 보낸 상대경로 (POSIX 스타일 권장).

    Returns:
        root 하위로 보장된 절대 Path.
    """
    target = (root / _clean_rel(rel)).resolve()

    # resolve 후에도 루트 내부인지 최종 검증 (심볼릭 링크 대비).
    if root != target and root not in target.parents:
        raise HTTPException(status_code=400, detail="저장소 범위를 벗어난 경로입니다.")

    return target


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def _clean_rel(rel: str) -> PurePosixPath:
    """사용자가 보낸 상대경로를 검사해 POSIX 경로로 — 파일시스템을 건드리기 **전에** 사용자 입력 오류를 모두 400 으로.
    여기서 거르지 못한 것은 OS 오류가 되어 500(디스크 탈이처럼 보이는 말)으로 나간다(75차가 그런 경우였다)."""
    raw = str(rel or "")
    if _BAD_CHARS.search(raw):
        raise _bad("이름에 쓸 수 없는 문자가 있습니다.")

    # 짝 없는 서로게이트(\ud800 등)는 UTF-8로 인코딩할 수 없다. 그대로 두면 아래
    # 길이 검사나 파일시스템 호출에서 UnicodeEncodeError 가 그대로 올라가 500이 됐다
    # (get·raw·folder 세 곳 모두, 실측). 사용자 입력 오류이므로 여기서 400으로 끊는다.
    try:
        raw.encode("utf-8")
    except UnicodeEncodeError as e:
        raise _bad("이름에 쓸 수 없는 문자가 있습니다.") from e

    # 항상 POSIX 구분자로 정규화하고 선행 슬래시 제거.
    rel_clean = PurePosixPath(raw.replace("\\", "/").lstrip("/"))

    # '..' 세그먼트는 명시적으로 차단 (심볼릭/상대 탈출 방지).
    if any(part == ".." for part in rel_clean.parts):
        raise _bad("잘못된 경로입니다 ('..' 불가).")
    if any(len(part.encode("utf-8")) > _MAX_COMPONENT_BYTES for part in rel_clean.parts):
        raise _bad(f"이름이 너무 깁니다(최대 {_MAX_COMPONENT_BYTES}바이트).")
    if len(str(rel_clean).encode("utf-8")) > _MAX_PATH_BYTES:
        raise _bad(f"경로가 너무 깁니다(최대 {_MAX_PATH_BYTES}바이트) — 폴더를 덜 깊게 두거나 이름을 줄여 주세요.")
    return rel_clean


def to_rel(root: Path, target: Path) -> str:
    """저장소 루트 기준 상대경로 문자열(POSIX)로 변환."""
    return target.relative_to(root).as_posix()
