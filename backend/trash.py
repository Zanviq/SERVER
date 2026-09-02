"""휴지통: 삭제를 즉시 수행하지 않고 개인 폴더의 .trash로 이동한다.

위치: users/<username>/.trash/
  - index.json : 엔트리 메타 배열
  - data/<id>/<name> : 실제 이동된 파일/폴더

엔트리: {id, kind, orig_rel, name, is_dir, deleted_at}

kind 는 휴지통을 갈래별로 보기 위한 것이다.
  - "document" : 파일/폴더. data/<id>/<name> 에 실물이 들어 있다.
  - "event"    : 캘린더 일정. 파일이 아니라 data/<id>/event.json 에 내용을 적어 둔다.
  - "todo"     : 할 일. data/<id>/todo.json 에 내용을 적어 둔다(원래 id 되살림).
kind 가 없는 예전 엔트리는 문서로 본다(기존 휴지통이 비지 않도록).

.trash 는 개인 루트 바로 아래(data/ 형제)에 있으므로
목록·검색·그래프·동기화의 대상 루트에 포함되지 않는다(자동 제외).
"""
from __future__ import annotations

import re
import shutil
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

from .auth import SessionUser
from .config import Settings
from .file_kinds import split_ext
from .json_store import lock_for, read_json, write_atomic
from .storage import user_data_root

TRASH_DIRNAME = ".trash"

KIND_DOCUMENT = "document"
KIND_EVENT = "event"
KIND_TODO = "todo"
EVENT_FILE = "event.json"
TODO_FILE = "todo.json"


def entry_kind(entry: dict) -> str:
    """kind 가 없는 예전 엔트리는 문서다."""
    return str(entry.get("kind") or KIND_DOCUMENT)


def _trash_root(user: SessionUser, settings: Settings) -> Path:
    root = settings.user_root(user.username) / TRASH_DIRNAME
    (root / "data").mkdir(parents=True, exist_ok=True)
    return root


def _index_path(user: SessionUser, settings: Settings) -> Path:
    return _trash_root(user, settings) / "index.json"


def _append_entry(entry: dict, user: SessionUser, settings: Settings,
                  payload: tuple[Path, dict] | None = None) -> None:
    """인덱스에 엔트리 하나를 단다(락 안에서 읽고 원자적으로 쓴다).

    실물(payload)이 있으면 **같은 락 안에서** 쓴다. 밖에서 쓰면 그 사이에 들어온
    '휴지통 비우기'가 인덱스에 없는 디렉터리라고 보고 지워 버려서, 방금 지운
    일정·할 일이 되살릴 수 없는 상태로 사라진다.
    """
    idx_path = _index_path(user, settings)
    with lock_for(idx_path):
        if payload is not None:
            path, data = payload
            path.parent.mkdir(parents=True, exist_ok=True)
            write_atomic(path, data)
        try:
            entries = read_json(idx_path, [])
            entries.append(entry)
            write_atomic(idx_path, entries)
        except BaseException:
            # 인덱스에 못 실었으면 실물도 남기지 않는다. 남기면 목록에 안 보이는
            # 미아가 되어 '비우기'로도 안 지워지고 용량만 먹는다.
            if payload is not None:
                shutil.rmtree(payload[0].parent, ignore_errors=True)
            raise


def _entry(kind: str, name: str, **extra) -> dict:
    """공통 필드를 채운 엔트리. 갈래별 추가 필드는 extra 로."""
    return {
        "id": uuid.uuid4().hex,
        "kind": kind,
        "orig_rel": "",
        "name": name,
        "is_dir": False,
        "deleted_at": time.time(),
        **extra,
    }


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
    idx_path = _index_path(user, settings)
    # 실물 이동과 인덱스 기록을 같은 락 안에서 한다. 예전에는 이동이 락 밖이라
    # 그 사이에 '비우기'가 data/를 통째로 지우면 문서가 영구히 사라졌다.
    with lock_for(idx_path):
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
        try:
            entries = read_json(idx_path, [])
            entries.append(entry)
            write_atomic(idx_path, entries)
        except BaseException:
            # 실물은 이미 옮겼는데 목록에 못 실었다. 그대로 두면 문서 목록에도
            # 휴지통에도 없는 유령이 되고, '비우기'가 영구히 지운다.
            # 제자리로 되돌린 뒤 실패를 알린다 — 사라지는 것보다 낫다.
            try:
                source.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(dest), str(source))
                shutil.rmtree(dest_dir, ignore_errors=True)
            except OSError:
                pass
            raise
    return entry_id


