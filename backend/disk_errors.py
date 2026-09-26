"""저장소(디스크) 문제에 이름 붙이기 — 어느 쓰기에서 나든 같은 말로.

그냥 500 "internal server error" 로 내보내면 사용자는 "왜 저장이 안 되지"만 알고, 정작 할 일
(공간 비우기·권한 고치기)을 모른다. 라즈베리파이에서 실제로 마주칠 수 있는 것들이다(외장하드가
빠지거나 가득 찬다).

예전엔 이 표가 main 의 마지막 처리기에만 있었다. 그런데 문서 저장·올리기·이름 바꾸기·폴더 만들기는
제 안에서 OSError 를 먼저 잡아 "문서 저장에 실패했습니다."(500)로 바꿨다 — 가장 흔한 쓰기에서
까닭이 사라졌다(53차). 이제 둘 다 여기를 부른다.
"""
from __future__ import annotations

import errno

from fastapi import HTTPException

_DISK_TROUBLE = {
    errno.ENOSPC: "저장 공간이 가득 찼습니다. 휴지통을 비우거나 큰 파일을 지워 주세요.",
    errno.EDQUOT: "저장 공간 할당량을 넘었습니다.",
    errno.EROFS: "저장소가 읽기 전용입니다(디스크가 잘못 붙었을 수 있습니다).",
    errno.EACCES: "저장소에 쓸 권한이 없습니다.",
    errno.EPERM: "저장소에 쓸 권한이 없습니다.",
    errno.ENOENT: "저장 폴더를 찾을 수 없습니다(외장하드가 빠졌는지 확인하세요).",
    errno.EIO: "저장소를 읽고 쓰는 중 오류가 났습니다(디스크를 확인하세요).",
}


def disk_trouble(exc: BaseException) -> HTTPException | None:
    """디스크 문제면 사용자에게 보일 응답(가득 참은 507), 아니면 None."""
    if isinstance(exc, OSError) and exc.errno == errno.ENAMETOOLONG:
        # 디스크 탈이 아니라 이름·경로가 긴 것이다 — 사용자가 고칠 수 있다(75차). 경로는 safe_join 이 먼저 막지만
        # 그 밖의 길(다른 저장소의 이름 등)에서도 "외장하드" 경보 대신 이 말이 나가게 둔다.
        return HTTPException(status_code=400, detail="이름이나 경로가 너무 깁니다 — 줄여 주세요.")
    if isinstance(exc, OSError) and exc.errno in _DISK_TROUBLE:
        return HTTPException(status_code=507 if exc.errno == errno.ENOSPC else 500,
                             detail=_DISK_TROUBLE[exc.errno])
    return None
