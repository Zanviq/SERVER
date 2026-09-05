"""회의 녹음 저장소 — 사용자별 meetings/ 아래에 회의마다 폴더 하나.

users/<u>/meetings/
  index.json              {meetings: [meta, ...]}   목록용
  <id>/audio.<ext>        원본 녹음(브라우저 녹음 또는 올린 파일). 절대 손대지 않는다.
  <id>/transcript.json    받아쓰기 {segments: [{start, end, speaker, text}], text}
  <id>/docs/<name>.md     요약·정리 문서(AI 가 만들거나 사용자가 편집). 노트와 저장소가 다르다.
  <id>/chat.json          이 회의에서 나눈 AI 대화(chat_store)

meta:
  {id, title, date(YYYY-MM-DD), category, filename, mime, size, duration,
   created_at, updated_at, status: pending|ready|failed, error, transcribed_at,
   speakers: {"화자 1": "김철수", ...}, summary, segments(개수), docs(개수)}

받아쓰기 상태(status)는 백그라운드(meeting_transcribe)가 바꾼다. 발화자 구분은
모델이 목소리로 짐작한 라벨("화자 1", "화자 2")이고, 이름은 speakers 로 사용자가 붙인다.
"""
from __future__ import annotations

import re
import shutil
import time
import uuid
from datetime import date
from pathlib import Path

from fastapi import HTTPException

from . import json_store
from .auth import SessionUser
from .config import Settings

CHAT_NAME = "chat.json"
TRANSCRIPT_NAME = "transcript.json"
DOCS_DIRNAME = "docs"

MAX_MEETINGS = 1000
MAX_SHORT = 200
MAX_SUMMARY = 6000
MAX_DOC_CHARS = 400_000
MAX_DOCS = 100

STATUS_PENDING = "pending"
STATUS_READY = "ready"
STATUS_FAILED = "failed"

#: 받아들이는 녹음 형식(확장자 → MIME). 브라우저 녹음은 webm/mp4, 올리는 건 mp3·m4a·wav 가 대부분.
AUDIO_TYPES = {
    "webm": "audio/webm",
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "flac": "audio/flac",
    "aac": "audio/aac",
    "aiff": "audio/aiff",
}

_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def sanitize_filename(name: str) -> str:
    base = Path(str(name or "")).name
    cleaned = _ILLEGAL.sub("_", base).strip().strip(".")
    return (cleaned or "recording")[:200]


def audio_ext(filename: str, mime: str = "") -> str:
    """파일 이름·MIME 에서 저장할 확장자를 고른다. 모르는 형식이면 빈 문자열."""
    ext = Path(str(filename or "")).suffix.lower().lstrip(".")
    if ext in AUDIO_TYPES:
        return ext
    m = (mime or "").split(";")[0].strip().lower()
    for k, v in AUDIO_TYPES.items():
        if v == m:
            return k
    if m in ("video/webm",):
        return "webm"
    if m in ("video/mp4", "audio/x-m4a"):
        return "m4a"
    if m in ("audio/x-wav", "audio/wave"):
        return "wav"
    if m in ("audio/mp3",):
        return "mp3"
    return ""


def root(user: SessionUser, settings: Settings) -> Path:
    base = settings.user_root(user.username) / "meetings"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _index_path(user: SessionUser, settings: Settings) -> Path:
    return root(user, settings) / "index.json"


