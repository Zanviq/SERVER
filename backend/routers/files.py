"""파일 관리 API: 목록·업로드·다운로드·삭제·폴더관리.

모든 경로는 storage_root 기준 상대경로로 주고받는다.
"""
from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from ..config import get_settings
from ..schemas import (
    FileEntry,
    ListResponse,
    MakeDirRequest,
    MessageResponse,
    RenameRequest,
)
from ..security_paths import safe_join, to_rel

logger = logging.getLogger("twoems.files")
router = APIRouter(prefix="/api/files", tags=["files"])

# Windows에서 파일명에 쓸 수 없는 문자 (다른 OS와의 호환을 위해 공통 차단)
_ILLEGAL_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _sanitize_filename(name: str) -> str:
    """파일명에서 OS 금지 문자를 제거하고 안전한 단일 파일명으로 정규화.

    정상적인 이름(예: 's-team.md')은 그대로 둔다.
    """
    base = Path(name).name  # 경로 구분자 제거
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
def list_dir(path: str = Query("", description="저장소 루트 기준 상대경로")):
    """디렉토리 내용 나열. 폴더 먼저, 이름순 정렬."""
    settings = get_settings()
    target = safe_join(settings.storage_root, path)

    if not target.exists():
        raise HTTPException(status_code=404, detail="경로를 찾을 수 없습니다.")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="디렉토리가 아닙니다.")

    entries = [_entry(settings.storage_root, c) for c in target.iterdir()]
    entries.sort(key=lambda e: (not e.is_dir, e.name.lower()))
    return ListResponse(path=to_rel(settings.storage_root, target), entries=entries)


@router.post("/upload", response_model=MessageResponse)
async def upload(
    file: UploadFile = File(...),
    path: str = Query("", description="업로드 대상 폴더 (저장소 루트 기준)"),
):
    """파일 업로드. path 폴더 하위에 원본 파일명으로 저장."""
    settings = get_settings()

    if not file.filename:
        raise HTTPException(status_code=400, detail="파일명이 없습니다.")

    dest_dir = safe_join(settings.storage_root, path)
    # 경로 구분자 + OS 금지 문자 제거 (정상 파일명은 변화 없음).
    safe_name = _sanitize_filename(file.filename)
    dest = safe_join(
        settings.storage_root,
        f"{to_rel(settings.storage_root, dest_dir)}/{safe_name}",
    )

    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.exception("업로드 폴더 생성 실패: %s", dest_dir)
        detail = f"폴더 생성 실패: {e}" if settings.debug else "폴더 생성에 실패했습니다."
        raise HTTPException(status_code=500, detail=detail) from e

    written = 0
    try:
        with dest.open("wb") as out:
            while chunk := await file.read(1024 * 1024):  # 1MB 청크 스트리밍
                written += len(chunk)
                if written > settings.max_upload_bytes:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="파일이 너무 큽니다.")
                out.write(chunk)
    except HTTPException:
        raise
    except OSError as e:
        # 서버 경로는 로그에만; 클라이언트엔 일반 메시지(운영) 또는 상세(DEBUG)
        logger.exception("파일 저장 실패: %s", dest)
        detail = (
            f"저장 실패 [{e.__class__.__name__}] {dest.name}: {e}"
            if settings.debug
            else "파일 저장에 실패했습니다."
        )
        raise HTTPException(status_code=500, detail=detail) from e

    return MessageResponse(message=f"업로드 완료: {to_rel(settings.storage_root, dest)}")


@router.get("/download")
def download(path: str = Query(..., description="다운로드할 파일 (저장소 루트 기준)")):
    """파일 다운로드."""
    settings = get_settings()
    target = safe_join(settings.storage_root, path)

    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")

    return FileResponse(
        target, filename=target.name, media_type="application/octet-stream"
    )


@router.post("/mkdir", response_model=MessageResponse)
def make_dir(req: MakeDirRequest):
    """폴더 생성."""
    settings = get_settings()
    target = safe_join(settings.storage_root, req.path)
    if target.exists():
        raise HTTPException(status_code=409, detail="이미 존재합니다.")
    target.mkdir(parents=True)
    return MessageResponse(message=f"폴더 생성: {to_rel(settings.storage_root, target)}")


@router.post("/rename", response_model=MessageResponse)
def rename(req: RenameRequest):
    """파일/폴더 이동 또는 이름변경."""
    settings = get_settings()
    src = safe_join(settings.storage_root, req.src)
    dst = safe_join(settings.storage_root, req.dst)

    if not src.exists():
        raise HTTPException(status_code=404, detail="원본을 찾을 수 없습니다.")
    if dst.exists():
        raise HTTPException(status_code=409, detail="대상이 이미 존재합니다.")

    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return MessageResponse(message=f"이동: {req.src} -> {req.dst}")


@router.delete("/delete", response_model=MessageResponse)
def delete(path: str = Query(..., description="삭제할 파일/폴더 (저장소 루트 기준)")):
    """파일 또는 폴더(재귀) 삭제."""
    settings = get_settings()
    target = safe_join(settings.storage_root, path)

    # 루트 자체 삭제 방지.
    if target == settings.storage_root:
        raise HTTPException(status_code=400, detail="루트는 삭제할 수 없습니다.")
    if not target.exists():
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다.")

    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return MessageResponse(message=f"삭제: {path}")