def move_event_to_trash(event: dict, user: SessionUser, settings: Settings) -> str:
    """캘린더 일정을 휴지통에 넣는다(파일이 아니라 내용을 적어 둔다)."""
    entry = _entry(
        KIND_EVENT, str(event.get("title") or "(제목 없음)"),
        # 목록에서 언제/무슨 색 일정이었는지 보이도록
        event_start=str(event.get("start", "")), event_color=str(event.get("color", "")),
    )
    dest_dir = _trash_root(user, settings) / "data" / entry["id"]
    _append_entry(entry, user, settings, payload=(dest_dir / EVENT_FILE, event))
    return entry["id"]


def move_todo_to_trash(todo: dict, user: SessionUser, settings: Settings) -> str:
    """할 일을 휴지통에 넣는다(파일이 아니라 내용을 적어 둔다).

    캘린더 일정과 달리 **원래 id를 되살릴 수 있다** — 우리 저장소가 발급한
    값이라 재사용해도 충돌하지 않는다.
    """
    entry = _entry(
        KIND_TODO, str(todo.get("title") or "(제목 없음)"),
        todo_due=str(todo.get("due", "")), todo_done=bool(todo.get("done")),
    )
    dest_dir = _trash_root(user, settings) / "data" / entry["id"]
    _append_entry(entry, user, settings, payload=(dest_dir / TODO_FILE, todo))
    return entry["id"]


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
    out = {KIND_DOCUMENT: 0, KIND_EVENT: 0, KIND_TODO: 0}
    for e in entries:
        k = entry_kind(e)
        out[k] = out.get(k, 0) + 1
    out["all"] = len(entries)
    return out


#: 확장자 판정은 file_kinds 한 곳에서만 한다(복사본이 갈라져 사고가 났다)
_split_ext = split_ext


def _unique_target(root: Path, rel: str) -> Path:
    """복원 위치. 이미 존재하면 이름에 ' (restored)' 접미를 붙인다.

    Path.suffixes 를 쓰지 않는다 — `2026.08 회고.md` 의 확장자를 `.08 회고.md` 로
    보고 이름을 망가뜨린다. 이 저장소는 그 규칙을 일부러 피해 왔다.
    """
    target = root / rel
    if not target.exists():
        return target
    parent = target.parent
    # Path.suffix 도 못 쓴다 — `2026.08 회고`(폴더)의 확장자를 `.08 회고` 로 본다.
    # 이 저장소가 쓰는 규칙(글자가 하나는 있는 짧은 꼬리)만 확장자로 인정한다.
    base, suffix = _split_ext(target.name)
    n = 1
    while True:
        cand = parent / f"{base} (restored{'' if n == 1 else ' ' + str(n)}){suffix}"
        if not cand.exists():
            return cand
        n += 1


