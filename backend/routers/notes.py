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
import tempfile
import zipfile
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .. import doc_cache
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings
from ..json_store import lock_for, write_text_atomic
from ..file_kinds import inline_media_type, is_editable, kind_of
from ..notes_graph import backlinks_for, build_graph, parse_wikilinks
from ..security_paths import safe_join, to_rel
from ..storage import resolve, user_data_root, walk_all, walk_files
from ..trash import move_to_trash

logger = logging.getLogger("server.notes")
router = APIRouter(prefix="/api/notes", tags=["notes"])

_ILLEGAL_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# 문서로 열렸을 때 스크립트를 실행할 수 있는 형식 — CSP 샌드박스를 씌운다.
_SCRIPTABLE_MEDIA = {"image/svg+xml"}


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


class SaveNote(BaseModel):
    path: str
    content: str


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
    if not Path(rel).suffix:
        alt = safe_join(root, f"{rel}.md")
        if alt.exists():
            return alt
    return exact


def _summary(root: Path, p: Path) -> NoteSummary:
    return _summary_of(to_rel(root, p), p.stat())


def _summary_of(rel: str, st) -> NoteSummary:
    """순회에서 받아 둔 stat 으로 만든다 — 파일마다 다시 stat 하지 않는다."""
    name = rel.rsplit("/", 1)[-1]
    stem = name[:-3] if name.endswith(".md") else (name.rsplit(".", 1)[0] if "." in name else name)
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
        raise HTTPException(
            status_code=400, detail=f"저장할 수 없는 문자가 들어 있습니다: {what}"
        ) from e
    except OSError as e:
        if e.errno in _SERVER_FAULT_ERRNOS:
            logger.exception("%s 실패(서버 문제)", what)
            raise HTTPException(status_code=500, detail=f"{what}에 실패했습니다.") from e
        logger.info("%s 실패(이름 문제로 보임): %s", what, e)
        raise HTTPException(
            status_code=400, detail=f"이 이름은 쓸 수 없습니다: {what}"
        ) from e


def _free_name(dest: Path) -> Path:
    """이미 있으면 `이름 (2).png` 처럼 비어 있는 이름을 찾는다."""
    if not dest.exists():
        return dest
    stem, dot, ext = dest.name.partition(".")
    for n in range(2, 1000):
        cand = dest.with_name(f"{stem} ({n}){dot}{ext}")
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
    return [_summary_of(f.rel, f.stat) for f in walk_files(root)]


