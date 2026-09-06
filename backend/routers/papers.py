"""논문 API — 업로드·목록·PDF 내려주기·메타 수정·삭제·정보 재추출."""
from __future__ import annotations

import os
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import orphans, paper_extract, paper_store
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/papers", tags=["papers"])

#: 논문 PDF 상한(문서 업로드 상한과 별개 — 논문은 이보다 크지 않다)
MAX_PDF_BYTES = 100 * 1024 * 1024


class PaperPatch(BaseModel):
    title: str | None = None
    #: 폴더처럼 쓰는 분류. 빈 문자열이면 '분류 없음'으로 돌아간다.
    category: str | None = None
    #: 내려받을 때 쓰는 파일 이름(실물은 언제나 paper.pdf)
    filename: str | None = None
    authors: list[str] | None = None
    year: str | None = None
    venue: str | None = None
    abstract: str | None = None
    summary: str | None = None
    key_findings: list[str] | None = None
    methods: str | None = None
    limitations: str | None = None
    keywords: list[str] | None = None
    notes: str | None = None
    starred: bool | None = None
    read_page: int | None = None
    #: 쪽수. 보통은 추출할 때 pypdf 가 채우지만, **스캔본처럼 pypdf 가 못 여는
    #: PDF 는 0 으로 남는다.** 그런 논문은 뷰어(pdf.js)가 실제 쪽수를 알고 있으므로
    #: 한 번 알려 준다 — 0 이면 "읽은 진도"도 계산할 수 없다.
    pages: int | None = None
    tags: list[str] | None = None


def _requeue_stale(user: SessionUser, settings: Settings, papers: list[dict]) -> None:
    """서버가 재시작돼 pending 인 채 남은 논문은 다시 추출한다."""
    for p in papers:
        pid = str(p.get("id") or "")
        if p.get("status") == paper_store.STATUS_PENDING and pid and not paper_extract.is_running(user, pid):
            paper_extract.start(user, settings, pid)


@router.get("")
def list_papers(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    papers = paper_store.list_papers(user, settings)
    _requeue_stale(user, settings, papers)
    orphans.sweep(paper_store.root(user, settings),
                  {str(p.get("id") or "") for p in papers}, paper_store.PDF_NAME,
                  key=f"papers:{user.username}")
    return papers


@router.get("/categories")
def list_categories(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """쓰이고 있는 분류 이름(자동완성용). '/{pid}' 보다 먼저 잡혀야 한다."""
    return {"categories": paper_store.categories(user, settings)}


@router.post("/upload")
async def upload(
    file: UploadFile = File(...),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    name = file.filename or ""
    if not name.lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="PDF 파일만 올릴 수 있습니다.")
    pid = paper_store.new_id()
    d = paper_store.root(user, settings) / pid
    d.mkdir(parents=True, exist_ok=True)
    dest = d / paper_store.PDF_NAME
    tmp = dest.with_name(f"{dest.name}.upload{os.getpid()}.{uuid.uuid4().hex[:8]}")
    written = 0
    head = b""
    try:
        with tmp.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                if not head:
                    head = chunk[:8]
                written += len(chunk)
                if written > min(MAX_PDF_BYTES, settings.max_upload_bytes):
                    raise HTTPException(status_code=413, detail="파일이 너무 큽니다(100MB 이하).")
                out.write(chunk)
        if not head.startswith(b"%PDF"):
            raise HTTPException(status_code=415, detail="PDF 파일이 아닙니다.")
        if written == 0:
            raise HTTPException(status_code=400, detail="빈 파일입니다.")
        os.replace(tmp, dest)
        meta = paper_store.register(user, settings, name, written, pid=pid)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
            dest.unlink(missing_ok=True)
            d.rmdir()
        except OSError:
            pass
        raise
    paper_extract.start(user, settings, pid)
    return meta


@router.get("/{pid}")
def get_paper(
    pid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    p = paper_store.get_paper(user, settings, pid)
    if p.get("status") == paper_store.STATUS_PENDING and not paper_extract.is_running(user, pid):
        paper_extract.start(user, settings, pid)
    return p


@router.get("/{pid}/file")
def get_file(
    pid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """PDF 원본. 브라우저 안(pdf.js)에서 열리도록 inline 으로 준다."""
    p = paper_store.get_paper(user, settings, pid)
    path = paper_store.pdf_path(user, settings, pid)
    if not path.exists():
        raise HTTPException(status_code=410, detail="PDF 파일이 없습니다.")
    return FileResponse(
        path,
        media_type="application/pdf",
        headers={
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=3600",
            "X-Paper-Filename": str(p.get("filename") or "paper.pdf").encode("ascii", "ignore").decode() or "paper.pdf",
        },
    )


@router.put("/{pid}")
def update_paper(
    pid: str,
    req: PaperPatch,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return paper_store.update_meta(user, settings, pid, req.model_dump(exclude_none=True))


@router.delete("/{pid}")
def delete_paper(
    pid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return paper_store.delete_paper(user, settings, pid)


@router.post("/{pid}/extract")
def reextract(
    pid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """정보 추출을 다시 돌린다(실패했거나 모델을 바꿨을 때)."""
    paper_store.get_paper(user, settings, pid)
    if paper_extract.is_running(user, pid):
        return {"ok": True, "started": False, "status": paper_store.STATUS_PENDING}
    paper_store.update_meta(user, settings, pid, {"status": paper_store.STATUS_PENDING, "error": ""})
    started = paper_extract.start(user, settings, pid)
    return {"ok": True, "started": started, "status": paper_store.STATUS_PENDING}
