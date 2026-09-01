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
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def write_text_atomic(path: Path, text: str) -> None:
    """텍스트를 원자적으로 쓴다(같은 디렉터리 임시파일 + os.replace).

    문서 저장이 plain write_text였다. 쓰는 도중 죽으면 파일이 잘린 채 남고,
    같은 문서에 두 요청이 겹치면 서로를 덮어썼다.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}.{uuid.uuid4().hex[:8]}")
    try:
        with tmp.open("w", encoding="utf-8") as f:
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
    except (json.JSONDecodeError, OSError):
        return default
