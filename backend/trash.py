"""휴지통: 삭제를 즉시 수행하지 않고 개인 폴더의 .trash로 이동한다.

위치: users/<username>/.trash/
  - index.json : 엔트리 메타 배열
  - data/<id>/<name> : 실제 이동된 파일/폴더

엔트리: {id, orig_rel, name, is_dir, deleted_at}

.trash 는 개인 루트 바로 아래(data/ 형제)에 있으므로
목록·검색·그래프·동기화의 대상 루트에 포함되지 않는다(자동 제외).
"""
from __future__ import annotations

import shutil
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

from .auth import SessionUser
from .config import Settings
from .json_store import lock_for, read_json, write_atomic
from .storage import user_data_root

TRASH_DIRNAME = ".trash"


def _trash_root(user: SessionUser, settings: Settings) -> Path:
    root = settings.user_root(user.username) / TRASH_DIRNAME
    (root / "data").mkdir(parents=True, exist_ok=True)
    return root


def _index_path(user: SessionUser, settings: Settings) -> Path:
    return _trash_root(user, settings) / "index.json"


def move_to_trash(
    source: Path,
    orig_rel: str,
    user: SessionUser,
    settings: Settings,
) -> str:
    """source(절대경로)를 휴지통으로 이동하고 엔트리 id를 반환."""
    if not source.exists():
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다.")

    entry_id = uuid.uuid4().hex
    root = _trash_root(user, settings)
    dest_dir = root / "data" / entry_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / source.name
    shutil.move(str(source), str(dest))

    entry = {
        "id": entry_id,
        "orig_rel": orig_rel,
        "name": source.name,
        "is_dir": dest.is_dir(),
        "deleted_at": time.time(),
    }
    idx_path = _index_path(user, settings)
    with lock_for(idx_path):
        entries = read_json(idx_path, [])
        entries.append(entry)
        write_atomic(idx_path, entries)
    return entry_id


def list_trash(user: SessionUser, settings: Settings) -> list[dict]:
    entries = read_json(_index_path(user, settings), [])
    return sorted(entries, key=lambda e: e.get("deleted_at", 0), reverse=True)


def _unique_target(root: Path, rel: str) -> Path:
    """복원 위치. 이미 존재하면 이름에 ' (restored)' 접미를 붙인다."""
    target = root / rel
    if not target.exists():
        return target
    stem = target.stem
    suffix = "".join(target.suffixes)  # .md 등
    parent = target.parent
    base = stem[: -len(suffix)] if suffix and stem.endswith(suffix) else stem
    n = 1
    while True:
        cand = parent / f"{base} (restored{'' if n == 1 else ' ' + str(n)}){suffix}"
        if not cand.exists():
            return cand
        n += 1


def restore(entry_id: str, user: SessionUser, settings: Settings) -> dict:
    idx_path = _index_path(user, settings)
    with lock_for(idx_path):
        entries = read_json(idx_path, [])
        entry = next((e for e in entries if e.get("id") == entry_id), None)
        if entry is None:
            raise HTTPException(status_code=404, detail="휴지통 항목을 찾을 수 없습니다.")
        data_item = _trash_root(user, settings) / "data" / entry_id / entry["name"]
        if not data_item.exists():
            # 데이터 유실 → 인덱스에서 제거
            entries = [e for e in entries if e.get("id") != entry_id]
            write_atomic(idx_path, entries)
            raise HTTPException(status_code=410, detail="복원할 데이터가 없습니다.")

        # 문서 공간이 하나뿐이므로 원래 상대경로 그대로 되돌린다.
        # (개편 전 엔트리도 files/·notes/ 아래 같은 상대경로로 병합됐으므로 호환된다.)
        root = user_data_root(user, settings)
        target = _unique_target(root, entry["orig_rel"])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(data_item), str(target))
        shutil.rmtree(data_item.parent, ignore_errors=True)

        entries = [e for e in entries if e.get("id") != entry_id]
        write_atomic(idx_path, entries)
    return {"ok": True, "restored_to": target.relative_to(root).as_posix()}


def purge(entry_id: str, user: SessionUser, settings: Settings) -> dict:
    idx_path = _index_path(user, settings)
    with lock_for(idx_path):
        entries = read_json(idx_path, [])
        if not any(e.get("id") == entry_id for e in entries):
            raise HTTPException(status_code=404, detail="휴지통 항목을 찾을 수 없습니다.")
        shutil.rmtree(
            _trash_root(user, settings) / "data" / entry_id, ignore_errors=True
        )
        entries = [e for e in entries if e.get("id") != entry_id]
        write_atomic(idx_path, entries)
    return {"ok": True}


def empty(user: SessionUser, settings: Settings) -> dict:
    idx_path = _index_path(user, settings)
    with lock_for(idx_path):
        data_root = _trash_root(user, settings) / "data"
        shutil.rmtree(data_root, ignore_errors=True)
        data_root.mkdir(parents=True, exist_ok=True)
        write_atomic(idx_path, [])
    return {"ok": True}
