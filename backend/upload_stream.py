"""올린 바이트를 받는 한 가지 길 — 문서·회의 녹음·논문 올리기가 같이 쓴다.

세 곳이 같은 고리(임시 파일에 1MB 씩 받기, 한도 넘으면 413, 실패하면 임시 파일 치우기)를 세 벌 들고
있었다. 한 곳만 고치면(한도 비교·임시 이름·치우기) 올리는 곳마다 규칙이 갈린다.

대상 파일을 곧바로 열지 않는 까닭: 열자마자 자르면 도중에 실패했을 때(크기 초과·연결 끊김) 원래 있던
파일이 사라진다. 그래서 옆에 임시로 받고, 갈아 끼우기(os.replace)는 부르는 쪽이 검사를 마친 뒤 한다 —
검사(PDF 머리·빈 파일)와 실패 때 치울 것(항목 폴더째)이 곳마다 다르다.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

CHUNK = 1024 * 1024


async def receive(file: UploadFile, dest: Path, limit: int, too_big: str) -> tuple[Path, int, bytes]:
    """dest 옆 임시 파일에 받는다. (임시 파일, 받은 크기, 앞 8바이트). 한도를 넘으면 413(too_big).

    예외가 나면 임시 파일은 여기서 지운다. 돌려준 뒤의 임시 파일은 부르는 쪽 몫이다.
    """
    tmp = dest.with_name(f"{dest.name}.upload{os.getpid()}.{uuid.uuid4().hex[:8]}")
    written = 0
    head = b""
    try:
        with tmp.open("wb") as out:
            while chunk := await file.read(CHUNK):
                if not head:
                    head = chunk[:8]
                written += len(chunk)
                if written > limit:
                    raise HTTPException(status_code=413, detail=too_big)
                out.write(chunk)
    except BaseException:
        # OSError 만 잡으면 다른 예외(413·연결 끊김)에서 임시 파일이 영구히 남는다
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return tmp, written, head
