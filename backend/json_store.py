"""JSON 파일 원자적 쓰기 + 경로별 락.

동시 요청(예: AI가 일정 생성 + UI가 설정 저장)에서의 lost-update와
쓰기 도중 크래시로 인한 파일 손상을 방지한다.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

from . import doc_cache

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def lock_for(path: Path) -> threading.Lock:
    key = str(path.resolve())
    with _locks_guard:
        lk = _locks.get(key)
        if lk is None:
            lk = threading.Lock()
            _locks[key] = lk
        return lk


def write_atomic(path: Path, data) -> None:
    """같은 디렉토리 임시파일에 쓴 뒤 os.replace로 원자 교체."""
    path.parent.mkdir(parents=True, exist_ok=True)
    # 이름이 PID만이면 같은 프로세스의 스레드끼리 같은 임시파일을 쓴다
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}.{uuid.uuid4().hex[:8]}")
    try:
        # 위와 같은 이유(들여쓰기 줄바꿈이 플랫폼마다 달라진다)
        with tmp.open("w", encoding="utf-8", newline="") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        # 문서 저장과 같은 재시도를 쓴다. 여기만 맨 os.replace 였는데, Windows 에서
        # 같은 파일을 동시에 읽는 요청이 있으면 PermissionError(WinError 5)가 나서
        # **할 일 삭제가 500으로 실패하고 휴지통에는 미아가 남았다**(24건 동시 삭제
        # 12회 중 1회 재현). 할 일·일정·계정·설정·휴지통 인덱스가 전부 이 함수를 쓴다.
        _replace_with_retry(tmp, path)
    except BaseException:
        # 실패했으면 임시파일을 남기지 않는다(다음 순회·목록에 쓰레기로 보인다)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def write_text_atomic(path: Path, text: str) -> None:
    """텍스트를 원자적으로 쓴다(같은 디렉터리 임시파일 + os.replace).

    문서 저장이 plain write_text였다. 쓰는 도중 죽으면 파일이 잘린 채 남고,
    같은 문서에 두 요청이 겹치면 서로를 덮어썼다.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}.{uuid.uuid4().hex[:8]}")
    try:
        # newline="" 이 없으면 파이썬이 줄바꿈을 os.linesep 으로 바꿔 쓴다.
        # Windows 에서 `\n` 은 `\r\n` 이 되고, 이미 `\r\n` 인 글은 `\r\r\n` 이 되어
        # **저장할 때마다 불어난다**(무작위 왕복 검사에서 300건 중 202건).
        # 사용자가 쓴 바이트를 그대로 남기는 것이 문서 저장의 기본이다.
        with tmp.open("w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        _replace_with_retry(tmp, path)
        # 담아 둔 옛 본문을 버린다. doc_cache는 mtime·크기로도 무효화하지만,
        # 파일시스템 시각 해상도가 거친 곳에서는 짧은 간격의 두 번 저장이 같은
        # mtime을 받을 수 있다(길이까지 같으면 옛 내용이 남는다).
        doc_cache.invalidate(path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _replace_with_retry(tmp: Path, path: Path, tries: int = 5) -> None:
    """os.replace 재시도.

    Windows에서는 백신·인덱서가 파일을 잠깐 잡고 있으면 PermissionError가 난다
    (실측: 동시 20건 중 1건). 리눅스에서는 나지 않지만, 재시도가 있으면 그 한 건이
    조용히 실패하는 대신 정상 저장된다.
    """
    for attempt in range(tries):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == tries - 1:
                raise
            time.sleep(0.02 * (attempt + 1))


def read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        # UnicodeDecodeError 도 잡는다. 안 잡으면 CP949 로 저장된 파일 하나가
        # 날 예외로 새어, 기동(lifespan)에서 부르는 자리에서는 서버가 아예 못 뜬다.
        return default


def read_json_strict(path: Path, default):
    """읽되, **있는데 못 읽으면 예외**를 낸다.

    read_json 은 깨진 파일에도 기본값을 준다. 그러면 조회는 빈 목록을 200으로
    돌려주고, 그다음에 하나만 추가해도 그 빈 목록 위에 써서 원본이 통째로
    사라진다. 사용자 데이터를 담은 파일은 이 쪽을 써야 한다.
    """
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise HTTPException(
            status_code=503,
            detail=f"저장 파일을 읽을 수 없습니다({path.name}). 손상됐을 수 있어 아무것도 덮어쓰지 않았습니다.",
        ) from e
    except OSError as e:
        raise HTTPException(
            status_code=503, detail=f"저장 파일을 열 수 없습니다({path.name})."
        ) from e
