"""Markdown 원자적 저장 + .history 백업."""
from __future__ import annotations

import hashlib
import os
import threading
import time

from ..config import Settings
from .errors import NotFound, StorageError
from .paths import resolve_rel


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read(settings: Settings, storage_path: str) -> str:
    p = resolve_rel(settings, storage_path)
    if not p.is_file():
        raise NotFound("문서 파일이 없습니다.")
    return p.read_text(encoding="utf-8", errors="replace")


def _atomic_write(target, content: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + f".tmp{os.getpid()}-{threading.get_ident()}")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        # os.replace는 POSIX에선 원자적이지만 Windows에선 대상 파일이 동시 읽기로 열려 있으면
        # PermissionError(WinError 5)가 날 수 있어 짧게 재시도(리눅스에선 사실상 미발생).
        for attempt in range(6):
            try:
                os.replace(tmp, target)
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.02)
    except OSError as e:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise StorageError(f"파일 저장 실패: {e}") from e


def write_new(settings: Settings, storage_path: str, content: str) -> None:
    _atomic_write(resolve_rel(settings, storage_path), content)


def backup_and_write(settings, doc_id, storage_path, new_content, old_content, version) -> str:
    """기존본을 .history에 저장 후 새 내용으로 원자 교체. history 상대경로 반환."""
    hist_rel = f".history/{doc_id}/{version:04d}.md"
    _atomic_write(resolve_rel(settings, hist_rel), old_content)  # 이전본 백업
    _atomic_write(resolve_rel(settings, storage_path), new_content)  # 현재 교체
    return hist_rel


def move_file(settings: Settings, src_rel: str, dst_rel: str) -> None:
    src = resolve_rel(settings, src_rel)
    dst = resolve_rel(settings, dst_rel)
    if not src.exists():
        raise NotFound("이동할 파일이 없습니다.")
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.replace(src, dst)
