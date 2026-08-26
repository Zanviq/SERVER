"""휴지통: 삭제를 즉시 수행하지 않고 개인 폴더의 .trash로 이동한다.

위치: users/<username>/.trash/
  - index.json : 엔트리 메타 배열
  - data/<id>/<name> : 실제 이동된 파일/폴더

엔트리: {id, kind, orig_rel, name, is_dir, deleted_at}

kind 는 휴지통을 갈래별로 보기 위한 것이다.
  - "document" : 파일/폴더. data/<id>/<name> 에 실물이 들어 있다.
  - "event"    : 캘린더 일정. 파일이 아니라 data/<id>/event.json 에 내용을 적어 둔다.
kind 가 없는 예전 엔트리는 문서로 본다(기존 휴지통이 비지 않도록).

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

KIND_DOCUMENT = "document"
KIND_EVENT = "event"
EVENT_FILE = "event.json"


def entry_kind(entry: dict) -> str:
    """kind 가 없는 예전 엔트리는 문서다."""
    return str(entry.get("kind") or KIND_DOCUMENT)


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
        "kind": KIND_DOCUMENT,
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


def move_event_to_trash(event: dict, user: SessionUser, settings: Settings) -> str:
    """캘린더 일정을 휴지통에 넣는다(파일이 아니라 내용을 적어 둔다)."""
    entry_id = uuid.uuid4().hex
    dest_dir = _trash_root(user, settings) / "data" / entry_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    write_atomic(dest_dir / EVENT_FILE, event)

    entry = {
        "id": entry_id,
        "kind": KIND_EVENT,
        "orig_rel": "",  # 문서 전용 필드 — 일정은 되돌릴 경로가 없다
        "name": str(event.get("title") or "(제목 없음)"),
        "is_dir": False,
        "deleted_at": time.time(),
        # 목록에서 언제/무슨 색 일정이었는지 보이도록
        "event_start": str(event.get("start", "")),
        "event_color": str(event.get("color", "")),
    }
    idx_path = _index_path(user, settings)
    with lock_for(idx_path):
        entries = read_json(idx_path, [])
        entries.append(entry)
        write_atomic(idx_path, entries)
    return entry_id


def list_trash(user: SessionUser, settings: Settings, kind: str = "") -> list[dict]:
    entries = read_json(_index_path(user, settings), [])
    if kind:
        entries = [e for e in entries if entry_kind(e) == kind]
    # kind 가 없던 엔트리도 응답에는 채워서 준다(프런트가 분기 하나로 끝나도록)
    for e in entries:
        e["kind"] = entry_kind(e)
    return sorted(entries, key=lambda e: e.get("deleted_at", 0), reverse=True)


def counts_by_kind(user: SessionUser, settings: Settings) -> dict:
    """갈래별 개수 — 휴지통 탭에 숫자를 띄우기 위한 것."""
    entries = read_json(_index_path(user, settings), [])
    out = {KIND_DOCUMENT: 0, KIND_EVENT: 0}
    for e in entries:
        k = entry_kind(e)
        out[k] = out.get(k, 0) + 1
    out["all"] = len(entries)
    return out


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

        if entry_kind(entry) == KIND_EVENT:
            src = _trash_root(user, settings) / "data" / entry_id / EVENT_FILE
            payload = read_json(src, None)
            if payload is None:
                entries = [e for e in entries if e.get("id") != entry_id]
                write_atomic(idx_path, entries)
                raise HTTPException(status_code=410, detail="복원할 일정 내용이 없습니다.")
            # 일정은 파일이 아니라 캘린더에 **새로 만들어** 되돌린다.
            # 원래 id는 되살릴 수 없다(구글은 서버가 발급하고, 지운 id는 재사용 못 한다).
            # 순환 import를 피하려고 여기서 가져온다(calendar_service → trash 방향이 이미 있다).
            from . import calendar_service

            payload.pop("id", None)
            ev = calendar_service.create_event(user, settings, payload)
            shutil.rmtree(src.parent, ignore_errors=True)
            entries = [e for e in entries if e.get("id") != entry_id]
            write_atomic(idx_path, entries)
            return {"ok": True, "kind": KIND_EVENT, "event": ev, "restored_to": ev.get("title", "")}

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
    return {"ok": True, "kind": KIND_DOCUMENT, "restored_to": target.relative_to(root).as_posix()}


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