def restore(entry_id: str, user: SessionUser, settings: Settings) -> dict:
    idx_path = _index_path(user, settings)
    pending_event: dict | None = None
    pending_todo: dict | None = None
    with lock_for(idx_path):
        entries = read_json(idx_path, [])
        entry = next((e for e in entries if e.get("id") == entry_id), None)
        if entry is None:
            raise HTTPException(status_code=404, detail="휴지통 항목을 찾을 수 없습니다.")

        if entry_kind(entry) == KIND_TODO:
            src = _trash_root(user, settings) / "data" / entry_id / TODO_FILE
            payload = read_json(src, None)
            if payload is None:
                entries = [e for e in entries if e.get("id") != entry_id]
                write_atomic(idx_path, entries)
                raise HTTPException(status_code=410, detail="복원할 할 일 내용이 없습니다.")
            # 일정과 같은 이유로 락 안에서 엔트리를 선점한다(동시 복원 중복 방지)
            entries = [e for e in entries if e.get("id") != entry_id]
            write_atomic(idx_path, entries)
            pending_todo = payload

        elif entry_kind(entry) == KIND_EVENT:
            src = _trash_root(user, settings) / "data" / entry_id / EVENT_FILE
            payload = read_json(src, None)
            if payload is None:
                entries = [e for e in entries if e.get("id") != entry_id]
                write_atomic(idx_path, entries)
                raise HTTPException(status_code=410, detail="복원할 일정 내용이 없습니다.")
            # 캘린더 생성은 락 밖에서 한다(구글이면 네트워크 왕복이라, 락을 쥔 채
            # 기다리면 다른 휴지통 작업이 전부 멈춘다). 다만 **락 안에서 엔트리를
            # 먼저 걷어내 선점한다** — 확인만 하고 나가면 동시 요청 둘이 같은
            # 엔트리를 보고 각자 일정을 만들어 중복된다(실측: 2건 생성).
            entries = [e for e in entries if e.get("id") != entry_id]
            write_atomic(idx_path, entries)
            pending_event = payload

    if pending_todo is not None:
        from . import todo_store

        try:
            restored = todo_store.restore_todo(user, settings, pending_todo)
        except Exception:
            with lock_for(idx_path):
                back = read_json(idx_path, [])
                if not any(e.get("id") == entry_id for e in back):
                    back.append(entry)
                    write_atomic(idx_path, back)
            raise
        shutil.rmtree(_trash_root(user, settings) / "data" / entry_id, ignore_errors=True)
        return {"ok": True, "kind": KIND_TODO, "todo": restored,
                "todo_id": restored.get("id", ""), "restored_to": restored.get("title", "")}

    if pending_event is not None:
        # 일정은 파일이 아니라 캘린더에 새로 만들어 되돌린다.
        # 원래 id는 되살릴 수 없다(구글은 서버가 발급하고 지운 id는 재사용 못 한다).
        from . import calendar_service

        pending_event.pop("id", None)
        try:
            ev = calendar_service.create_event(user, settings, pending_event)
        except Exception:
            # 선점만 해놓고 못 만들면 휴지통에서 사라진다 — 되돌려 놓는다.
            with lock_for(idx_path):
                back = read_json(idx_path, [])
                if not any(e.get("id") == entry_id for e in back):
                    back.append(entry)
                    write_atomic(idx_path, back)
            raise
        shutil.rmtree(_trash_root(user, settings) / "data" / entry_id, ignore_errors=True)
        # 새 id를 돌려준다 — 복원 직후 이어서 수정하려면 필요하다
        return {"ok": True, "kind": KIND_EVENT, "event": ev,
                "event_id": ev.get("id", ""), "restored_to": ev.get("title", "")}

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
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
        except FileExistsError as e:
            # 원래 상위 폴더 자리에 지금은 **파일**이 있다(지운 뒤 같은 이름으로
            # 문서를 만든 경우). exist_ok 는 이걸 봐주지 않아 500 이 됐다.
            raise HTTPException(
                status_code=409,
                detail=f"원래 자리에 같은 이름의 문서가 있어 복원할 수 없습니다: "
                       f"{Path(entry['orig_rel']).parent.as_posix()}",
            ) from e
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
        # **인덱스를 먼저 고치고 실물을 지운다.** 반대로 하면 인덱스 쓰기가
        # 실패했을 때 목록에는 남았는데 복원은 410 인 유령이 생긴다. 이 순서면
        # 최악이라도 아무도 못 보는 데이터가 디스크에 남을 뿐이고, 그건 다음
        # 비우기가 치운다.
        entries = [e for e in entries if e.get("id") != entry_id]
        write_atomic(idx_path, entries)
        shutil.rmtree(
            _trash_root(user, settings) / "data" / entry_id, ignore_errors=True
        )
    return {"ok": True}


def empty(user: SessionUser, settings: Settings) -> dict:
    idx_path = _index_path(user, settings)
    with lock_for(idx_path):
        write_atomic(idx_path, [])  # 인덱스 먼저 — 유령 항목을 만들지 않는다
        data_root = _trash_root(user, settings) / "data"
        shutil.rmtree(data_root, ignore_errors=True)
        data_root.mkdir(parents=True, exist_ok=True)
    return {"ok": True}
