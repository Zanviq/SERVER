"""파일 관리 API: 목록·업로드·다운로드·삭제·폴더관리.

scope(common|me) + path(스코프 루트 기준 상대경로)로 동작.
me 스코프는 항상 세션 사용자의 개인 폴더로만 해석된다(격리).
"""
from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from ..auth import SessionUser, require_session
from ..config import Settings, get_settings
from ..schemas import (
    FileEntry,
    ListResponse,
    MakeDirRequest,
    MessageResponse,
    RenameRequest,
)
from ..security_paths import safe_join, to_rel
from ..storage import resolve, scope_root

logger = logging.getLogger("twoems.files")
router = APIRouter(prefix="/api/files", tags=["files"])

_ILLEGAL_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _sanitize_filename(name: str) -> str:
    base = Path(name).name
    cleaned = _ILLEGAL_FILENAME.sub("_", base).strip().strip(".")
    return cleaned or "untitled"


def _entry(root: Path, p: Path) -> FileEntry:
    st = p.stat()
    is_dir = p.is_dir()
    return FileEntry(
        name=p.name,
        path=to_rel(root, p),
        is_dir=is_dir,
        size=0 if is_dir else st.st_size,
        modified=st.st_mtime,
    )


@router.get("/list", response_model=ListResponse)
def list_dir(
    scope: str = Query("common"),
    path: str = Query(""),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    root = scope_root(scope, user, settings)
    target = resolve(scope, path, user, settings)
    if not target.exists():
        raise HTTPException(status_code=404, detail="경로를 찾을 수 없습니다.")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="디렉토리가 아닙니다.")
    entries = [_entry(root, c) for c in target.iterdir()]
    entries.sort(key=lambda e: (not e.is_dir, e.name.lower()))
    return ListResponse(path=to_rel(root, target), entries=entries)


@router.post("/upload", response_model=MessageResponse)
async def upload(
    file: UploadFile = File(...),
    scope: str = Query("common"),
    path: str = Query(""),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="파일명이 없습니다.")
    root = scope_root(scope, user, settings)
    dest_dir = resolve(scope, path, user, settings)
    safe_name = _sanitize_filename(file.filename)
    dest = safe_join(root, f"{to_rel(root, dest_dir)}/{safe_name}")

    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.exception("업로드 폴더 생성 실패: %s", dest_dir)
        detail = f"폴더 생성 실패: {e}" if settings.debug else "폴더 생성에 실패했습니다."
        raise HTTPException(status_code=500, detail=detail) from e

    written = 0
    try:
        with dest.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > settings.max_upload_bytes:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="파일이 너무 큽니다.")
                out.write(chunk)
    except HTTPException:
        raise
    except OSError as e:
        logger.exception("파일 저장 실패: %s", dest)
        detail = (
            f"저장 실패 [{e.__class__.__name__}] {dest.name}: {e}"
            if settings.debug
            else "파일 저장에 실패했습니다."
        )
        raise HTTPException(status_code=500, detail=detail) from e

    return MessageResponse(message=f"업로드 완료: {to_rel(root, dest)}")


@router.get("/download")
def download(
    scope: str = Query("common"),
    path: str = Query(...),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    target = resolve(scope, path, user, settings)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    return FileResponse(
        target, filename=target.name, media_type="application/octet-stream"
    )


@router.post("/mkdir", response_model=MessageResponse)
def make_dir(
    req: MakeDirRequest,
    scope: str = Query("common"),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    root = scope_root(scope, user, settings)
    target = resolve(scope, req.path, user, settings)
    if target.exists():
        raise HTTPException(status_code=409, detail="이미 존재합니다.")
    target.mkdir(parents=True)
    return MessageResponse(message=f"폴더 생성: {to_rel(root, target)}")


@router.post("/rename", response_model=MessageResponse)
def rename(
    req: RenameRequest,
    scope: str = Query("common"),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    src = resolve(scope, req.src, user, settings)
    dst = resolve(scope, req.dst, user, settings)
    if not src.exists():
        raise HTTPException(status_code=404, detail="원본을 찾을 수 없습니다.")
    if dst.exists():
        raise HTTPException(status_code=409, detail="대상이 이미 존재합니다.")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return MessageResponse(message=f"이동: {req.src} -> {req.dst}")


@router.delete("/delete", response_model=MessageResponse)
def delete(
    scope: str = Query("common"),
    path: str = Query(...),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    root = scope_root(scope, user, settings)
    target = resolve(scope, path, user, settings)
    if target == root:
        raise HTTPException(status_code=400, detail="루트는 삭제할 수 없습니다.")
    if not target.exists():
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다.")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return MessageResponse(message=f"삭제: {path}")
