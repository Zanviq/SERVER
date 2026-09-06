"""논문 저장소 — 사용자별 papers/ 아래에 논문마다 폴더 하나.

users/<u>/papers/
  index.json         {papers: [meta, ...]}   목록·검색용(본문은 없다)
  <id>/paper.pdf     원본 그대로(파일 이름은 meta.filename 에)
  <id>/chat.json     이 논문에서 나눈 AI 대화(chat_store)
  <id>/text.txt      pypdf 로 뽑은 본문(있으면). 스킬이 "논문 본문 읽기"에 쓴다.

meta:
  {id, filename, size, pages, created_at, updated_at,
   status: pending|ready|failed, error, extracted_at,
   title, authors[], year, venue, abstract, summary, key_findings[],
   methods, limitations, keywords[], sections[],
   starred, notes, read_page, tags[]}

상태(status)는 백그라운드 추출(paper_extract)이 바꾼다. 업로드 직후엔 pending,
끝나면 ready, 모델이 실패하면 failed(사용자가 다시 시킬 수 있다).
"""
from __future__ import annotations

import logging
import re
import shutil
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

from . import json_store
from .auth import SessionUser
from .config import Settings

logger = logging.getLogger("server.papers")

PDF_NAME = "paper.pdf"
CHAT_NAME = "chat.json"
TEXT_NAME = "text.txt"

MAX_PAPERS = 500
MAX_SHORT = 300
MAX_TEXT = 6000
MAX_LIST = 20

STATUS_PENDING = "pending"
STATUS_READY = "ready"
STATUS_FAILED = "failed"

_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def sanitize_filename(name: str) -> str:
    base = Path(str(name or "")).name
    cleaned = _ILLEGAL.sub("_", base).strip().strip(".")
    return (cleaned or "paper.pdf")[:200]


def root(user: SessionUser, settings: Settings) -> Path:
    base = settings.user_root(user.username) / "papers"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _index_path(user: SessionUser, settings: Settings) -> Path:
    return root(user, settings) / "index.json"