@router.get("/tree", response_model=NoteTree)
def notes_tree(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """폴더 목록 + 문서 목록(모든 종류). 프런트에서 중첩 트리로 구성."""
    root = user_data_root(user, settings)
    # 파일과 폴더를 따로 훑으면 트리를 두 번 걷는다
    files, folders = walk_all(root)
    return NoteTree(
        folders=folders,
        notes=[_summary_of(f.rel, f.stat) for f in files],
    )


@router.post("/folder")
def create_folder(
    req: FolderRequest,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    root = user_data_root(user, settings)
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
    target = _existing(root, path)
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
        path=to_rel(root, target),
        title=target.stem,
        content=content,
        links=parse_wikilinks(content),
        backlinks=backlinks_for(root, target.stem),
        kind=kind_of(target.name),
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
    target = safe_join(root, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    media = None if download else inline_media_type(target.name)
    if media:
        # inline: 브라우저 내장 뷰어(<img>, <iframe>, <video>)가 그대로 표시.
        #
        # 업로드된 파일은 신뢰할 수 없다. SVG는 <img>로 볼 땐 스크립트가 안 돌지만
        # 문서로 직접 열면(새 탭·URL 직접 접근) 앱과 같은 오리진에서 실행된다.
        # 세션 쿠키가 httpOnly라 값은 못 읽어도 인증된 API를 대신 호출할 수 있다.
        #   - nosniff: 선언한 MIME과 다르게 재해석되는 것 차단
        #   - sandbox: 스크립트 실행 가능한 형식에만 붙인다(PDF 내장 뷰어를 깨지 않도록)
        headers = {"X-Content-Type-Options": "nosniff"}
        if media in _SCRIPTABLE_MEDIA:
            headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
        return FileResponse(target, media_type=media, headers=headers)
    return FileResponse(
        target,
        filename=target.name,
        media_type="application/octet-stream",
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.get("/archive")
def archive_folder(
    path: str = Query("", description="폴더 상대경로. 빈 값이면 전체"),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """폴더를 zip으로 내려받는다(하위 구조 유지).

    임시파일 + FileResponse로 만든다 —
    - BytesIO는 라즈베리파이에서 사진·영상 폴더를 통째로 메모리에 올린다.
    - FileResponse가 RFC 5987(`filename*=UTF-8''`)을 붙여줘 한글 폴더명이 안 깨진다.
      직접 Content-Disposition을 만들면 손으로 퍼센트 인코딩해야 한다.
    """
    root = user_data_root(user, settings)
    target = safe_join(root, path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")

    name = (target.name if target != root else "문서") + ".zip"
    # 임시파일을 데이터 볼륨에 만든다 — 컨테이너 기본 /tmp는 SD카드의 오버레이라
    # 큰 폴더를 압축하면 방금 비운 SD를 다시 채운다.
    tmp_dir = settings.storage_root / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(dir=tmp_dir, suffix=".zip", delete=False)
    tmp.close()
    tmp_path = Path(tmp.name)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in sorted(target.rglob("*")):
                # 심볼릭 링크는 건너뛴다 — safe_join은 '요청 경로'만 검증하므로
                # 루트 밖을 가리키는 링크를 따라가면 그 내용이 통째로 나간다.
                if p.is_symlink() or not p.is_file():
                    continue
                try:
                    zf.write(p, arcname=p.relative_to(target).as_posix())
                except (OSError, ValueError) as e:
                    # 1980년 이전 mtime이나 인코딩 불가 파일명은 zipfile이 ValueError를
                    # 낸다. 한 파일 때문에 전체 내보내기를 실패시키지 않고 건너뛴다.
                    logger.warning("압축 제외: %s (%s)", p, e)
    except BaseException:
        # OSError만 잡으면 ValueError 등이 새어나가 임시파일이 영구히 남는다.
        tmp_path.unlink(missing_ok=True)
        raise

    return FileResponse(
        tmp_path,
        filename=name,
        media_type="application/zip",
        headers={
            "X-Content-Type-Options": "nosniff",
            # 요청마다 새로 만드는 아카이브라 이어받기를 허용하면 서로 다른 zip이
            # 이어 붙어 조용히 깨진다(오류도 안 난다).
            "Accept-Ranges": "none",
            "Cache-Control": "no-store",
        },
        background=BackgroundTask(tmp_path.unlink, True),
    )


@router.post("/upload", response_model=NoteSummary)
async def upload(
    file: UploadFile = File(...),
    path: str = Query("", description="대상 폴더 상대경로"),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="파일명이 없습니다.")
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


#: 확장자로 볼 꼬리 — 글자가 하나는 있어야 한다('2026.08'·'v1.2'는 확장자가 아니다)
_EXT_RE = re.compile(r"\.(?=[A-Za-z0-9]{1,8}$)[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$")


def _looks_like_extension(name: str) -> bool:
    return bool(_EXT_RE.search(name.rsplit("/", 1)[-1]))


@router.put("/save", response_model=NoteSummary)
def save_note(
    req: SaveNote,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    root = user_data_root(user, settings)
    # 저장은 **받은 경로 그대로**. 확장자는 만든 사람이 정한다.
    #
    # _existing() 을 쓰면 안 된다. 그건 위키링크를 위해 `회의` → `회의.md` 로
    # 되짚어 주는 읽기 전용 규칙인데, 쓰기에 쓰면 '새 노트'에 `회의` 라고 친 순간
    # 이미 있던 `회의.md` 의 내용이 통째로 덮인다.
    target = safe_join(root, req.path)
    if not target.exists() and not Path(req.path).suffix:
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
    src = _existing(root, req.path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    new_name = (req.new_name or "").strip()
    if not new_name or "/" in new_name or "\\" in new_name or ".." in new_name:
        raise HTTPException(status_code=400, detail="잘못된 이름입니다.")
    # 확장자를 안 적었으면 원래 것을 유지한다(.png를 .png.md로 만들지 않도록).
    # Path(...).suffix는 '2026.08'의 '.08'도 확장자로 보므로 쓰지 않는다.
    if not _looks_like_extension(new_name):
        new_name = f"{new_name}{src.suffix}"
    rel_dir = src.parent.relative_to(root).as_posix()
    dst_rel = new_name if rel_dir in ("", ".") else f"{rel_dir}/{new_name}"
    dst = safe_join(root, dst_rel)
    if dst.exists():
        raise HTTPException(status_code=409, detail="같은 이름의 문서가 이미 있습니다.")
    with _fs_errors_are_bad_requests("이름 변경"):
        src.rename(dst)
    return _summary(root, dst)


@router.post("/move", response_model=NoteSummary)
def move_note(
    req: MoveNote,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """문서를 다른 폴더로 이동한다(파일명 유지)."""
    root = user_data_root(user, settings)
    src = _existing(root, req.path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    folder = (req.target_folder or "").strip().strip("/")
    if ".." in folder.split("/"):
        raise HTTPException(status_code=400, detail="잘못된 폴더 경로입니다.")
    dst_rel = f"{folder}/{src.name}" if folder else src.name
    dst = safe_join(root, dst_rel)
    if dst == src:
        return _summary(root, src)
    if dst.exists():
        raise HTTPException(status_code=409, detail="대상 폴더에 같은 이름의 문서가 있습니다.")
    with _fs_errors_are_bad_requests("문서 이동"):
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
    return _summary(root, dst)


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
        title = name[:-3] if name.endswith(".md") else (name.rsplit(".", 1)[0] if "." in name else name)
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
