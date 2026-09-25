"""문서 API — 사용자 문서 공간 하나를 통째로 다룬다.

2026-08 개편 전에는 파일(`/api/files`)과 노트(`/api/notes`)가 나뉘어 있었고
`scope`(common|me) · `base`(notes|files) 조합으로 위치를 골라야 했다. 지금은
`users/<u>/data` 하나뿐이라 두 매개변수가 모두 사라졌다.

마크다운뿐 아니라 이미지·PDF·미디어도 같은 트리에 나타나며, 각 항목의 `kind`로
프런트가 뷰어를 고른다. 텍스트 계열만 편집 가능하다.
"""
from __future__ import annotations

import errno
import logging
import os
import re
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel

from .. import archive, doc_cache, meeting_store, mounts, moved, paper_store
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings
from ..json_store import lock_for, write_text_atomic
from ..file_kinds import (
    BadName, doc_title, inline_media_type, is_editable, kind_of, looks_like_extension, renamed,
    split_ext,
)
from ..notes_graph import backlinks_for, build_graph, parse_wikilinks
from ..security_paths import safe_join, to_rel
from ..storage import resolve, taken_by_another, user_data_root, walk_all, walk_files
from ..trash import move_to_trash
from ..user_file import user_file

logger = logging.getLogger("server.notes")
router = APIRouter(prefix="/api/notes", tags=["notes"])

_ILLEGAL_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class NoteSummary(BaseModel):
    path: str
    title: str
    modified: float
    kind: str = "md"
    size: int = 0
    editable: bool = True


class NoteDetail(BaseModel):
    path: str
    title: str
    content: str
    links: list[str]
    backlinks: list[str]
    kind: str = "md"
    #: 이 내용을 읽은 시점의 수정시각. 저장할 때 되돌려 보내면 그 사이 다른
    #: 기기에서 바뀐 것을 알아챌 수 있다(0 이면 확인하지 않는다).
    modified: float = 0.0


class SaveNote(BaseModel):
    path: str
    content: str
    #: 열 때 받은 modified. 그 사이 파일이 바뀌었으면 409 로 돌려보낸다.
    #: 비우면(0) 검사하지 않는다 — AI 스킬·스크립트처럼 기준이 없는 쓰기.
    base_modified: float = 0.0


class RenameNote(BaseModel):
    path: str       # 현재 상대경로
    new_name: str   # 새 파일명(확장자 생략 시 원래 확장자 유지)


class MoveNote(BaseModel):
    path: str            # 현재 상대경로
    target_folder: str = ""  # 대상 폴더 상대경로("" = 루트)


class GraphData(BaseModel):
    nodes: list[dict]
    links: list[dict]


class NoteTree(BaseModel):
    folders: list[str]  # 모든 폴더의 상대경로(POSIX)
    notes: list[NoteSummary]
    #: 목록 맨 위에 고정하고 다른 색으로 그릴 폴더(논문·회의처럼 다른 화면이
    #: 관리하는 것들). 화면이 이름을 박아 두지 않도록 서버가 알려 준다.
    pinned: list[str] = []


class FolderRequest(BaseModel):
    path: str


class SearchHit(BaseModel):
    path: str
    title: str
    snippet: str