def paper_dir(user: SessionUser, settings: Settings, pid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", pid or ""):
        raise HTTPException(status_code=404, detail="논문을 찾을 수 없습니다.")
    return root(user, settings) / pid


def pdf_path(user: SessionUser, settings: Settings, pid: str) -> Path:
    return paper_dir(user, settings, pid) / PDF_NAME


def chat_path(user: SessionUser, settings: Settings, pid: str) -> Path:
    return paper_dir(user, settings, pid) / CHAT_NAME


def text_path(user: SessionUser, settings: Settings, pid: str) -> Path:
    return paper_dir(user, settings, pid) / TEXT_NAME


def _load(user: SessionUser, settings: Settings) -> list[dict]:
    data = json_store.read_json_strict(_index_path(user, settings), None)
    if not isinstance(data, dict):
        return []
    papers = data.get("papers")
    return [p for p in papers if isinstance(p, dict)] if isinstance(papers, list) else []


def _save(papers: list[dict], user: SessionUser, settings: Settings) -> None:
    json_store.write_atomic(_index_path(user, settings), {"papers": papers})


def _now() -> float:
    return time.time()


def _s(v, limit: int = MAX_TEXT) -> str:
    return str(v or "").strip()[:limit]


def _strs(v, limit: int = MAX_SHORT, count: int = MAX_LIST) -> list[str]:
    if isinstance(v, str):
        v = [p.strip() for p in v.replace("\n", ",").split(",")]
    if not isinstance(v, (list, tuple)):
        return []
    out: list[str] = []
    for p in v:
        s = str(p or "").strip()[:limit]
        if s and s not in out:
            out.append(s)
        if len(out) >= count:
            break
    return out


def _new_meta(filename: str, size: int) -> dict:
    now = _now()
    return {
        "id": uuid.uuid4().hex,
        "filename": filename,
        "size": int(size),
        "pages": 0,
        "created_at": now,
        "updated_at": now,
        "status": STATUS_PENDING,
        "error": "",
        "extracted_at": 0.0,
        # 제목을 모르는 동안은 파일 이름(확장자 뺀 것)으로 부른다
        "title": re.sub(r"\.pdf$", "", filename, flags=re.I),
        "authors": [],
        "year": "",
        "venue": "",
        "abstract": "",
        "summary": "",
        "key_findings": [],
        "methods": "",
        "limitations": "",
        "keywords": [],
        "sections": [],
        "starred": False,
        "notes": "",
        "read_page": 1,
        "tags": [],
        # 폴더처럼 쓰는 분류. 빈 문자열이면 '분류 없음'으로 묶인다.
        "category": "",
    }


def pdf_filename(name: str) -> str:
    """사용자가 고친 파일 이름. 확장자는 .pdf 로 지킨다(내려받을 때 열려야 한다)."""
    base = sanitize_filename(name)
    if not base.lower().endswith(".pdf"):
        base = f"{base}.pdf"
    return base[:200]


# ── 조회 ─────────────────────────────────────────────────────────────

def list_papers(user: SessionUser, settings: Settings) -> list[dict]:
    papers = _load(user, settings)
    # 별표 → 최근 순
    papers.sort(key=lambda p: (not p.get("starred"), -float(p.get("updated_at") or 0)))
    return papers


def categories(user: SessionUser, settings: Settings) -> list[str]:
    """쓰이고 있는 분류 이름. 따로 저장하지 않고 논문에서 모은다(어긋날 일이 없다)."""
    out: list[str] = []
    for p in _load(user, settings):
        c = _s(p.get("category"), MAX_SHORT)
        if c and c.lower() not in {o.lower() for o in out}:
            out.append(c)
    return sorted(out, key=str.lower)


def get_paper(user: SessionUser, settings: Settings, pid: str) -> dict:
    p = next((p for p in _load(user, settings) if p.get("id") == pid), None)
    if p is None:
        raise HTTPException(status_code=404, detail="논문을 찾을 수 없습니다.")
    return p


def find_paper(user: SessionUser, settings: Settings, pid: str) -> dict | None:
    return next((p for p in _load(user, settings) if p.get("id") == pid), None)


def read_text(user: SessionUser, settings: Settings, pid: str) -> str:
    p = text_path(user, settings, pid)
    if not p.exists():
        return ""
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


# ── 변경 ─────────────────────────────────────────────────────────────

def new_id() -> str:
    return uuid.uuid4().hex


def register(user: SessionUser, settings: Settings, filename: str, size: int,
             pid: str = "") -> dict:
    """업로드된 PDF 를 목록에 올린다. 파일은 호출한 쪽이 pdf_path 에 이미 놓았다."""
    idx = _index_path(user, settings)
    meta = _new_meta(sanitize_filename(filename), size)
    if pid:
        meta["id"] = pid
    # 목록에 있으면 폴더도 있다(회의와 같은 규칙) — 대화·본문 저장이 폴더 없음을
    # "지워졌다"로 읽을 수 있어야 지운 논문을 되살리지 않는다.
    paper_dir(user, settings, meta["id"]).mkdir(parents=True, exist_ok=True)
    with json_store.lock_for(idx):
        papers = _load(user, settings)
        if len(papers) >= MAX_PAPERS:
            raise HTTPException(status_code=409, detail=f"논문은 {MAX_PAPERS}편까지입니다.")
        papers.append(meta)
        _save(papers, user, settings)
    return meta


def update_meta(user: SessionUser, settings: Settings, pid: str, patch: dict) -> dict:
    """메타를 부분 수정한다(사용자 편집·추출 결과 모두 이 길로)."""
    idx = _index_path(user, settings)
    with json_store.lock_for(idx):
        papers = _load(user, settings)
        i = next((i for i, p in enumerate(papers) if p.get("id") == pid), -1)
        if i < 0:
            raise HTTPException(status_code=404, detail="논문을 찾을 수 없습니다.")
        p = dict(papers[i])
        old_title = str(p.get("title") or "")
        for k in ("title", "year", "venue", "category"):
            if k in patch and patch[k] is not None:
                p[k] = _s(patch[k], MAX_SHORT)
        # 파일 이름은 메타일 뿐이다(실물은 언제나 paper.pdf) — 내려받을 때 쓰인다
        if patch.get("filename"):
            p["filename"] = pdf_filename(patch["filename"])
        for k in ("abstract", "summary", "methods", "limitations", "notes", "error"):
            if k in patch and patch[k] is not None:
                p[k] = _s(patch[k], MAX_TEXT * 2 if k == "notes" else MAX_TEXT)
        for k in ("authors", "key_findings", "keywords", "sections", "tags"):
            if k in patch and patch[k] is not None:
                p[k] = _strs(patch[k], MAX_SHORT, 40 if k == "sections" else MAX_LIST)
        if "starred" in patch and patch["starred"] is not None:
            p["starred"] = bool(patch["starred"])
        if "read_page" in patch and patch["read_page"] is not None:
            try:
                p["read_page"] = max(1, int(patch["read_page"]))
            except (TypeError, ValueError):
                pass
        if "pages" in patch and patch["pages"] is not None:
            try:
                p["pages"] = max(0, int(patch["pages"]))
            except (TypeError, ValueError):
                pass
        if "status" in patch and patch["status"] in (STATUS_PENDING, STATUS_READY, STATUS_FAILED):
            p["status"] = patch["status"]
        if "extracted_at" in patch and patch["extracted_at"] is not None:
            p["extracted_at"] = float(patch["extracted_at"])
        if not p.get("title"):
            p["title"] = re.sub(r"\.pdf$", "", str(p.get("filename") or ""), flags=re.I) or "(제목 없음)"
        # 읽던 페이지만 바꾸는 건 "수정"이 아니다 — 목록 순서가 매번 튀지 않게
        if set(patch) - {"read_page"}:
            p["updated_at"] = _now()
        papers[i] = p
        _save(papers, user, settings)
    _follow_title_in_vocab(user, settings, old_title, str(p.get("title") or ""))
    return p


def _follow_title_in_vocab(user: SessionUser, settings: Settings, old: str, new: str) -> None:
    """제목이 바뀌면 단어장 태그도 따라간다.

    이 화면에서 넣은 단어에는 논문 제목이 태그로 붙는데, 올린 직후에는 제목이
    파일 이름이고 정보 추출이 끝나면 진짜 제목으로 바뀐다. 태그를 그대로 두면
    그 사이에 넣은 단어가 논문 단어장 탭(제목으로 거른다)에서 사라진다.
    단어장 락은 논문 목록 락 **밖에서** 잡는다(교착 방지).
    """
    if not old or not new or old == new:
        return
    from . import vocab_store

    try:
        vocab_store.rename_tag(user, settings, old, new)
    except Exception:  # noqa: BLE001
        logger.exception("논문 제목 변경을 단어장 태그에 반영하지 못했다: %s → %s", old, new)


def delete_paper(user: SessionUser, settings: Settings, pid: str) -> dict:
    """논문 폴더를 휴지통으로 옮기고 목록에서 뺀다."""
    from . import trash

    idx = _index_path(user, settings)
    # 목록에서 먼저 빼고(선점) 폴더는 락 밖에서 옮긴다. 휴지통 복원은 휴지통 락
    # 안에서 이 목록 락을 잡으므로, 여기서 반대 순서로 겹쳐 잡으면 교착이 된다.
    with json_store.lock_for(idx):
        papers = _load(user, settings)
        meta = next((p for p in papers if p.get("id") == pid), None)
        if meta is None:
            raise HTTPException(status_code=404, detail="논문을 찾을 수 없습니다.")
        _save([p for p in papers if p.get("id") != pid], user, settings)
    d = paper_dir(user, settings, pid)
    try:
        # 메타를 폴더에 함께 넣어 두면 복원할 때 목록에 되살릴 수 있다
        json_store.write_atomic(d / "meta.json", meta)
        trash.move_paper_to_trash(d, meta, user, settings)
    except BaseException:
        with json_store.lock_for(idx):
            back = _load(user, settings)
            if not any(p.get("id") == pid for p in back):
                back.append(meta)
                _save(back, user, settings)
        raise
    return {"ok": True, "id": pid, "title": meta.get("title", "")}


def restore_dir(user: SessionUser, settings: Settings, src: Path, pid: str) -> dict:
    """휴지통에 있던 논문 폴더를 제자리로. 휴지통 락 안에서 불린다."""
    meta = json_store.read_json(src / "meta.json", None)
    if not isinstance(meta, dict):
        meta = _new_meta(sanitize_filename(pid or "paper.pdf"), 0)
    if not re.fullmatch(r"[0-9a-f]{32}", pid or ""):
        pid = uuid.uuid4().hex
    idx = _index_path(user, settings)
    with json_store.lock_for(idx):
        papers = _load(user, settings)
        if any(p.get("id") == pid for p in papers) or (root(user, settings) / pid).exists():
            pid = uuid.uuid4().hex
        meta["id"] = pid
        dest = root(user, settings) / pid
        shutil.move(str(src), str(dest))
        (dest / "meta.json").unlink(missing_ok=True)
        meta["updated_at"] = _now()
        papers.append(meta)
        _save(papers, user, settings)
    return meta


def search(user: SessionUser, settings: Settings, query: str, limit: int = 20) -> list[dict]:
    """제목·저자·초록·요약·키워드에서 찾는다."""
    q = _s(query, MAX_SHORT).lower()
    if not q:
        return []
    out = []
    for p in list_papers(user, settings):
        hay = " ".join([
            str(p.get("title", "")), " ".join(p.get("authors") or []), str(p.get("abstract", "")),
            str(p.get("summary", "")), " ".join(p.get("keywords") or []),
            " ".join(p.get("key_findings") or []), str(p.get("notes", "")),
            str(p.get("category", "")),
        ]).lower()
        if q in hay:
            out.append(p)
        if len(out) >= limit:
            break
    return out


#: 목록에 실리는 한 줄 요약의 길이. **어느 논문인지 알아보는 데 필요한 만큼만.**
#: 400자로 두었더니 논문 30편에 결과가 23,000자(약 1만 2천 토큰)였다 — 도구 카탈로그
#: 전체와 맞먹는다. 자세한 내용은 모델이 get_paper_info 로 그 논문만 따로 가져간다.
BRIEF_SUMMARY = 150


def brief(p: dict) -> dict:
    """모델·목록에 주는 요약본(초록 전체는 뺀다)."""
    summary = str(p.get("summary") or "")
    return {
        "id": p.get("id", ""),
        "title": p.get("title", ""),
        "category": p.get("category", ""),
        "authors": list(p.get("authors") or [])[:4],
        "year": p.get("year", ""),
        "venue": p.get("venue", ""),
        "keywords": list(p.get("keywords") or [])[:5],
        "summary": summary[:BRIEF_SUMMARY] + ("…" if len(summary) > BRIEF_SUMMARY else ""),
        "status": p.get("status", ""),
        "pages": p.get("pages", 0),
        "starred": bool(p.get("starred")),
    }
