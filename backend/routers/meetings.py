"""회의 녹음 API — 업로드(녹음/파일)·목록·원본 내려주기·메타 수정·삭제·받아쓰기·문서."""
from __future__ import annotations

import os
import shutil
import uuid
from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import meeting_store, meeting_transcribe, orphans
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

#: 녹음 상한. 1시간 회의를 128kbps 로 담으면 60MB 남짓 — 여유를 둔다.
MAX_AUDIO_BYTES = 300 * 1024 * 1024


class MeetingPatch(BaseModel):
    title: str | None = None
    category: str | None = None
    date: str | None = None
    summary: str | None = None
    speakers: dict[str, str] | None = None


class DocBody(BaseModel):
    content: str = ""
    #: 열 때 받은 updated_at. 그 사이 바뀌었으면 409(0 이면 확인하지 않는다).
    base_modified: float = 0.0


class DocRename(BaseModel):
    name: str


def _requeue_stale(user: SessionUser, settings: Settings, items: list[dict]) -> None:
    """서버가 재시작돼 pending 인 채 남은 회의는 다시 받아쓴다."""
    for m in items:
        mid = str(m.get("id") or "")
        if m.get("status") == meeting_store.STATUS_PENDING and mid and not meeting_transcribe.is_running(user, mid):
            meeting_transcribe.start(user, settings, mid)


@router.get("")
def list_meetings(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    items = meeting_store.list_meetings(user, settings)
    _requeue_stale(user, settings, items)
    orphans.sweep(meeting_store.root(user, settings),
                  {str(m.get("id") or "") for m in items}, "audio.",
                  key=f"meetings:{user.username}")
    return items


@router.get("/categories")
def list_categories(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return meeting_store.categories(user, settings)


@router.post("/upload")
async def upload(
    file: UploadFile = File(...),
    title: str = Form(""),
    category: str = Form(""),
    day: str = Form(""),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    name = file.filename or "recording"
    ext = meeting_store.audio_ext(name, file.content_type or "")
    if not ext:
        raise HTTPException(status_code=415, detail="지원하지 않는 녹음 형식입니다(mp3·m4a·wav·webm·ogg·flac).")
    day = meeting_store.check_date(day or date.today().isoformat())
    mid = meeting_store.new_id()
    d = meeting_store.root(user, settings) / mid
    d.mkdir(parents=True, exist_ok=True)
    dest = d / f"audio.{ext}"
    tmp = dest.with_name(f"{dest.name}.upload{os.getpid()}.{uuid.uuid4().hex[:8]}")
    written = 0
    try:
        with tmp.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > min(MAX_AUDIO_BYTES, settings.max_upload_bytes):
                    raise HTTPException(status_code=413, detail="파일이 너무 큽니다(300MB 이하).")
                out.write(chunk)
        if written == 0:
            raise HTTPException(status_code=400, detail="빈 녹음입니다.")
        os.replace(tmp, dest)
        # 브라우저 녹음은 이름이 'recording.webm' 처럼 밋밋하다 — 제목이 없으면 날짜로
        default_title = title.strip() or (f"{day} 회의" if name.lower().startswith("recording") else "")
        meta = meeting_store.register(
            user, settings, filename=name, mime=(file.content_type or meeting_store.AUDIO_TYPES[ext]),
            size=written, ext=ext, day=day, title=default_title, category=category, mid=mid,
        )
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
            shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass
        raise
    meeting_transcribe.start(user, settings, mid)
    return meta


@router.get("/{mid}")
def get_meeting(
    mid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    m = meeting_store.get_meeting(user, settings, mid)
    if m.get("status") == meeting_store.STATUS_PENDING and not meeting_transcribe.is_running(user, mid):
        meeting_transcribe.start(user, settings, mid)
    return m


@router.get("/{mid}/audio")
def get_audio(
    mid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """원본 녹음. <audio> 가 구간 탐색을 하도록 FileResponse(Range 지원)로 준다."""
    m = meeting_store.get_meeting(user, settings, mid)
    ext = str(m.get("ext") or "")
    path = meeting_store.audio_path(user, settings, mid, ext) if ext else None
    if path is None or not path.exists():
        raise HTTPException(status_code=410, detail="녹음 파일이 없습니다.")
    return FileResponse(
        path,
        media_type=str(m.get("mime") or meeting_store.AUDIO_TYPES.get(ext, "application/octet-stream")).split(";")[0],
        headers={
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=3600",
        },
    )


@router.get("/{mid}/transcript")
def get_transcript(
    mid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    meeting_store.get_meeting(user, settings, mid)
    return meeting_store.read_transcript(user, settings, mid)


@router.put("/{mid}")
def update_meeting(
    mid: str,
    req: MeetingPatch,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return meeting_store.update_meta(user, settings, mid, req.model_dump(exclude_none=True))


@router.delete("/{mid}")
def delete_meeting(
    mid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return meeting_store.delete_meeting(user, settings, mid)


@router.post("/{mid}/transcribe")
def retranscribe(
    mid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """받아쓰기를 다시 돌린다(실패했거나 모델을 바꿨을 때)."""
    meeting_store.get_meeting(user, settings, mid)
    if meeting_transcribe.is_running(user, mid):
        return {"ok": True, "started": False, "status": meeting_store.STATUS_PENDING}
    meeting_store.update_meta(user, settings, mid, {"status": meeting_store.STATUS_PENDING, "error": ""})
    started = meeting_transcribe.start(user, settings, mid)
    return {"ok": True, "started": started, "status": meeting_store.STATUS_PENDING}


# ── 문서(요약·정리) ─────────────────────────────────────────────────

@router.get("/{mid}/docs")
def list_docs(
    mid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    meeting_store.get_meeting(user, settings, mid)
    return meeting_store.list_docs(user, settings, mid)


@router.get("/{mid}/docs/{name}")
def read_doc(
    mid: str,
    name: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    meeting_store.get_meeting(user, settings, mid)
    return meeting_store.read_doc(user, settings, mid, name)


@router.put("/{mid}/docs/{name}")
def write_doc(
    mid: str,
    name: str,
    body: DocBody,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return meeting_store.write_doc(user, settings, mid, name, body.content,
                                   base_modified=body.base_modified)


@router.post("/{mid}/docs/{name}/rename")
def rename_doc(
    mid: str,
    name: str,
    body: DocRename,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    meeting_store.get_meeting(user, settings, mid)
    return meeting_store.rename_doc(user, settings, mid, name, body.name)


@router.delete("/{mid}/docs/{name}")
def delete_doc(
    mid: str,
    name: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    meeting_store.get_meeting(user, settings, mid)
    meeting_store.delete_doc(user, settings, mid, name)
    return {"ok": True}