def _snippet(text: str, q: str, width: int = 60) -> str:
    low = text.lower()
    i = low.find(q.lower())
    if i < 0:
        return text[:width].replace("\n", " ").strip()
    start = max(0, i - width // 2)
    seg = text[start : start + width].replace("\n", " ").strip()
    return ("…" if start > 0 else "") + seg + ("…" if start + width < len(text) else "")


def _on_mount(user: SessionUser, settings: Settings, rel: str) -> bool:
    """이 경로가 **지금 붙어 있는** 마운트에 속하는가.

    같은 이름의 진짜 폴더가 있어 마운트가 접혀 있으면 `논문/…` 은 평범한 문서
    경로다. 그때까지 마운트로 다루면 사용자의 진짜 문서를 못 읽는다.
    """
    return mounts.head_of(rel) in mounts.active_roots(user, settings)


def _mounted(user: SessionUser, settings: Settings, rel: str) -> mounts.MountedFile | None:
    """이 경로가 논문·회의에서 붙여 온 파일인가.

    붙어 있는 이름공간인데 짝이 없으면 404 로 끝낸다 — 그냥 통과시키면 그 자리에
    **진짜 폴더**가 생겨 마운트를 가려 버린다.
    """
    if not _on_mount(user, settings, rel):
        return None
    hit = mounts.find(user, settings, rel)
    if hit is None and mounts.find_folder(user, settings, rel) is None:
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    return hit


def _reject_mount_reshape(user: SessionUser, settings: Settings, rel: str, verb: str) -> None:
    """붙여 온 파일은 이름을 바꾸거나 옮길 수 없다.

    그 파일이 무엇인지는 논문·회의 **색인**이 정한다. 문서 화면에서 이름만 바꾸면
    색인과 실물이 어긋나 그 항목이 안 열린다. 이름은 논문·회의 화면에서 바꾼다.
    """
    if _on_mount(user, settings, rel):
        raise HTTPException(
            status_code=400,
            detail=f"논문·회의에서 온 파일은 여기서 {verb} 수 없습니다 — 그 화면에서 바꾸세요.")


def _existing(root: Path, rel: str) -> Path:
    """상대경로를 **이미 있는 파일**로 해석한다.

    있는 그대로를 먼저 보고, 없고 확장자도 없을 때만 `.md`를 붙여 본다.
    이 폴백은 위키링크(`[[제목]]`)를 위한 것이다 — 링크에는 확장자를 안 쓴다.

    새로 만들 때는 쓰지 않는다. 예전에는 저장 경로에도 무조건 `.md`를 붙여서
    사용자가 `메모.txt`가 아닌 이름을 넣으면 마음대로 마크다운이 됐고,
    확장자 없는 파일은 만들어도 다시 열 수 없었다(`메모` -> `메모.md`를 찾음).
    """
    exact = safe_join(root, rel)
    if exact.exists():
        return exact
    if not looks_like_extension(rel):
        alt = safe_join(root, f"{rel}.md")
        if alt.exists():
            return alt
    return exact


def _summary(root: Path, p: Path) -> NoteSummary:
    return _summary_of(to_rel(root, p), p.stat())


def _summary_of(rel: str, st) -> NoteSummary:
    """순회에서 받아 둔 stat 으로 만든다 — 파일마다 다시 stat 하지 않는다."""
    name = rel.rsplit("/", 1)[-1]
    stem = doc_title(name)
    return NoteSummary(
        path=rel,
        title=stem,
        modified=st.st_mtime,
        kind=kind_of(name),
        size=st.st_size,
        editable=is_editable(name),
    )


# 서버 쪽 사정으로 실패한 것들 — 이름을 바꿔도 소용없으니 500이 맞다.
_SERVER_FAULT_ERRNOS = {
    e
    for e in (
        getattr(errno, n, None)
        for n in ("ENOSPC", "EACCES", "EPERM", "EROFS", "EIO", "EDQUOT", "EMFILE", "ENFILE")
    )
    if e is not None
}


@contextmanager
def _fs_errors_are_bad_requests(what: str):  # noqa: D401
    """파일시스템이 이름을 거부하면 500이 아니라 400으로 돌려준다.

    무엇이 유효한 이름인지는 OS마다 다르다 — 리눅스는 `...`·`CON`을 그냥
    파일로 만들지만 Windows는 거부한다. 플랫폼별 금지 목록을 들고 있으면
    한쪽에서 멀쩡한 이름을 막게 되므로, **실제로 해 보고 실패하면** 사용자
    입력 오류로 돌려준다(경로 탈출은 safe_join이 이미 막는다).

    단 디스크가 찼거나 권한이 없는 것은 이름 탓이 아니다. 그건 500으로 두고
    스택까지 남긴다 — 사용자에게 "이름을 바꿔 보라"고 하면 안 된다.
    """
    try:
        yield
    except UnicodeEncodeError as e:
        # 짝 없는 서로게이트(\ud800 등)가 든 본문. 사용자 입력 오류인데 OSError 가
        # 아니라 그대로 새어 500 + 스택트레이스가 됐다.
        logger.info("%s 실패(인코딩): %s", what, e)
        # what 은 '문서 저장' 같은 **동작** 이름이다. 이름 자리에 넣으면
        # "이 이름은 쓸 수 없습니다: 문서 저장" 같은 말이 안 되는 토스트가 뜬다.
        raise HTTPException(
            status_code=400, detail=f"{what}에 실패했습니다 — 저장할 수 없는 문자가 들어 있습니다."
        ) from e
    except OSError as e:
        if e.errno in _SERVER_FAULT_ERRNOS:
            logger.exception("%s 실패(서버 문제)", what)
            raise HTTPException(status_code=500, detail=f"{what}에 실패했습니다.") from e
        logger.info("%s 실패(이름 문제로 보임): %s", what, e)
        raise HTTPException(
            status_code=400, detail=f"{what}에 실패했습니다 — 이 이름은 쓸 수 없습니다."
        ) from e


def _free_name(dest: Path) -> Path:
    """이미 있으면 `이름 (2).png` 처럼 비어 있는 이름을 찾는다."""
    if not dest.exists():
        return dest
    # 첫 점이 아니라 split_ext 로 쪼갠다. partition(".") 은 `2026.08 회고.md` 를
    # `2026` + `.08 회고.md` 로 갈라 `2026 (2).08 회고.md` 를 만들었다.
    stem, ext = split_ext(dest.name)
    for n in range(2, 1000):
        cand = dest.with_name(f"{stem} ({n}){ext}")
        if not cand.exists():
            return cand
    raise HTTPException(status_code=409, detail="같은 이름의 파일이 너무 많습니다.")


def _sanitize_filename(name: str) -> str:
    base = Path(name).name
    cleaned = _ILLEGAL_FILENAME.sub("_", base).strip().strip(".")
    return cleaned or "untitled"


@router.get("/list", response_model=list[NoteSummary])
def list_notes(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    root = user_data_root(user, settings)
    out = [_summary_of(f.rel, f.stat) for f in walk_files(root)]
    out += _mounted_summaries(user, settings)
    return out


def _mounted_summaries(user: SessionUser, settings: Settings) -> list[NoteSummary]:
    """논문·회의에서 붙여 온 파일들을 문서 목록 모양으로."""
    out: list[NoteSummary] = []
    for f in mounts.files(mounts.mounts(user, settings)):
        try:
            st = f.real.stat()
        except OSError:
            continue
        name = f.rel.rsplit("/", 1)[-1]
        stem = doc_title(name)
        out.append(NoteSummary(
            path=f.rel, title=stem, modified=st.st_mtime, kind=kind_of(name),
            size=st.st_size, editable=f.editable,
        ))
    return out


@router.get("/tree", response_model=NoteTree)
def notes_tree(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """폴더 목록 + 문서 목록(모든 종류). 프런트에서 중첩 트리로 구성.

    논문·회의는 제 저장소에 그대로 있고 여기에 **붙여서** 보인다(mounts).
    옮기지 않는 까닭은 mounts.py 설명에 적어 두었다.
    """
    root = user_data_root(user, settings)
    # 파일과 폴더를 따로 훑으면 트리를 두 번 걷는다
    files, folders = walk_all(root)
    ms = mounts.mounts(user, settings)
    mounted = mounts.folders(ms)
    return NoteTree(
        folders=folders + mounted,
        notes=[_summary_of(f.rel, f.stat) for f in files] + _mounted_summaries(user, settings),
        # **실제로 붙은 것만** 고정한다. 이름만 보고 늘 고정하면, 같은 이름의 진짜
        # 폴더가 있어 마운트를 접었을 때 사용자 폴더가 '다른 화면이 관리하는 것'
        # 처럼 보인다(색도 다르고 맨 위로 올라간다).
        pinned=[d for d in mounts.MOUNT_DIRS if d in mounted],
    )


@router.post("/folder")
def create_folder(
    req: FolderRequest,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    root = user_data_root(user, settings)
    mounts.reject_write(user, settings, req.path)
    target = safe_join(root, req.path)
    if target == root:
        raise HTTPException(status_code=400, detail="폴더 이름이 비어 있습니다.")
    if target.exists():
        raise HTTPException(status_code=409, detail="이미 존재합니다.")
    with _fs_errors_are_bad_requests("폴더 생성"):
        target.mkdir(parents=True)
    return {"ok": True, "path": to_rel(root, target)}


@router.delete("/folder")
def delete_folder(
    path: str = Query(...),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """폴더를 하위 문서와 함께 휴지통으로 이동."""
    root = user_data_root(user, settings)
    # 항목 폴더(`논문/제목`)를 지우는 것은 그 논문·회의를 지우는 것이다
    item = mounts.find_folder(user, settings, path)
    if item is not None:
        if item.kind == "paper":
            paper_store.delete_paper(user, settings, item.item_id)
        else:
            meeting_store.delete_meeting(user, settings, item.item_id)
        return {"ok": True}
    if _on_mount(user, settings, path):
        raise HTTPException(
            status_code=400,
            detail="논문·회의 화면이 관리하는 폴더입니다. 안에 든 항목을 지우세요.")
    target = safe_join(root, path)
    if target == root:
        raise HTTPException(status_code=400, detail="루트는 삭제할 수 없습니다.")
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")
    move_to_trash(target, to_rel(root, target), user, settings)
    return {"ok": True}


@router.get("/get", response_model=NoteDetail)
def get_note(
    path: str = Query(...),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """텍스트 문서의 내용을 읽는다. 이미지·PDF 등은 /raw 를 쓴다."""
    root = user_data_root(user, settings)
    hit = _mounted(user, settings, path)
    target = hit.real if hit else _existing(root, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    if not is_editable(target.name):
        raise HTTPException(status_code=415, detail="텍스트 문서가 아닙니다. 미리보기를 사용하세요.")
    try:
        content = target.read_bytes().decode("utf-8")
    except UnicodeDecodeError as e:
        # errors="replace" 로 읽어 주면 편집기에 U+FFFD 가 든 글이 뜨고, 한 글자만
        # 고쳐 저장해도 원본 바이트가 영구히 그 물음표로 바뀐다. 열지 않는 편이 낫다.
        raise HTTPException(
            status_code=415,
            detail="UTF-8 로 읽을 수 없는 파일입니다(편집하면 원본이 깨집니다). 내려받아 확인하세요.",
        ) from e
    return NoteDetail(
        # 붙여 온 파일은 **붙은 자리**가 곧 경로다(실제 위치는 문서 루트 밖이라
        # to_rel 이 쓸 수 없다)
        path=hit.rel if hit else to_rel(root, target),
        title=doc_title(target.name),
        content=content,
        links=parse_wikilinks(content),
        backlinks=backlinks_for(root, doc_title(target.name)),
        kind=kind_of(target.name),
        modified=target.stat().st_mtime,
    )


@router.get("/raw")
def raw_file(
    path: str = Query(...),
    download: bool = Query(False),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """원본 바이트. 이미지·PDF·미디어는 인라인, 그 외는 다운로드."""
    root = user_data_root(user, settings)
    hit = _mounted(user, settings, path)
    target = hit.real if hit else safe_join(root, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    media = None if download else inline_media_type(target.name)
    if media:
        # inline: 브라우저 내장 뷰어(<img>, <iframe>, <video>)가 그대로 표시. 형식은 이름으로
        # 서버가 정한다. SVG 는 문서로 직접 열면 스크립트가 돌므로 user_file 이 sandbox 를 씌운다.
        return user_file(target, media)
    return user_file(target, "application/octet-stream", filename=target.name)


@router.get("/archive")
def archive_folder(
    path: str = Query("", description="폴더 상대경로. 빈 값이면 전체"),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """폴더를 zip으로 내려받는다(하위 구조 유지). 압축은 archive.zip_dir 이 한다."""
    root = user_data_root(user, settings)
    target = safe_join(root, path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")

    name = (target.name if target != root else "문서") + ".zip"
    return archive.zip_dir(target, filename=name, settings=settings)


@router.get("/archive/account")
def archive_account(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """내 계정 전체를 zip 으로. 문서만이 아니라 논문 PDF·회의 녹음·단어장·일정·
    할 일·지난 대화까지 **한 번에** 받는다.

    문서 폴더 받기만 있던 때는, 서비스를 못 쓰게 됐을 때 나머지를 꺼내려면 SSH 로
    들어가야 했다. 백업은 손이 닿는 곳에 있어야 실제로 한다.

    휴지통과 임시 폴더는 뺀다 — 지운 것을 다시 받을 이유가 없고, 오히려 용량의
    대부분을 차지할 수 있다(회의 녹음이 폴더째 들어가 있다).
    """
    root = settings.user_root(user.username)
    if not root.exists():
        raise HTTPException(status_code=404, detail="저장된 것이 없습니다.")
    return archive.zip_dir(root, filename=f"{user.username}-백업.zip", settings=settings,
                           skip_dirs=frozenset({".trash", ".tmp"}))


@router.post("/upload", response_model=NoteSummary)
async def upload(
    file: UploadFile = File(...),
    path: str = Query("", description="대상 폴더 상대경로"),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="파일명이 없습니다.")
    mounts.reject_write(user, settings, path)
    root = user_data_root(user, settings)
    dest_dir = resolve(path, user, settings)
    safe_name = _sanitize_filename(file.filename)
    dest = safe_join(root, f"{to_rel(root, dest_dir)}/{safe_name}")

    with _fs_errors_are_bad_requests("업로드 폴더 생성"):
        dest_dir.mkdir(parents=True, exist_ok=True)

    # 같은 이름의 폴더가 이미 있으면 열기부터 실패한다. 미리 걸러야 "서버 오류"가
    # 아니라 무엇이 문제인지 알 수 있다.
    if dest.is_dir():
        raise HTTPException(status_code=409, detail="같은 이름의 폴더가 이미 있습니다.")
    # 같은 이름의 문서가 있으면 덮지 않고 옆에 만든다. 덮으면 휴지통에도 안 남아
    # 되돌릴 수 없다(이름변경·이동·폴더생성은 모두 409로 막는데 업로드만 조용히
    # 덮고 있었다). 사진을 다시 올리는 일은 흔하고, 그때 원본이 사라지면 안 된다.
    dest = _free_name(dest)

    # **먼저 임시 파일에 쓰고 마지막에 갈아 끼운다.** 대상 파일을 열자마자 자르면
    # 도중에 실패했을 때(크기 초과·연결 끊김) 원래 있던 파일이 사라진다.
    tmp = dest.with_name(f"{dest.name}.upload{os.getpid()}.{uuid.uuid4().hex[:8]}")
    written = 0
    try:
        with _fs_errors_are_bad_requests("업로드"):
            with tmp.open("wb") as out:
                while chunk := await file.read(1024 * 1024):
                    written += len(chunk)
                    if written > settings.max_upload_bytes:
                        raise HTTPException(status_code=413, detail="파일이 너무 큽니다.")
                    out.write(chunk)
            os.replace(tmp, dest)
    except BaseException:
        # OSError 만 잡으면 다른 예외에서 임시파일이 영구히 남는다
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    finally:
        # 여기는 write_text_atomic을 거치지 않는 유일한 쓰기 경로다.
        doc_cache.invalidate(dest)
    return _summary(root, dest)


@router.put("/save", response_model=NoteSummary)
def save_note(
    req: SaveNote,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    root = user_data_root(user, settings)
    # 논문·회의에서 붙여 온 파일은 그 저장소에 그대로 써 넣는다 — 문서 화면에서
    # 고친 회의록이 회의 화면에도 바로 반영되는 것이 이 마운트의 핵심이다.
    hit = _mounted(user, settings, req.path)
    if hit is not None:
        if not hit.editable:
            raise HTTPException(status_code=415, detail="원본 파일은 여기서 고칠 수 없습니다.")
        name = hit.rel.rsplit("/", 1)[-1].removesuffix(".md")
        # base_modified 를 그대로 넘긴다 — 문서 화면과 회의 화면에서 같은 회의록을
        # 열어 두면 나중에 저장한 쪽이 앞의 편집을 조용히 지운다.
        meeting_store.write_doc(user, settings, hit.item_id, name, req.content,
                                base_modified=req.base_modified or 0.0)
        st = hit.real.stat()
        return NoteSummary(path=hit.rel, title=name, modified=st.st_mtime,
                           kind=kind_of(hit.real.name), size=st.st_size, editable=True)
    mounts.reject_write(user, settings, req.path)
    # 저장은 **받은 경로 그대로**. 확장자는 만든 사람이 정한다.
    #
    # _existing() 을 쓰면 안 된다. 그건 위키링크를 위해 `회의` → `회의.md` 로
    # 되짚어 주는 읽기 전용 규칙인데, 쓰기에 쓰면 '새 노트'에 `회의` 라고 친 순간
    # 이미 있던 `회의.md` 의 내용이 통째로 덮인다.
    target = safe_join(root, req.path)
    if not target.exists() and not looks_like_extension(req.path):
        twin = safe_join(root, f"{req.path}.md")
        if twin.exists():
            raise HTTPException(
                status_code=409,
                detail=f"같은 이름의 문서가 이미 있습니다: {to_rel(root, twin)}",
            )
    # 같은 이름의 폴더가 있으면 os.replace가 PermissionError를 내고 500이 됐다
    # (UI '새 문서'에서 폴더 이름을 그대로 치면 도달한다).
    if target.is_dir():
        raise HTTPException(status_code=409, detail="같은 이름의 폴더가 이미 있습니다.")
    if target.exists() and not is_editable(target.name):
        raise HTTPException(status_code=415, detail="텍스트 문서만 편집할 수 있습니다.")
    # 두 기기에서 같은 문서를 열어 두면 나중에 저장한 쪽이 앞의 편집을 조용히
    # 지운다. 열 때 받은 수정시각을 되돌려 받아, 그 사이 바뀌었으면 멈춘다.
    # (파일시스템 mtime 은 소수 자리가 왕복하며 흔들려서 1초 여유를 둔다.)
    if req.base_modified and target.exists():
        current = target.stat().st_mtime
        if abs(current - req.base_modified) > 1.0:
            raise HTTPException(
                status_code=409,
                detail="이 문서가 다른 곳에서 바뀌었습니다. 새로 고쳐 확인한 뒤 저장하세요.",
            )
    with _fs_errors_are_bad_requests("문서 저장"):
        target.parent.mkdir(parents=True, exist_ok=True)
        # AI 쓰기와 같은 락·원자성 규약을 쓴다(자동저장과 AI append가 서로 덮어썼다)
        with lock_for(target):
            write_text_atomic(target, req.content)
    return _summary(root, target)


@router.delete("/delete")
def delete_note(
    path: str = Query(...),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    root = user_data_root(user, settings)
    # 붙여 온 것은 **그 저장소의 삭제 길**로 보낸다. 파일만 지우면 색인에는
    # 남아서 논문·회의 목록에 '열리지 않는 항목' 이 뜬다.
    hit = _mounted(user, settings, path)
    if hit is not None:
        if hit.role == "doc":
            meeting_store.delete_doc(user, settings, hit.item_id,
                                     hit.rel.rsplit("/", 1)[-1].removesuffix(".md"))
        elif hit.kind == "paper":
            paper_store.delete_paper(user, settings, hit.item_id)
        else:
            meeting_store.delete_meeting(user, settings, hit.item_id)
        return {"ok": True}
    target = _existing(root, path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    # 즉시 삭제 대신 휴지통으로 이동
    move_to_trash(target, to_rel(root, target), user, settings)
    return {"ok": True}


@router.post("/rename", response_model=NoteSummary)
def rename_note(
    req: RenameNote,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """같은 폴더 안에서 파일명을 바꾼다(내용·폴더 유지)."""
    root = user_data_root(user, settings)
    # 논문·회의에서 붙여 온 파일은 **그 저장소의 이름 바꾸기 길**로 보낸다. 예전에는
    # 통째로 막아서, 문서 화면에서 회의록 이름을 바꾸면 늘 400 이었다 — 보고·고치고·
    # 지우기는 되는데 이름만 안 되니 "적용이 안 된다"로 보였다.
    hit = _mounted(user, settings, req.path)
    if hit is not None:
        return _rename_mounted(user, settings, hit, req.new_name)
    src = _existing(root, req.path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    # 결과 이름은 AI 스킬과 **같은 함수**로 정한다(따로 두었다가 어긋났다)
    try:
        new_name = renamed(src.name, req.new_name, folder=src.is_dir())
    except BadName as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    rel_dir = src.parent.relative_to(root).as_posix()
    dst_rel = new_name if rel_dir in ("", ".") else f"{rel_dir}/{new_name}"
    safe_join(root, dst_rel)  # 이름 검사(쓸 수 없는 문자·길이)만 — 자리는 아래처럼 만든다
    # safe_join 의 resolve 는 있는 파일을 **디스크의 표기**로 바꾼다(Windows). 그 값을 쓰면
    # 대소문자만 바꾼 이름(`메모.MD`)이 `메모.md` 로 돌아와 제자리 이름 바꾸기가 됐다.
    dst = src.parent / new_name
    if dst_rel == src.relative_to(root).as_posix():
        return _summary(root, src)  # 이름이 그대로다 — 할 일이 없다("이미 있다"가 아니다)
    if taken_by_another(src, dst):  # 대소문자만 바꾼 이름은 자기 자신이다
        raise HTTPException(status_code=409, detail="같은 이름의 문서가 이미 있습니다.")
    return _relocate(user, settings, root, src, dst, dst_rel, "이름 변경")


def _relocate(user: SessionUser, settings: Settings, root: Path, src: Path, dst: Path,
              dst_rel: str, what: str) -> NoteSummary:
    """src 를 dst 로 옮기고, 옛 경로를 가리키던 링크가 새 자리를 찾게 기록한다(moved.py).

    이름 바꾸기와 옮기기가 함께 쓴다. 두 길이 저마다 적으면 한쪽이 기록을 빠뜨려, 그 길로 옮긴
    문서(폴더면 그 안 전부)의 옛 링크만 죽는다.
    """
    old_rel, was_dir = src.relative_to(root).as_posix(), src.is_dir()
    with _fs_errors_are_bad_requests(what):
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
    moved.record(user, settings, old_rel, dst_rel, folder=was_dir)
    return _summary(root, dst)


def _rename_mounted(user: SessionUser, settings: Settings, hit: mounts.MountedFile,
                    new_name: str) -> NoteSummary:
    """붙여 온 파일의 이름 바꾸기. 파일의 정체는 그 저장소의 색인이 정하므로
    이름도 **그 색인을 통해** 바꾼다(파일만 옮기면 색인과 어긋나 안 열린다).

    확장자는 바꿀 수 없다 — 회의록은 마크다운, 논문 원본은 PDF, 녹음은 그 형식이다.
    이름으로 형식을 바꾸면 그 화면이 파일을 못 연다.
    """
    old = hit.rel.rsplit("/", 1)[-1]
    try:
        new = renamed(old, new_name)
    except BadName as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    stem, ext = split_ext(new)
    if ext.lower() != split_ext(old)[1].lower():
        raise HTTPException(
            status_code=400,
            detail=f"논문·회의에서 온 파일은 확장자를 바꿀 수 없습니다({split_ext(old)[1]} 를 유지하세요).")
    if hit.role == "doc":
        meeting_store.rename_doc(user, settings, hit.item_id, split_ext(old)[0], stem)
    elif hit.kind == "paper":
        paper_store.update_meta(user, settings, hit.item_id, {"filename": new})
    else:
        meeting_store.update_meta(user, settings, hit.item_id, {"filename": new})
    # 새 자리는 마운트를 다시 만들어 찾는다(이름을 짓는 규칙이 mounts 한 곳에 있다).
    # 폴더로 좁히지 않는다 — 제목 없는 논문은 파일 이름이 곧 제목이라 폴더도 바뀐다.
    for f in mounts.files(mounts.mounts(user, settings)):
        if f.item_id == hit.item_id and f.role == hit.role \
                and (hit.role != "doc" or split_ext(f.rel.rsplit("/", 1)[-1])[0] == stem):
            st = f.real.stat()
            moved.record(user, settings, hit.rel, f.rel)
            return NoteSummary(path=f.rel, title=split_ext(f.rel.rsplit("/", 1)[-1])[0],
                               modified=st.st_mtime, kind=kind_of(f.rel), size=st.st_size,
                               editable=f.editable)
    raise HTTPException(status_code=500, detail="이름은 바꿨지만 새 자리를 찾지 못했습니다.")


@router.post("/move", response_model=NoteSummary)
def move_note(
    req: MoveNote,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """문서를 다른 폴더로 이동한다(파일명 유지)."""
    root = user_data_root(user, settings)
    _reject_mount_reshape(user, settings, req.path, "옮길")
    # 마운트 이름공간 **안으로** 옮기는 것도 막는다 — 거기에 진짜 폴더가 생기면
    # 이름이 겹쳐 마운트가 통째로 접히고 논문·회의가 문서 화면에서 사라진다.
    mounts.reject_write(user, settings, req.target_folder or "")
    src = _existing(root, req.path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    folder = (req.target_folder or "").strip().strip("/")
    if ".." in folder.split("/"):
        raise HTTPException(status_code=400, detail="잘못된 폴더 경로입니다.")
    # 폴더를 제 안(자기 자신·하위 폴더)으로 옮기면 파일 시스템이 거절한다(EINVAL) — 그 전에
    # 대상 폴더를 만들어 두므로 빈 폴더가 하나 남고, 화면에는 "이 이름은 쓸 수 없습니다" 라는
    # 엉뚱한 말이 떴다(37차, 폴더 끌어 옮기기를 붙이며 찾았다). 먼저 까닭을 말하고 멈춘다.
    src_rel = src.relative_to(root).as_posix()
    if src.is_dir() and (folder == src_rel or folder.startswith(src_rel + "/")):
        raise HTTPException(status_code=400, detail="폴더를 그 안으로 옮길 수는 없습니다.")
    dst_rel = f"{folder}/{src.name}" if folder else src.name
    dst = safe_join(root, dst_rel)
    if dst == src:
        return _summary(root, src)
    if dst.exists():
        raise HTTPException(status_code=409, detail="대상 폴더에 같은 이름의 문서가 있습니다.")
    return _relocate(user, settings, root, src, dst, dst_rel, "문서 이동")


@router.get("/moved")
def moved_title(
    title: str = Query(..., min_length=1, max_length=300),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """`[[옛제목]]` 을 눌렀는데 그 제목의 문서가 없을 때 — 이름을 바꿔 간 곳이 있는가.

    화면은 없는 제목이면 새 문서를 만든다. 이름을 바꾼 문서의 옛 링크를 누르면 **빈 옛이름
    문서가 새로 생겼다**(내용은 새 이름에 있는데). 만들기 전에 이것을 먼저 묻는다.
    """
    root = user_data_root(user, settings)
    now = moved.follow_title(user, settings, title, lambda r: safe_join(root, r).is_file())
    return {"path": now}


@router.get("/search", response_model=list[SearchHit])
def search_notes(
    q: str = Query(..., min_length=1),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """제목·내용 전문 검색. 텍스트 문서만 본문을 뒤진다."""
    root = user_data_root(user, settings)
    ql = q.lower()
    hits: list[SearchHit] = []
    for f in walk_files(root):
        p, name = f.path, f.name
        title = doc_title(name)
        title_hit = ql in title.lower()
        if not is_editable(name):
            # 이미지·PDF 등은 파일명으로만 찾는다
            if title_hit:
                hits.append(SearchHit(path=f.rel, title=title, snippet=""))
            if len(hits) >= 50:
                break
            continue
        # 검색은 타자를 칠 때마다 불린다 — 두 번째부터는 캐시에서 온다.
        text = doc_cache.text_of(p, f.stat)
        if text is None:
            continue
        if title_hit or ql in text.lower():
            hits.append(
                SearchHit(path=to_rel(root, p), title=title, snippet=_snippet(text, q))
            )
        if len(hits) >= 50:
            break
    return hits


@router.get("/graph", response_model=GraphData)
def graph(
    folder: str = Query(""),
    mode: str = Query("links"),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    root = user_data_root(user, settings)
    return build_graph(root, folder=folder or None, mode=mode)