def meeting_dir(user: SessionUser, settings: Settings, mid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", mid or ""):
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다.")
    return root(user, settings) / mid


def audio_path(user: SessionUser, settings: Settings, mid: str, ext: str) -> Path:
    return meeting_dir(user, settings, mid) / f"audio.{ext}"


def chat_path(user: SessionUser, settings: Settings, mid: str) -> Path:
    return meeting_dir(user, settings, mid) / CHAT_NAME


def transcript_path(user: SessionUser, settings: Settings, mid: str) -> Path:
    return meeting_dir(user, settings, mid) / TRANSCRIPT_NAME


def docs_dir(user: SessionUser, settings: Settings, mid: str) -> Path:
    return meeting_dir(user, settings, mid) / DOCS_DIRNAME


def _load(user: SessionUser, settings: Settings) -> list[dict]:
    data = json_store.read_json_strict(_index_path(user, settings), None)
    if not isinstance(data, dict):
        return []
    items = data.get("meetings")
    return [m for m in items if isinstance(m, dict)] if isinstance(items, list) else []


def _save(items: list[dict], user: SessionUser, settings: Settings) -> None:
    json_store.write_atomic(_index_path(user, settings), {"meetings": items})


def _now() -> float:
    return time.time()


def _s(v, limit: int = MAX_SHORT) -> str:
    return str(v or "").strip()[:limit]


def check_date(s: str) -> str:
    s = str(s or "").strip()
    if not _DATE.match(s):
        raise HTTPException(status_code=400, detail="날짜는 YYYY-MM-DD 형식이어야 합니다.")
    try:
        date.fromisoformat(s)
    except ValueError:
        raise HTTPException(status_code=400, detail="없는 날짜입니다.")
    return s


def _new_meta(filename: str, mime: str, size: int, ext: str, day: str, title: str = "",
              category: str = "") -> dict:
    now = _now()
    return {
        "id": uuid.uuid4().hex,
        "title": _s(title) or re.sub(r"\.[a-z0-9]+$", "", filename, flags=re.I) or "회의",
        "date": day,
        "category": _s(category, 60),
        "filename": filename,
        "mime": _s(mime, 80),
        "ext": ext,
        "size": int(size),
        "duration": 0.0,
        "created_at": now,
        "updated_at": now,
        "status": STATUS_PENDING,
        "error": "",
        "transcribed_at": 0.0,
        "speakers": {},
        "summary": "",
        "segments": 0,
        "docs": 0,
    }


# ── 조회 ─────────────────────────────────────────────────────────────

def list_meetings(user: SessionUser, settings: Settings) -> list[dict]:
    items = _load(user, settings)
    items.sort(key=lambda m: (str(m.get("date") or ""), float(m.get("created_at") or 0)), reverse=True)
    return items


def get_meeting(user: SessionUser, settings: Settings, mid: str) -> dict:
    m = find_meeting(user, settings, mid)
    if m is None:
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다.")
    return m


def find_meeting(user: SessionUser, settings: Settings, mid: str) -> dict | None:
    return next((m for m in _load(user, settings) if m.get("id") == mid), None)


def categories(user: SessionUser, settings: Settings) -> list[str]:
    seen: list[str] = []
    for m in _load(user, settings):
        c = str(m.get("category") or "").strip()
        if c and c not in seen:
            seen.append(c)
    return sorted(seen)


def read_transcript(user: SessionUser, settings: Settings, mid: str) -> dict:
    data = json_store.read_json(transcript_path(user, settings, mid), None)
    if not isinstance(data, dict):
        return {"segments": [], "text": ""}
    segs = data.get("segments")
    segs = [s for s in segs if isinstance(s, dict)] if isinstance(segs, list) else []
    return {"segments": segs, "text": str(data.get("text") or "")}


def write_transcript(user: SessionUser, settings: Settings, mid: str, segments: list[dict], text: str) -> None:
    json_store.write_atomic(transcript_path(user, settings, mid), {"segments": segments, "text": text})


def transcript_text(user: SessionUser, settings: Settings, mid: str, speakers: dict | None = None) -> str:
    """모델·화면용 평문. 화자 라벨을 사용자가 붙인 이름으로 바꿔 준다."""
    t = read_transcript(user, settings, mid)
    names = speakers or {}
    lines = []
    for s in t["segments"]:
        who = str(s.get("speaker") or "").strip()
        who = names.get(who) or who
        text = str(s.get("text") or "").strip()
        if not text:
            continue
        stamp = str(s.get("start") or "")
        head = " ".join(x for x in (f"[{stamp}]" if stamp else "", f"{who}:" if who else "") if x)
        lines.append(f"{head} {text}".strip())
    return "\n".join(lines) if lines else t["text"]


# ── 변경 ─────────────────────────────────────────────────────────────

def new_id() -> str:
    return uuid.uuid4().hex


def register(user: SessionUser, settings: Settings, *, filename: str, mime: str, size: int, ext: str,
             day: str, title: str = "", category: str = "", mid: str = "") -> dict:
    """올린 녹음을 목록에 올린다. 파일은 호출한 쪽이 audio_path 에 이미 놓았다."""
    idx = _index_path(user, settings)
    meta = _new_meta(sanitize_filename(filename), mime, size, ext, check_date(day), title, category)
    if mid:
        meta["id"] = mid
    with json_store.lock_for(idx):
        items = _load(user, settings)
        if len(items) >= MAX_MEETINGS:
            raise HTTPException(status_code=409, detail=f"회의는 {MAX_MEETINGS}건까지입니다.")
        items.append(meta)
        _save(items, user, settings)
    return meta


def update_meta(user: SessionUser, settings: Settings, mid: str, patch: dict) -> dict:
    idx = _index_path(user, settings)
    with json_store.lock_for(idx):
        items = _load(user, settings)
        i = next((i for i, m in enumerate(items) if m.get("id") == mid), -1)
        if i < 0:
            raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다.")
        m = dict(items[i])
        if "title" in patch and patch["title"] is not None:
            m["title"] = _s(patch["title"]) or m.get("title") or "회의"
        if "category" in patch and patch["category"] is not None:
            m["category"] = _s(patch["category"], 60)
        if "date" in patch and patch["date"] is not None:
            m["date"] = check_date(patch["date"])
        if "summary" in patch and patch["summary"] is not None:
            m["summary"] = _s(patch["summary"], MAX_SUMMARY)
        if "error" in patch and patch["error"] is not None:
            m["error"] = _s(patch["error"], 300)
        if "speakers" in patch and isinstance(patch["speakers"], dict):
            m["speakers"] = {_s(k, 60): _s(v, 60) for k, v in patch["speakers"].items() if _s(k, 60)}
        if "status" in patch and patch["status"] in (STATUS_PENDING, STATUS_READY, STATUS_FAILED):
            m["status"] = patch["status"]
        for k in ("transcribed_at", "duration"):
            if k in patch and patch[k] is not None:
                try:
                    m[k] = float(patch[k])
                except (TypeError, ValueError):
                    pass
        for k in ("segments", "docs"):
            if k in patch and patch[k] is not None:
                try:
                    m[k] = max(0, int(patch[k]))
                except (TypeError, ValueError):
                    pass
        # 문서 수만 다시 세는 건 "수정"이 아니다
        if set(patch) - {"docs", "segments"}:
            m["updated_at"] = _now()
        items[i] = m
        _save(items, user, settings)
    return m


def delete_meeting(user: SessionUser, settings: Settings, mid: str) -> dict:
    """회의 폴더를 휴지통으로 옮기고 목록에서 뺀다(논문과 같은 순서 — 목록 먼저, 폴더는 락 밖)."""
    from . import trash

    idx = _index_path(user, settings)
    with json_store.lock_for(idx):
        items = _load(user, settings)
        meta = next((m for m in items if m.get("id") == mid), None)
        if meta is None:
            raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다.")
        _save([m for m in items if m.get("id") != mid], user, settings)
    d = meeting_dir(user, settings, mid)
    try:
        d.mkdir(parents=True, exist_ok=True)
        json_store.write_atomic(d / "meta.json", meta)
        trash.move_meeting_to_trash(d, meta, user, settings)
    except BaseException:
        with json_store.lock_for(idx):
            back = _load(user, settings)
            if not any(m.get("id") == mid for m in back):
                back.append(meta)
                _save(back, user, settings)
        raise
    return {"ok": True, "id": mid, "title": meta.get("title", "")}


def restore_dir(user: SessionUser, settings: Settings, src: Path, mid: str) -> dict:
    """휴지통에 있던 회의 폴더를 제자리로. 휴지통 락 안에서 불린다."""
    meta = json_store.read_json(src / "meta.json", None)
    if not isinstance(meta, dict):
        meta = _new_meta("recording", "", 0, "", date.today().isoformat())
    if not re.fullmatch(r"[0-9a-f]{32}", mid or ""):
        mid = uuid.uuid4().hex
    idx = _index_path(user, settings)
    with json_store.lock_for(idx):
        items = _load(user, settings)
        if any(m.get("id") == mid for m in items) or (root(user, settings) / mid).exists():
            mid = uuid.uuid4().hex
        meta["id"] = mid
        dest = root(user, settings) / mid
        shutil.move(str(src), str(dest))
        (dest / "meta.json").unlink(missing_ok=True)
        meta["updated_at"] = _now()
        items.append(meta)
        _save(items, user, settings)
    return meta


# ── 문서(요약·정리) ─────────────────────────────────────────────────

def doc_name(name: str) -> str:
    """문서 이름 → 파일 이름(.md). 경로 구분자·제어문자는 막는다."""
    base = str(name or "").strip()
    base = re.sub(r"\.md$", "", base, flags=re.I)
    base = _ILLEGAL.sub("_", base).strip().strip(".")
    if not base or base in (".", ".."):
        raise HTTPException(status_code=400, detail="문서 이름이 비어 있습니다.")
    return base[:120]


def _doc_path(user: SessionUser, settings: Settings, mid: str, name: str) -> Path:
    return docs_dir(user, settings, mid) / f"{doc_name(name)}.md"


def list_docs(user: SessionUser, settings: Settings, mid: str) -> list[dict]:
    d = docs_dir(user, settings, mid)
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.md"), key=lambda p: p.stat().st_mtime):
        try:
            st = p.stat()
        except OSError:
            continue
        out.append({"name": p.stem, "size": st.st_size, "updated_at": st.st_mtime})
    return out


def read_doc(user: SessionUser, settings: Settings, mid: str, name: str) -> dict:
    p = _doc_path(user, settings, mid, name)
    if not p.exists():
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    return {"name": p.stem, "content": p.read_text(encoding="utf-8", errors="replace"),
            "updated_at": p.stat().st_mtime}


def write_doc(user: SessionUser, settings: Settings, mid: str, name: str, content: str,
              *, append: bool = False) -> dict:
    get_meeting(user, settings, mid)
    p = _doc_path(user, settings, mid, name)
    p.parent.mkdir(parents=True, exist_ok=True)
    existed = p.exists()
    if not existed and len(list_docs(user, settings, mid)) >= MAX_DOCS:
        raise HTTPException(status_code=409, detail=f"문서는 회의당 {MAX_DOCS}개까지입니다.")
    body = str(content or "")
    if append and existed:
        old = p.read_text(encoding="utf-8", errors="replace")
        body = old + ("" if not old or old.endswith("\n") else "\n") + body
    if len(body) > MAX_DOC_CHARS:
        raise HTTPException(status_code=413, detail="문서가 너무 큽니다.")
    tmp = p.with_name(f"{p.name}.tmp{uuid.uuid4().hex[:6]}")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(p)
    _recount(user, settings, mid)
    return {"name": p.stem, "content": body, "updated_at": p.stat().st_mtime, "created": not existed}


def delete_doc(user: SessionUser, settings: Settings, mid: str, name: str) -> None:
    p = _doc_path(user, settings, mid, name)
    if not p.exists():
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    p.unlink()
    _recount(user, settings, mid)


def rename_doc(user: SessionUser, settings: Settings, mid: str, name: str, new_name: str) -> dict:
    src = _doc_path(user, settings, mid, name)
    dst = _doc_path(user, settings, mid, new_name)
    if not src.exists():
        raise HTTPException(status_code=404, detail="문서를 찾을 수 없습니다.")
    if dst.exists() and dst != src:
        raise HTTPException(status_code=409, detail="같은 이름의 문서가 있습니다.")
    src.rename(dst)
    return {"name": dst.stem}


def _recount(user: SessionUser, settings: Settings, mid: str) -> None:
    try:
        update_meta(user, settings, mid, {"docs": len(list_docs(user, settings, mid))})
    except HTTPException:
        pass


def brief(m: dict) -> dict:
    return {
        "id": m.get("id", ""),
        "title": m.get("title", ""),
        "date": m.get("date", ""),
        "category": m.get("category", ""),
        "status": m.get("status", ""),
        "summary": str(m.get("summary") or "")[:300],
        "docs": int(m.get("docs") or 0),
    }
