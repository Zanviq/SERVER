# AI 문서 시스템 Phase 1 (코어 문서 서비스 + REST) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SERVER 백엔드에 `AI_documents/`를 다루는 안전한 문서 서비스와 REST API(세션+토큰 인증)를 추가한다. 버전 관리·낙관적 잠금·휴지통·감사·FTS5 검색 포함. MCP·Cloudflare·웹UI는 이후 Phase.

**Architecture:** 기존 FastAPI 앱(`backend/`)에 `backend/aidoc/` 패키지(서비스 레이어)와 라우터 2벌을 추가한다. 웹 출입구(`/api/aidoc/*`, 세션 쿠키)와 AI 출입구(`/mcp/api/*`, Bearer 토큰)가 동일한 `aidoc` 서비스 레이어를 호출한다. 메타·버전·감사·검색은 stdlib `sqlite3`+FTS5, 본문은 `DOCUMENT_ROOT` 하위 Markdown, 수정 전 본문은 `.history/`에 백업.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, stdlib `sqlite3`(FTS5), 기존 `security_paths`/`json_store` 패턴. 새 pip 의존성 없음.

## Global Constraints
- 저장 루트 기본값: `DOCUMENT_ROOT=/mnt/hdd/server/AI_documents` (로컬 개발 `./data/AI_documents`). 절대경로 하드코딩 금지 — 모두 env.
- DB 기본값: `AIDOC_DB_PATH` (로컬 `./data/aidoc/documents.db`). 토큰: `AIDOC_TOKENS_FILE` (JSON, git 제외).
- 등록 프로젝트: `AIDOC_PROJECTS` (기본 `orchestra-room,conversation-tree-ai,nodi,home-server`).
- 본문 최대: `AIDOC_MAX_BYTES` (기본 1048576).
- `storage_path`는 `DOCUMENT_ROOT` 기준 **상대 POSIX 경로**만 저장. 실제 파일 접근은 반드시 `safe_join`+`resolve()` 재검증, 심볼릭 탈출 차단.
- `document_id`로만 문서 지정. API는 절대경로/상대경로 입력을 받지 않는다.
- 새 문서는 `inbox/` 또는 `projects/{등록프로젝트}/`에만. AI에 영구삭제 없음(휴지통만).
- 모든 변경 전 버전 검증(낙관적 잠금), 모든 작업 감사 로그.
- 테스트: `backend/test_aidoc.py`에 assert 함수 + `__main__` 러너. 실행 `./.venv/Scripts/python.exe -m backend.test_aidoc` (Windows) / `python -m backend.test_aidoc`.
- 커밋 메시지 말미에 Co-Authored-By/Claude-Session 트레일러(기존 규약). 커밋은 각 Task 끝에서.

---

## 파일 구조 (Phase 1)
- Create `backend/aidoc/__init__.py` — 패키지.
- Create `backend/aidoc/ids.py` — 문서 id 생성, 안전 파일명.
- Create `backend/aidoc/paths.py` — DOCUMENT_ROOT 안전 경로·폴더 구조·프로젝트/폴더 검증.
- Create `backend/aidoc/db.py` — sqlite 연결, 스키마(documents/document_versions/audit_logs/FTS5) 초기화.
- Create `backend/aidoc/store.py` — Markdown 원자적 저장/읽기 + `.history` 백업.
- Create `backend/aidoc/audit.py` — 감사 로그 기록/조회.
- Create `backend/aidoc/tokens.py` — tokens.json 로드, Bearer 검증, scope/project 검사.
- Create `backend/aidoc/errors.py` — 도메인 예외(VersionConflict, NotFound, Forbidden, BadRequest).
- Create `backend/aidoc/service.py` — 문서 서비스(create/get/update/append/move/trash/restore/list/search/history).
- Create `backend/aidoc/schemas.py` — API 요청/응답 Pydantic 모델.
- Create `backend/routers/aidoc_web.py` — 세션 인증 라우터 `/api/aidoc/*`.
- Create `backend/routers/aidoc_ai.py` — 토큰 인증 라우터 `/mcp/api/*`.
- Create `backend/test_aidoc.py` — 테스트.
- Modify `backend/config.py` — aidoc env 필드 추가.
- Modify `backend/main.py` — 라우터 등록 + startup DB 초기화.
- Modify `.env.example` — aidoc 변수.
- Modify `.gitignore` — 로컬 토큰/DB 제외 패턴.

---

## Task 1: aidoc 설정 (config.py 확장 + .env.example)

**Files:**
- Modify: `backend/config.py`
- Modify: `.env.example`
- Modify: `.gitignore`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Produces: `Settings.document_root: Path`, `Settings.aidoc_db_path: Path`, `Settings.aidoc_tokens_file: str`, `Settings.aidoc_projects: list[str]`, `Settings.aidoc_max_bytes: int`.

- [ ] **Step 1: Write the failing test** — append to `backend/test_aidoc.py`:
```python
import os, tempfile, json
os.environ["STORAGE_ROOT"] = tempfile.mkdtemp(prefix="aidoc_test_")
os.environ["AUTH_USERS"] = json.dumps([{"username": "tester", "password": "pw", "display_name": "T"}])
os.environ["SESSION_SECRET"] = "aidoc-test-secret"
os.environ["DOCUMENT_ROOT"] = os.path.join(os.environ["STORAGE_ROOT"], "AI_documents")
os.environ["AIDOC_DB_PATH"] = os.path.join(os.environ["STORAGE_ROOT"], "aidoc", "documents.db")
os.environ["AIDOC_TOKENS_FILE"] = os.path.join(os.environ["STORAGE_ROOT"], "aidoc", "tokens.json")
os.environ["AIDOC_PROJECTS"] = "orchestra-room,nodi"

from backend.config import Settings  # noqa: E402


def test_settings_aidoc():
    s = Settings()
    assert s.document_root.name == "AI_documents"
    assert str(s.aidoc_db_path).endswith("documents.db")
    assert s.aidoc_projects == ["orchestra-room", "nodi"]
    assert s.aidoc_max_bytes == 1048576
```
- [ ] **Step 2: Run to verify it fails**
Run: `./.venv/Scripts/python.exe -m backend.test_aidoc` (아직 `__main__`에서 호출 안 하므로, 임시로 파일 끝에 `if __name__=="__main__": test_settings_aidoc(); print("OK")` 추가해 실행)
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'document_root'`.
- [ ] **Step 3: Implement** — in `backend/config.py` `Settings.__init__`, after the terminal block add:
```python
        # ── AI 문서 시스템 ──
        self.document_root: Path = Path(
            os.getenv("DOCUMENT_ROOT", str(self.storage_root / "AI_documents"))
        ).resolve()
        self.aidoc_db_path: Path = Path(
            os.getenv("AIDOC_DB_PATH", str(self.storage_root / "aidoc" / "documents.db"))
        )
        self.aidoc_tokens_file: str = os.getenv(
            "AIDOC_TOKENS_FILE", str(self.storage_root / "aidoc" / "tokens.json")
        )
        self.aidoc_projects: list[str] = [
            p.strip() for p in os.getenv(
                "AIDOC_PROJECTS", "orchestra-room,conversation-tree-ai,nodi,home-server"
            ).split(",") if p.strip()
        ]
        self.aidoc_max_bytes: int = int(os.getenv("AIDOC_MAX_BYTES", str(1024 * 1024)))
```
- [ ] **Step 4: Run to verify it passes** → `OK`.
- [ ] **Step 5:** Add to `.env.example` (end):
```env
# ===== AI 문서 시스템 =====
DOCUMENT_ROOT=/mnt/hdd/server/AI_documents
AIDOC_DB_PATH=/mnt/hdd/server/aidoc/documents.db
AIDOC_TOKENS_FILE=/mnt/hdd/server/aidoc/tokens.json
AIDOC_PROJECTS=orchestra-room,conversation-tree-ai,nodi,home-server
AIDOC_MAX_BYTES=1048576
```
Add to `.gitignore`: `aidoc/tokens.json` and `data/aidoc/`.
- [ ] **Step 6: Commit** — `git add backend/config.py .env.example .gitignore backend/test_aidoc.py && git commit -m "feat(aidoc): 설정(document_root/db/tokens/projects) 추가"`

---

## Task 2: 문서 id + 안전 파일명 (ids.py)

**Files:**
- Create: `backend/aidoc/__init__.py` (빈 파일)
- Create: `backend/aidoc/ids.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Produces: `new_document_id() -> str` (`"doc_" + 26 base32chars`, 시간정렬), `safe_slug(title: str, fallback="untitled") -> str`, `unique_filename(dir_rel: str, slug: str, existing: set[str]) -> str` (`.md` 부여, 충돌 시 `-2`,`-3`).

- [ ] **Step 1: Write failing test**:
```python
def test_ids():
    from backend.aidoc.ids import new_document_id, safe_slug, unique_filename
    a, b = new_document_id(), new_document_id()
    assert a.startswith("doc_") and len(a) == 30 and a != b
    assert a <= b  # 시간정렬(단조 증가)
    assert safe_slug("API 설계/문서: v2!") == "api-설계-문서-v2"
    assert safe_slug("   ") == "untitled"
    assert unique_filename("inbox", "note", set()) == "note.md"
    assert unique_filename("inbox", "note", {"note.md"}) == "note-2.md"
```
- [ ] **Step 2: Run → FAIL** (module not found).
- [ ] **Step 3: Implement `backend/aidoc/ids.py`:**
```python
"""문서 id 생성 + 안전 파일명."""
from __future__ import annotations

import re
import secrets
import time

_B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford, ULID 계열


def _encode(n: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_B32[n & 31])
        n >>= 5
    return "".join(reversed(out))


def new_document_id() -> str:
    """doc_ + 10자(타임스탬프ms) + 16자(랜덤) = 시간정렬 26자."""
    ts = int(time.time() * 1000)
    return "doc_" + _encode(ts, 10) + _encode(secrets.randbits(80), 16)


_ILLEGAL = re.compile(r"[^0-9a-z가-힣._-]+")


def safe_slug(title: str, fallback: str = "untitled") -> str:
    s = (title or "").strip().lower().replace(" ", "-")
    s = _ILLEGAL.sub("-", s).strip("-._")
    s = re.sub(r"-{2,}", "-", s)
    return s[:80] or fallback


def unique_filename(dir_rel: str, slug: str, existing: set[str]) -> str:
    name = f"{slug}.md"
    if name not in existing:
        return name
    i = 2
    while f"{slug}-{i}.md" in existing:
        i += 1
    return f"{slug}-{i}.md"
```
- [ ] **Step 4: Run → PASS.** (`len==30`: `doc_`(4)+26.)
- [ ] **Step 5: Commit** — `git add backend/aidoc/__init__.py backend/aidoc/ids.py backend/test_aidoc.py && git commit -m "feat(aidoc): 문서 id·안전 파일명"`

---

## Task 3: 도메인 예외 (errors.py)

**Files:**
- Create: `backend/aidoc/errors.py`

**Interfaces:**
- Produces: `AidocError(code:str, message:str, status:int, extra:dict)` 및 서브클래스 `NotFound`(404), `Forbidden`(403), `BadRequest`(400), `VersionConflict(expected,current)`(409, code `DOCUMENT_VERSION_CONFLICT`), `StorageError`(503).

- [ ] **Step 1: Write failing test**:
```python
def test_errors():
    from backend.aidoc.errors import VersionConflict, NotFound
    e = VersionConflict(4, 5)
    assert e.status == 409 and e.code == "DOCUMENT_VERSION_CONFLICT"
    assert e.extra == {"expected_version": 4, "current_version": 5}
    assert NotFound("x").status == 404
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `backend/aidoc/errors.py`:**
```python
"""aidoc 도메인 예외 (라우터에서 HTTP로 매핑)."""
from __future__ import annotations


class AidocError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, extra: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra or {}


class NotFound(AidocError):
    def __init__(self, message="문서를 찾을 수 없습니다."):
        super().__init__("NOT_FOUND", message, 404)


class Forbidden(AidocError):
    def __init__(self, message="권한이 없습니다."):
        super().__init__("FORBIDDEN", message, 403)


class BadRequest(AidocError):
    def __init__(self, message="잘못된 요청입니다."):
        super().__init__("BAD_REQUEST", message, 400)


class StorageError(AidocError):
    def __init__(self, message="저장소 오류."):
        super().__init__("STORAGE_ERROR", message, 503)


class VersionConflict(AidocError):
    def __init__(self, expected: int, current: int):
        super().__init__(
            "DOCUMENT_VERSION_CONFLICT",
            f"버전 충돌: expected {expected}, current {current}",
            409,
            {"expected_version": expected, "current_version": current},
        )
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): 도메인 예외"`

---

## Task 4: 안전 경로 + 폴더 구조 + 프로젝트 검증 (paths.py)

**Files:**
- Create: `backend/aidoc/paths.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Consumes: `Settings.document_root`, `Settings.aidoc_projects`; `security_paths.safe_join` (기존).
- Produces: `ensure_layout(settings)`; `resolve_rel(settings, rel: str) -> Path` (DOCUMENT_ROOT 하위 재검증, 심볼릭 차단); `TOP_FOLDERS: tuple`; `new_doc_dir(settings, project: str|None) -> str` (`inbox` 또는 `projects/{project}`, 미등록 프로젝트 → `BadRequest`); `list_existing_names(settings, dir_rel) -> set[str]`.

- [ ] **Step 1: Write failing test**:
```python
def test_paths():
    from backend.config import Settings
    from backend.aidoc import paths
    from backend.aidoc.errors import BadRequest
    s = Settings()
    paths.ensure_layout(s)
    for f in ("inbox", "projects", "knowledge", "templates", "archive", "trash", ".history"):
        assert (s.document_root / f).is_dir()
    assert paths.new_doc_dir(s, None) == "inbox"
    assert paths.new_doc_dir(s, "orchestra-room") == "projects/orchestra-room"
    try:
        paths.new_doc_dir(s, "not-registered"); assert False
    except BadRequest:
        pass
    # 경로 탈출 차단
    try:
        paths.resolve_rel(s, "../../etc/passwd"); assert False
    except Exception:
        pass
```
(참고: `Settings()`는 Task1 테스트 상단에서 이미 env 설정됨. `AIDOC_PROJECTS`에 `orchestra-room` 포함되도록 Task1 env를 `"orchestra-room,nodi"`로 둠.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `backend/aidoc/paths.py`:**
```python
"""DOCUMENT_ROOT 하위 안전 경로 + 폴더 구조 + 프로젝트 검증."""
from __future__ import annotations

from pathlib import Path

from ..config import Settings
from ..security_paths import safe_join
from .errors import BadRequest

TOP_FOLDERS = ("inbox", "projects", "knowledge", "templates", "archive", "trash", ".history")


def ensure_layout(settings: Settings) -> None:
    root = settings.document_root
    root.mkdir(parents=True, exist_ok=True)
    for f in TOP_FOLDERS:
        (root / f).mkdir(parents=True, exist_ok=True)
    for p in settings.aidoc_projects:
        (root / "projects" / p).mkdir(parents=True, exist_ok=True)


def resolve_rel(settings: Settings, rel: str) -> Path:
    """상대경로를 DOCUMENT_ROOT 하위로만 해석(심볼릭 탈출까지 재검증)."""
    target = safe_join(settings.document_root, rel)  # '..'·루트탈출 차단
    real = target.resolve()
    root = settings.document_root.resolve()
    if real != root and root not in real.parents:
        raise BadRequest("문서 루트를 벗어난 경로입니다.")
    return target


def new_doc_dir(settings: Settings, project: str | None) -> str:
    if not project:
        return "inbox"
    if project not in settings.aidoc_projects:
        raise BadRequest(f"등록되지 않은 프로젝트: {project}")
    return f"projects/{project}"


def list_existing_names(settings: Settings, dir_rel: str) -> set[str]:
    d = resolve_rel(settings, dir_rel)
    if not d.is_dir():
        return set()
    return {p.name for p in d.iterdir() if p.is_file()}
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): 안전 경로·폴더 구조·프로젝트 검증"`

---

## Task 5: DB 스키마/연결 (db.py)

**Files:**
- Create: `backend/aidoc/db.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Consumes: `Settings.aidoc_db_path`.
- Produces: `connect(settings) -> sqlite3.Connection` (row_factory=Row, foreign_keys on, WAL), `init_db(settings)` (테이블+FTS5 생성, 멱등), `has_fts5(conn) -> bool`.
- 테이블: `documents`, `document_versions`, `audit_logs`, `documents_fts`(FTS5 external-content 아님 — 단순 contentless 대신 일반 FTS5 테이블에 rowid=문서 순번 매핑). Phase1은 단순화를 위해 `documents_fts(doc_id UNINDEXED, title, content, tags, project, category)` 일반 FTS5 사용.

- [ ] **Step 1: Write failing test**:
```python
def test_db_init():
    from backend.config import Settings
    from backend.aidoc import db
    s = Settings()
    db.init_db(s)
    conn = db.connect(s)
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
    assert {"documents", "document_versions", "audit_logs", "documents_fts"} <= tables
    assert db.has_fts5(conn) is True
    conn.close()
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `backend/aidoc/db.py`:**
```python
"""aidoc SQLite: 연결 + 스키마 초기화(FTS5)."""
from __future__ import annotations

import sqlite3

from ..config import Settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project TEXT,
  category TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  storage_path TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed INTEGER NOT NULL DEFAULT 0,
  orig_path TEXT
);
CREATE INDEX IF NOT EXISTS ix_documents_project ON documents(project);
CREATE INDEX IF NOT EXISTS ix_documents_status ON documents(status);

CREATE TABLE IF NOT EXISTS document_versions (
  doc_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  actor TEXT,
  change_summary TEXT,
  prev_hash TEXT,
  new_hash TEXT,
  history_path TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, version)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT NOT NULL,
  doc_id TEXT,
  project TEXT,
  from_version INTEGER,
  to_version INTEGER,
  change_summary TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  detail TEXT,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_logs(timestamp);
"""

_FTS = """
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  doc_id UNINDEXED, title, content, tags, project, category
);
"""


def connect(settings: Settings) -> sqlite3.Connection:
    settings.aidoc_db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(settings.aidoc_db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def has_fts5(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x)")
        conn.execute("DROP TABLE IF EXISTS _fts_probe")
        return True
    except sqlite3.OperationalError:
        return False


def init_db(settings: Settings) -> None:
    conn = connect(settings)
    try:
        conn.executescript(_SCHEMA)
        if has_fts5(conn):
            conn.executescript(_FTS)
        conn.commit()
    finally:
        conn.close()
```
- [ ] **Step 4: Run → PASS.** (FTS5가 없는 환경이면 `has_fts5` False → 검색 Task에서 LIKE 폴백. 표준 CPython sqlite3는 FTS5 포함.)
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): SQLite 스키마+FTS5 초기화"`

---

## Task 6: Markdown 원자적 저장 + .history 백업 (store.py)

**Files:**
- Create: `backend/aidoc/store.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Consumes: `paths.resolve_rel`, `Settings`.
- Produces: `sha256(text)->str`; `read(settings, storage_path)->str`; `write_new(settings, storage_path, content)->None` (원자적); `backup_and_write(settings, doc_id, storage_path, new_content, old_content, version)->str` (기존본을 `.history/{doc_id}/{version:04}.md`에 저장 후 원자 교체, history_rel 반환); `move_file(settings, src_rel, dst_rel)->None`.

- [ ] **Step 1: Write failing test**:
```python
def test_store_atomic_and_history():
    from backend.config import Settings
    from backend.aidoc import store, paths
    s = Settings(); paths.ensure_layout(s)
    rel = "inbox/x.md"
    store.write_new(s, rel, "v1\n")
    assert store.read(s, rel) == "v1\n"
    hrel = store.backup_and_write(s, "doc_TEST", rel, "v2\n", "v1\n", 1)
    assert store.read(s, rel) == "v2\n"
    assert store.read(s, hrel) == "v1\n"  # 이전본 보존
    assert hrel == ".history/doc_TEST/0001.md"
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `backend/aidoc/store.py`:**
```python
"""Markdown 원자적 저장 + .history 백업."""
from __future__ import annotations

import hashlib
import os

from ..config import Settings
from .errors import NotFound, StorageError
from .paths import resolve_rel


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read(settings: Settings, storage_path: str) -> str:
    p = resolve_rel(settings, storage_path)
    if not p.is_file():
        raise NotFound("문서 파일이 없습니다.")
    return p.read_text(encoding="utf-8", errors="replace")


def _atomic_write(target, content: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + f".tmp{os.getpid()}")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)
    except OSError as e:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise StorageError(f"파일 저장 실패: {e}") from e


def write_new(settings: Settings, storage_path: str, content: str) -> None:
    _atomic_write(resolve_rel(settings, storage_path), content)


def backup_and_write(settings, doc_id, storage_path, new_content, old_content, version) -> str:
    """기존본을 .history에 저장 후 새 내용으로 원자 교체. history 상대경로 반환."""
    hist_rel = f".history/{doc_id}/{version:04d}.md"
    _atomic_write(resolve_rel(settings, hist_rel), old_content)  # 이전본 백업
    _atomic_write(resolve_rel(settings, storage_path), new_content)  # 현재 교체
    return hist_rel


def move_file(settings: Settings, src_rel: str, dst_rel: str) -> None:
    src = resolve_rel(settings, src_rel)
    dst = resolve_rel(settings, dst_rel)
    if not src.exists():
        raise NotFound("이동할 파일이 없습니다.")
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.replace(src, dst)
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): 원자적 저장+.history 백업"`

---

## Task 7: 감사 로그 (audit.py)

**Files:**
- Create: `backend/aidoc/audit.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Consumes: `db.connect`.
- Produces: `log(conn, actor, action, *, doc_id=None, project=None, from_version=None, to_version=None, change_summary=None, ok=True, detail=None)`; `list_logs(conn, limit=100)->list[dict]`. (호출자가 conn 관리 — 서비스 트랜잭션 내에서 기록.)

- [ ] **Step 1: Write failing test**:
```python
def test_audit():
    from backend.config import Settings
    from backend.aidoc import db, audit
    s = Settings(); db.init_db(s)
    conn = db.connect(s)
    audit.log(conn, "tester", "create_document", doc_id="doc_A", project="nodi", to_version=1)
    conn.commit()
    rows = audit.list_logs(conn, limit=10)
    assert rows[0]["action"] == "create_document" and rows[0]["actor"] == "tester"
    conn.close()
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `backend/aidoc/audit.py`:**
```python
"""감사 로그."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def log(conn: sqlite3.Connection, actor: str, action: str, *, doc_id=None, project=None,
        from_version=None, to_version=None, change_summary=None, ok=True, detail=None) -> None:
    conn.execute(
        "INSERT INTO audit_logs(actor,action,doc_id,project,from_version,to_version,"
        "change_summary,ok,detail,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (actor, action, doc_id, project, from_version, to_version,
         change_summary, 1 if ok else 0, detail, _now()),
    )


def list_logs(conn: sqlite3.Connection, limit: int = 100) -> list[dict]:
    cur = conn.execute(
        "SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?", (int(limit),)
    )
    return [dict(r) for r in cur.fetchall()]
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): 감사 로그"`

---

## Task 8: 토큰 인증 (tokens.py)

**Files:**
- Create: `backend/aidoc/tokens.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Consumes: `Settings.aidoc_tokens_file`.
- Produces: `Principal(actor:str, scopes:set[str], allowed_projects:list[str], name:str)`; `verify_bearer(settings, token:str) -> Principal|None` (sha256 상수시간 비교); `Principal.can(scope)->bool`; `Principal.project_ok(project|None)->bool` (`*` 허용, None(inbox)은 허용).

- [ ] **Step 1: Write failing test**:
```python
def test_tokens():
    import hashlib, json, os
    from backend.config import Settings
    from backend.aidoc import tokens
    s = Settings()
    raw = "secrettoken123"
    os.makedirs(os.path.dirname(s.aidoc_tokens_file), exist_ok=True)
    with open(s.aidoc_tokens_file, "w", encoding="utf-8") as f:
        json.dump([{"name": "codex-nodi", "token_sha256": hashlib.sha256(raw.encode()).hexdigest(),
                    "actor": "codex", "scopes": ["documents:read", "documents:create"],
                    "allowed_projects": ["nodi"]}], f)
    tokens.reload_cache()
    p = tokens.verify_bearer(s, raw)
    assert p and p.actor == "codex"
    assert p.can("documents:read") and not p.can("documents:trash")
    assert p.project_ok("nodi") and not p.project_ok("orchestra-room")
    assert p.project_ok(None)  # inbox 허용
    assert tokens.verify_bearer(s, "wrong") is None
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `backend/aidoc/tokens.py`:**
```python
"""설정파일(JSON) 기반 AI 토큰 인증 + scope/project 검사."""
from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass, field

from ..config import Settings

_cache: list[dict] | None = None
_cache_file: str | None = None


@dataclass
class Principal:
    actor: str
    scopes: set[str]
    allowed_projects: list[str]
    name: str = ""

    def can(self, scope: str) -> bool:
        return scope in self.scopes

    def project_ok(self, project: str | None) -> bool:
        if project is None:  # inbox 등 프로젝트 없는 문서
            return True
        return "*" in self.allowed_projects or project in self.allowed_projects


def reload_cache() -> None:
    global _cache, _cache_file
    _cache = None
    _cache_file = None


def _load(settings: Settings) -> list[dict]:
    global _cache, _cache_file
    if _cache is not None and _cache_file == settings.aidoc_tokens_file:
        return _cache
    try:
        with open(settings.aidoc_tokens_file, encoding="utf-8") as f:
            data = json.load(f)
        _cache = data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        _cache = []
    _cache_file = settings.aidoc_tokens_file
    return _cache


def verify_bearer(settings: Settings, token: str) -> Principal | None:
    if not token:
        return None
    h = hashlib.sha256(token.encode("utf-8")).hexdigest()
    for entry in _load(settings):
        stored = str(entry.get("token_sha256", ""))
        if stored and hmac.compare_digest(h, stored):
            return Principal(
                actor=str(entry.get("actor", "ai")),
                scopes=set(entry.get("scopes", [])),
                allowed_projects=list(entry.get("allowed_projects", [])),
                name=str(entry.get("name", "")),
            )
    return None
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): 설정파일 토큰 인증+scope/project"`

---

## Task 9: API 스키마 (schemas.py)

**Files:**
- Create: `backend/aidoc/schemas.py`

**Interfaces:**
- Produces: Pydantic 모델 `CreateDoc`, `UpdateDoc`, `AppendDoc`, `MoveDoc`, `RestoreDoc`, `DocMeta`(응답), `DocDetail`(=DocMeta+content), `SearchHit`.

- [ ] **Step 1: Write failing test**:
```python
def test_schemas():
    from backend.aidoc.schemas import CreateDoc, UpdateDoc
    c = CreateDoc(title="T", content="x", project="nodi")
    assert c.status == "draft" and c.tags == []
    u = UpdateDoc(expected_version=3, change_summary="s", content="y")
    assert u.expected_version == 3
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `backend/aidoc/schemas.py`:**
```python
"""AI 문서 API 스키마."""
from __future__ import annotations

from pydantic import BaseModel, Field


class CreateDoc(BaseModel):
    title: str
    content: str = ""
    project: str | None = None
    category: str | None = None
    tags: list[str] = Field(default_factory=list)
    status: str = "draft"
    duplicate_check_query: str | None = None


class UpdateDoc(BaseModel):
    expected_version: int
    title: str | None = None
    content: str | None = None
    change_summary: str = ""


class AppendDoc(BaseModel):
    content: str
    change_summary: str = ""


class MoveDoc(BaseModel):
    target_project: str | None = None  # None → inbox
    target_folder: str | None = None   # knowledge/... 등 (등록 폴더만)


class RestoreDoc(BaseModel):
    version: int | None = None  # None → 휴지통 복원, 값 → 해당 버전으로 복원


class DocMeta(BaseModel):
    id: str
    title: str
    project: str | None
    category: str | None
    tags: list[str]
    status: str
    version: int
    created_by: str | None
    updated_by: str | None
    created_at: str
    updated_at: str
    trashed: bool


class DocDetail(DocMeta):
    content: str


class SearchHit(DocMeta):
    snippet: str
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): API 스키마"`

---

## Task 10: 서비스 — 생성/조회 (service.py 1/3)

**Files:**
- Create: `backend/aidoc/service.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Consumes: db, store, paths, ids, audit, errors, schemas.
- Produces: `Actor(name:str, is_admin:bool=False)`; `create(settings, actor, data: CreateDoc) -> dict`(DocDetail dict); `get(settings, doc_id) -> dict`(DocDetail dict, 내용 포함); `_row_to_meta(row)->dict`; `_index_fts(conn, doc_id, title, content, tags, project, category)`.
- 규칙: create는 `new_doc_dir`로 폴더 결정, 안전 파일명, id 생성, 파일 write_new, DB insert(version=1), FTS 색인, 감사 로그. get은 trashed 여도 조회 가능(내용 포함).

- [ ] **Step 1: Write failing test**:
```python
def test_service_create_get():
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    actor = service.Actor("claude-code")
    doc = service.create(s, actor, CreateDoc(title="Nodi 설계", content="# Nodi\n본문", project="nodi", tags=["ai"]))
    assert doc["id"].startswith("doc_") and doc["version"] == 1
    assert doc["storage_path"].startswith("projects/nodi/")
    got = service.get(s, doc["id"])
    assert got["content"] == "# Nodi\n본문" and got["title"] == "Nodi 설계"
    # inbox (project 없음)
    d2 = service.create(s, actor, CreateDoc(title="임시", content="x"))
    assert d2["storage_path"].startswith("inbox/") and d2["project"] is None
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `backend/aidoc/service.py`** (생성/조회 + 공용 헬퍼):
```python
"""AI 문서 서비스 레이어 — 파일+DB+버전+감사 오케스트레이션."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone

from ..config import Settings
from . import audit, db, ids, paths, store
from .errors import BadRequest, NotFound
from .schemas import CreateDoc


@dataclass
class Actor:
    name: str
    is_admin: bool = False


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _row_to_meta(row) -> dict:
    return {
        "id": row["id"], "title": row["title"], "project": row["project"],
        "category": row["category"], "tags": json.loads(row["tags"] or "[]"),
        "status": row["status"], "version": row["version"],
        "created_by": row["created_by"], "updated_by": row["updated_by"],
        "created_at": row["created_at"], "updated_at": row["updated_at"],
        "trashed": bool(row["trashed"]),
    }


def _index_fts(conn, doc_id, title, content, tags, project, category) -> None:
    if not db.has_fts5(conn):
        return
    conn.execute("DELETE FROM documents_fts WHERE doc_id=?", (doc_id,))
    conn.execute(
        "INSERT INTO documents_fts(doc_id,title,content,tags,project,category) VALUES (?,?,?,?,?,?)",
        (doc_id, title or "", content or "", " ".join(tags or []), project or "", category or ""),
    )


def _get_row(conn, doc_id):
    row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if not row:
        raise NotFound()
    return row


def create(settings: Settings, actor: Actor, data: CreateDoc) -> dict:
    if not data.title.strip():
        raise BadRequest("제목이 필요합니다.")
    if len(data.content.encode("utf-8")) > settings.aidoc_max_bytes:
        raise BadRequest("본문이 너무 큽니다.")
    dir_rel = paths.new_doc_dir(settings, data.project)
    slug = ids.safe_slug(data.title)
    fname = ids.unique_filename(dir_rel, slug, paths.list_existing_names(settings, dir_rel))
    storage_path = f"{dir_rel}/{fname}"
    doc_id = ids.new_document_id()
    now = _now()
    store.write_new(settings, storage_path, data.content)
    conn = db.connect(settings)
    try:
        conn.execute(
            "INSERT INTO documents(id,title,project,category,tags,status,storage_path,version,"
            "content_hash,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (doc_id, data.title, data.project, data.category, json.dumps(data.tags, ensure_ascii=False),
             data.status, storage_path, 1, store.sha256(data.content),
             actor.name, actor.name, now, now),
        )
        _index_fts(conn, doc_id, data.title, data.content, data.tags, data.project, data.category)
        audit.log(conn, actor.name, "create_document", doc_id=doc_id, project=data.project, to_version=1)
        conn.commit()
        row = _get_row(conn, doc_id)
    finally:
        conn.close()
    meta = _row_to_meta(row)
    meta["content"] = data.content
    return meta


def get(settings: Settings, doc_id: str) -> dict:
    conn = db.connect(settings)
    try:
        row = _get_row(conn, doc_id)
    finally:
        conn.close()
    meta = _row_to_meta(row)
    meta["content"] = store.read(settings, row["storage_path"])
    return meta
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): 서비스 생성/조회"`

---

## Task 11: 서비스 — 수정(낙관적 잠금)/추가 (service.py 2/3)

**Files:**
- Modify: `backend/aidoc/service.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Produces: `update(settings, actor, doc_id, data: UpdateDoc) -> dict`; `append(settings, actor, doc_id, data: AppendDoc) -> dict`.
- 규칙: update는 `expected_version != current` → `VersionConflict`. 아니면 이전본 `.history` 백업 → 새 파일 쓰기 → version++ → document_versions 기록 → FTS 갱신 → 감사. append는 현재 내용 뒤에 `\n` + content 붙여 update와 동일 경로.

- [ ] **Step 1: Write failing test**:
```python
def test_service_update_conflict_and_append():
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc, UpdateDoc, AppendDoc
    from backend.aidoc.errors import VersionConflict
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("claude-code")
    doc = service.create(s, a, CreateDoc(title="C", content="one\n", project="nodi"))
    up = service.update(s, service.Actor("codex"), doc["id"], UpdateDoc(expected_version=1, content="two\n", change_summary="교체"))
    assert up["version"] == 2 and up["content"] == "two\n"
    # 잘못된 기대버전 → 409
    try:
        service.update(s, a, doc["id"], UpdateDoc(expected_version=1, content="three\n")); assert False
    except VersionConflict as e:
        assert e.extra == {"expected_version": 1, "current_version": 2}
    # history 보존
    hist = service.get_history(s, doc["id"])
    assert any(h["version"] == 1 for h in hist)
    # append
    ap = service.append(s, a, doc["id"], AppendDoc(content="added"))
    assert ap["version"] == 3 and ap["content"].endswith("added")
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement — append to `backend/aidoc/service.py`:**
```python
from .errors import VersionConflict  # (상단 import 병합)
from .schemas import AppendDoc, UpdateDoc  # (상단 import 병합)


def _apply_new_content(settings, actor, doc_id, new_title, new_content, change_summary) -> dict:
    if len(new_content.encode("utf-8")) > settings.aidoc_max_bytes:
        raise BadRequest("본문이 너무 큽니다.")
    conn = db.connect(settings)
    try:
        row = _get_row(conn, doc_id)
        old_content = store.read(settings, row["storage_path"])
        cur_version = row["version"]
        hist_rel = store.backup_and_write(
            settings, doc_id, row["storage_path"], new_content, old_content, cur_version
        )
        new_version = cur_version + 1
        title = new_title if new_title is not None else row["title"]
        now = _now()
        conn.execute(
            "UPDATE documents SET title=?,content_hash=?,version=?,updated_by=?,updated_at=? WHERE id=?",
            (title, store.sha256(new_content), new_version, actor.name, now, doc_id),
        )
        conn.execute(
            "INSERT INTO document_versions(doc_id,version,actor,change_summary,prev_hash,new_hash,history_path,created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (doc_id, cur_version, actor.name, change_summary, store.sha256(old_content),
             store.sha256(new_content), hist_rel, now),
        )
        tags = json.loads(row["tags"] or "[]")
        _index_fts(conn, doc_id, title, new_content, tags, row["project"], row["category"])
        audit.log(conn, actor.name, "update_document", doc_id=doc_id, project=row["project"],
                  from_version=cur_version, to_version=new_version, change_summary=change_summary)
        conn.commit()
        out = _get_row(conn, doc_id)
    finally:
        conn.close()
    meta = _row_to_meta(out)
    meta["content"] = new_content
    return meta


def update(settings, actor: Actor, doc_id: str, data: UpdateDoc) -> dict:
    conn = db.connect(settings)
    try:
        row = _get_row(conn, doc_id)
        cur = row["version"]
    finally:
        conn.close()
    if data.expected_version != cur:
        raise VersionConflict(data.expected_version, cur)
    new_content = data.content if data.content is not None else store.read(settings, row["storage_path"])
    return _apply_new_content(settings, actor, doc_id, data.title, new_content, data.change_summary)


def append(settings, actor: Actor, doc_id: str, data: AppendDoc) -> dict:
    conn = db.connect(settings)
    try:
        row = _get_row(conn, doc_id)
        current = store.read(settings, row["storage_path"])
    finally:
        conn.close()
    sep = "" if (not current or current.endswith("\n")) else "\n"
    joined = current + sep + data.content
    return _apply_new_content(settings, actor, doc_id, None, joined, data.change_summary or "append")


def get_history(settings, doc_id: str) -> list[dict]:
    conn = db.connect(settings)
    try:
        _get_row(conn, doc_id)
        cur = conn.execute(
            "SELECT * FROM document_versions WHERE doc_id=? ORDER BY version DESC", (doc_id,)
        )
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): 수정(낙관적 잠금)/추가/이력"`

---

## Task 12: 서비스 — 이동/휴지통/복원 (service.py 3/3)

**Files:**
- Modify: `backend/aidoc/service.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Produces: `move(settings, actor, doc_id, target_project, target_folder) -> dict`; `trash(settings, actor, doc_id) -> dict`; `restore(settings, actor, doc_id, version) -> dict` (version=None이면 휴지통 복원 = trashed 해제 + 원경로로 파일 이동; version 지정이면 그 버전 내용으로 새 버전 생성).
- 규칙: trash는 파일을 `trash/{doc_id}/{파일명}`으로 이동, `documents.trashed=1`, `orig_path=이전 storage_path`, `storage_path`갱신, 감사. move는 등록 프로젝트/폴더만.

- [ ] **Step 1: Write failing test**:
```python
def test_service_move_trash_restore():
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("claude-code")
    doc = service.create(s, a, CreateDoc(title="M", content="c\n"))  # inbox
    moved = service.move(s, a, doc["id"], target_project="nodi", target_folder=None)
    assert moved["storage_path"].startswith("projects/nodi/") and moved["project"] == "nodi"
    tr = service.trash(s, a, doc["id"])
    assert tr["trashed"] is True and tr["storage_path"].startswith("trash/")
    rs = service.restore(s, a, doc["id"], version=None)  # 휴지통 복원
    assert rs["trashed"] is False and rs["storage_path"].startswith("projects/nodi/")
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement — append to `service.py`:**
```python
def _update_path(conn, doc_id, storage_path, project=None, set_trash=None, orig_path=None):
    sets = ["storage_path=?"]; vals = [storage_path]
    if project is not None or project is None:  # project는 명시적으로 갱신
        sets.append("project=?"); vals.append(project)
    if set_trash is not None:
        sets.append("trashed=?"); vals.append(1 if set_trash else 0)
    if orig_path is not None:
        sets.append("orig_path=?"); vals.append(orig_path)
    vals.append(doc_id)
    conn.execute(f"UPDATE documents SET {','.join(sets)} WHERE id=?", vals)


def move(settings, actor: Actor, doc_id: str, target_project=None, target_folder=None) -> dict:
    conn = db.connect(settings)
    try:
        row = _get_row(conn, doc_id)
        if target_folder:
            allowed = ("knowledge", "templates", "archive", "inbox")
            top = target_folder.split("/", 1)[0]
            if top not in allowed:
                raise BadRequest("허용되지 않은 폴더입니다.")
            dir_rel = target_folder.strip("/"); project = None
        else:
            dir_rel = paths.new_doc_dir(settings, target_project)
            project = target_project
        fname = row["storage_path"].rsplit("/", 1)[-1]
        existing = paths.list_existing_names(settings, dir_rel)
        if fname in existing:
            fname = ids.unique_filename(dir_rel, fname[:-3], existing)
        dst = f"{dir_rel}/{fname}"
        store.move_file(settings, row["storage_path"], dst)
        _update_path(conn, doc_id, dst, project=project)
        audit.log(conn, actor.name, "move_document", doc_id=doc_id, project=project,
                  change_summary=f"{row['storage_path']} -> {dst}")
        conn.commit()
        out = _get_row(conn, doc_id)
    finally:
        conn.close()
    meta = _row_to_meta(out); meta["content"] = store.read(settings, out["storage_path"]); return meta


def trash(settings, actor: Actor, doc_id: str) -> dict:
    conn = db.connect(settings)
    try:
        row = _get_row(conn, doc_id)
        if row["trashed"]:
            out = row
        else:
            fname = row["storage_path"].rsplit("/", 1)[-1]
            dst = f"trash/{doc_id}/{fname}"
            store.move_file(settings, row["storage_path"], dst)
            _update_path(conn, doc_id, dst, project=row["project"], set_trash=True, orig_path=row["storage_path"])
            audit.log(conn, actor.name, "trash_document", doc_id=doc_id, project=row["project"])
            conn.commit()
            out = _get_row(conn, doc_id)
    finally:
        conn.close()
    meta = _row_to_meta(out); meta["content"] = store.read(settings, out["storage_path"]); return meta


def restore(settings, actor: Actor, doc_id: str, version=None) -> dict:
    if version is None:
        conn = db.connect(settings)
        try:
            row = _get_row(conn, doc_id)
            if not row["trashed"]:
                raise BadRequest("휴지통 상태가 아닙니다.")
            dst = row["orig_path"] or f"inbox/{row['storage_path'].rsplit('/',1)[-1]}"
            existing = paths.list_existing_names(settings, dst.rsplit("/", 1)[0])
            fname = dst.rsplit("/", 1)[-1]
            if fname in existing:
                fname = ids.unique_filename(dst.rsplit("/", 1)[0], fname[:-3], existing)
                dst = f"{dst.rsplit('/',1)[0]}/{fname}"
            store.move_file(settings, row["storage_path"], dst)
            _update_path(conn, doc_id, dst, project=row["project"], set_trash=False, orig_path=None)
            audit.log(conn, actor.name, "restore_document", doc_id=doc_id, project=row["project"])
            conn.commit()
            out = _get_row(conn, doc_id)
        finally:
            conn.close()
        meta = _row_to_meta(out); meta["content"] = store.read(settings, out["storage_path"]); return meta
    # 특정 버전 내용으로 복원 = 새 버전 생성
    hist = store.read(settings, f".history/{doc_id}/{int(version):04d}.md")
    return _apply_new_content(settings, actor, doc_id, None, hist, f"restore v{version}")
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): 이동/휴지통/복원"`

---

## Task 13: 서비스 — 목록/검색 (service.py + FTS5)

**Files:**
- Modify: `backend/aidoc/service.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Produces: `list_docs(settings, *, project=None, category=None, tag=None, status=None, created_by=None, updated_by=None, include_trashed=False) -> list[dict]`(메타만); `search(settings, q, limit=50) -> list[dict]`(SearchHit; FTS5 있으면 FTS, 없으면 LIKE 폴백); `list_projects(settings)->list[str]`.

- [ ] **Step 1: Write failing test**:
```python
def test_service_list_search():
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("claude-code")
    service.create(s, a, CreateDoc(title="WriteLock 처리", content="낙관적 잠금과 WriteLock 충돌", project="nodi", tags=["lock"]))
    service.create(s, a, CreateDoc(title="다른 문서", content="관계 없음", project="orchestra-room"))
    lst = service.list_docs(s, project="nodi")
    assert len(lst) == 1 and lst[0]["title"] == "WriteLock 처리"
    hits = service.search(s, "WriteLock")
    assert any("WriteLock" in h["title"] or "WriteLock" in h["snippet"] for h in hits)
    assert "nodi" in service.list_projects(s)
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement — append to `service.py`:**
```python
def list_docs(settings, *, project=None, category=None, tag=None, status=None,
              created_by=None, updated_by=None, include_trashed=False) -> list[dict]:
    where = []; vals = []
    if not include_trashed:
        where.append("trashed=0")
    for col, v in (("project", project), ("category", category), ("status", status),
                   ("created_by", created_by), ("updated_by", updated_by)):
        if v is not None:
            where.append(f"{col}=?"); vals.append(v)
    sql = "SELECT * FROM documents"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY updated_at DESC"
    conn = db.connect(settings)
    try:
        rows = conn.execute(sql, vals).fetchall()
    finally:
        conn.close()
    out = [_row_to_meta(r) for r in rows]
    if tag:
        out = [m for m in out if tag in m["tags"]]
    return out


def _snippet(text: str, q: str, width=80) -> str:
    low = text.lower(); i = low.find(q.lower())
    if i < 0:
        return text[:width].replace("\n", " ").strip()
    start = max(0, i - width // 2)
    seg = text[start:start + width].replace("\n", " ").strip()
    return ("…" if start > 0 else "") + seg + ("…" if start + width < len(text) else "")


def search(settings, q: str, limit: int = 50) -> list[dict]:
    conn = db.connect(settings)
    try:
        hits = []
        if db.has_fts5(conn):
            cur = conn.execute(
                "SELECT d.*, snippet(documents_fts,2,'[',']','…',12) AS snip "
                "FROM documents_fts f JOIN documents d ON d.id=f.doc_id "
                "WHERE documents_fts MATCH ? AND d.trashed=0 LIMIT ?",
                (q, int(limit)),
            )
            for r in cur.fetchall():
                m = _row_to_meta(r); m["snippet"] = r["snip"] or ""; hits.append(m)
        else:
            ql = f"%{q.lower()}%"
            cur = conn.execute(
                "SELECT * FROM documents WHERE trashed=0 AND (lower(title) LIKE ?) LIMIT ?",
                (ql, int(limit)),
            )
            for r in cur.fetchall():
                m = _row_to_meta(r); m["snippet"] = _snippet(r["title"], q); hits.append(m)
        return hits
    finally:
        conn.close()


def list_projects(settings) -> list[str]:
    return list(settings.aidoc_projects)
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(aidoc): 목록/검색(FTS5)"`

---

## Task 14: 라우터(세션+토큰) + main 등록 + startup 초기화

**Files:**
- Create: `backend/routers/aidoc_web.py`
- Create: `backend/routers/aidoc_ai.py`
- Modify: `backend/main.py`
- Test: `backend/test_aidoc.py`

**Interfaces:**
- Consumes: `service`, `schemas`, `tokens`, `errors`; 기존 `require_session`, `get_settings`.
- Web 라우터 prefix `/api/aidoc`(세션): actor = 세션 username, is_admin = (username in TERMINAL_ADMINS? → 대신 settings.aidoc admin? 간단히 항상 편집 허용). AI 라우터 prefix `/mcp/api`(Bearer): `Depends(require_principal)` → scope/project 검사.
- 공통 예외 매핑: `AidocError` → `HTTPException(status, {code,message,**extra})`.

- [ ] **Step 1: Write failing test** (TestClient로 세션 + 토큰 경로 모두):
```python
def test_routers_web_and_token():
    import hashlib, json, os
    from fastapi.testclient import TestClient
    from backend.config import Settings
    from backend.aidoc import db, paths, tokens
    from backend.main import app
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    # 토큰 파일 준비
    raw = "tok-abc"
    os.makedirs(os.path.dirname(s.aidoc_tokens_file), exist_ok=True)
    json.dump([{"name": "codex-nodi", "token_sha256": hashlib.sha256(raw.encode()).hexdigest(),
                "actor": "codex", "scopes": ["documents:read", "documents:create", "documents:update"],
                "allowed_projects": ["nodi"]}], open(s.aidoc_tokens_file, "w"))
    tokens.reload_cache()

    # 세션(웹) 경로
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester", "password": "pw"})
    r = c.post("/api/aidoc/documents", json={"title": "웹문서", "content": "hi", "project": "nodi"})
    assert r.status_code == 200, r.text
    did = r.json()["id"]
    assert c.get(f"/api/aidoc/documents/{did}").json()["content"] == "hi"

    # 토큰(AI) 경로 — 헤더 인증
    h = {"Authorization": f"Bearer {raw}"}
    a = TestClient(app)
    cr = a.post("/mcp/api/documents", json={"title": "AI문서", "content": "x", "project": "nodi"}, headers=h)
    assert cr.status_code == 200, cr.text
    aid = cr.json()["id"]
    # 권한 밖 프로젝트 → 403
    bad = a.post("/mcp/api/documents", json={"title": "T", "content": "x", "project": "orchestra-room"}, headers=h)
    assert bad.status_code == 403
    # 버전 충돌 409
    a.put(f"/mcp/api/documents/{aid}", json={"expected_version": 1, "content": "y"}, headers=h)
    conflict = a.put(f"/mcp/api/documents/{aid}", json={"expected_version": 1, "content": "z"}, headers=h)
    assert conflict.status_code == 409 and conflict.json()["detail"]["error"] == "DOCUMENT_VERSION_CONFLICT"
    # 토큰 없음 → 401
    assert a.get("/mcp/api/documents").status_code == 401
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3a: Implement `backend/routers/aidoc_ai.py`:**
```python
"""AI(Bearer 토큰) 문서 라우터 — /mcp/api/*."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from ..config import Settings, get_settings
from ..aidoc import service, tokens
from ..aidoc.errors import AidocError, Forbidden
from ..aidoc.schemas import AppendDoc, CreateDoc, MoveDoc, RestoreDoc, UpdateDoc
from ..aidoc.tokens import Principal

router = APIRouter(prefix="/mcp/api", tags=["aidoc-ai"])


def require_principal(
    authorization: str = Header(default=""),
    settings: Settings = Depends(get_settings),
) -> Principal:
    token = authorization[7:] if authorization.lower().startswith("bearer ") else ""
    p = tokens.verify_bearer(settings, token)
    if not p:
        raise HTTPException(status_code=401, detail="유효한 토큰이 필요합니다.")
    return p


def _mapped(fn):
    try:
        return fn()
    except AidocError as e:
        raise HTTPException(status_code=e.status, detail={"error": e.code, "message": e.message, **e.extra})


def _need(p: Principal, scope: str, project=None):
    if not p.can(scope):
        raise Forbidden(f"scope 없음: {scope}")
    if not p.project_ok(project):
        raise Forbidden(f"프로젝트 권한 없음: {project}")


@router.get("/documents")
def list_docs(project: str = Query(None), p: Principal = Depends(require_principal),
              settings: Settings = Depends(get_settings)):
    _need(p, "documents:read", project if project else None)
    return _mapped(lambda: service.list_docs(settings, project=project))


@router.get("/documents/search")
def search(q: str = Query(...), p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    _need(p, "documents:read")
    return _mapped(lambda: service.search(settings, q))


@router.get("/documents/{doc_id}")
def get_doc(doc_id: str, p: Principal = Depends(require_principal),
            settings: Settings = Depends(get_settings)):
    _need(p, "documents:read")
    return _mapped(lambda: service.get(settings, doc_id))


@router.post("/documents")
def create(body: CreateDoc, p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    _need(p, "documents:create", body.project)
    return _mapped(lambda: service.create(settings, service.Actor(p.actor), body))


@router.put("/documents/{doc_id}")
def update(doc_id: str, body: UpdateDoc, p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    _need(p, "documents:update")
    return _mapped(lambda: service.update(settings, service.Actor(p.actor), doc_id, body))


@router.post("/documents/{doc_id}/append")
def append(doc_id: str, body: AppendDoc, p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    _need(p, "documents:append")
    return _mapped(lambda: service.append(settings, service.Actor(p.actor), doc_id, body))


@router.post("/documents/{doc_id}/move")
def move(doc_id: str, body: MoveDoc, p: Principal = Depends(require_principal),
         settings: Settings = Depends(get_settings)):
    _need(p, "documents:move", body.target_project)
    return _mapped(lambda: service.move(settings, service.Actor(p.actor), doc_id,
                                        body.target_project, body.target_folder))


@router.post("/documents/{doc_id}/trash")
def trash(doc_id: str, p: Principal = Depends(require_principal),
          settings: Settings = Depends(get_settings)):
    _need(p, "documents:trash")
    return _mapped(lambda: service.trash(settings, service.Actor(p.actor), doc_id))


@router.post("/documents/{doc_id}/restore")
def restore(doc_id: str, body: RestoreDoc, p: Principal = Depends(require_principal),
            settings: Settings = Depends(get_settings)):
    _need(p, "documents:update")
    return _mapped(lambda: service.restore(settings, service.Actor(p.actor), doc_id, body.version))


@router.get("/documents/{doc_id}/history")
def history(doc_id: str, p: Principal = Depends(require_principal),
            settings: Settings = Depends(get_settings)):
    _need(p, "documents:read")
    return _mapped(lambda: service.get_history(settings, doc_id))


@router.get("/projects")
def projects(p: Principal = Depends(require_principal), settings: Settings = Depends(get_settings)):
    _need(p, "documents:read")
    return service.list_projects(settings)
```
- [ ] **Step 3b: Implement `backend/routers/aidoc_web.py`** (세션 인증, 동일 서비스; actor=세션 사용자, 권한검사 없음(로그인=편집자), 감사·이력·휴지통 포함, 영구삭제 없음):
```python
"""웹(세션) 문서 라우터 — /api/aidoc/*. 로그인 사용자는 편집자."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import SessionUser, require_session
from ..config import Settings, get_settings
from ..aidoc import service
from ..aidoc.errors import AidocError
from ..aidoc.schemas import AppendDoc, CreateDoc, MoveDoc, RestoreDoc, UpdateDoc

router = APIRouter(prefix="/api/aidoc", tags=["aidoc-web"])


def _mapped(fn):
    try:
        return fn()
    except AidocError as e:
        raise HTTPException(status_code=e.status, detail={"error": e.code, "message": e.message, **e.extra})


def _actor(user: SessionUser) -> service.Actor:
    return service.Actor(user.username, is_admin=True)


@router.get("/documents")
def list_docs(project: str = Query(None), status: str = Query(None), tag: str = Query(None),
              include_trashed: bool = Query(False),
              user: SessionUser = Depends(require_session), settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.list_docs(settings, project=project, status=status, tag=tag,
                                             include_trashed=include_trashed))


@router.get("/documents/search")
def search(q: str = Query(...), user: SessionUser = Depends(require_session),
           settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.search(settings, q))


@router.get("/documents/{doc_id}")
def get_doc(doc_id: str, user: SessionUser = Depends(require_session),
            settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.get(settings, doc_id))


@router.post("/documents")
def create(body: CreateDoc, user: SessionUser = Depends(require_session),
           settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.create(settings, _actor(user), body))


@router.put("/documents/{doc_id}")
def update(doc_id: str, body: UpdateDoc, user: SessionUser = Depends(require_session),
           settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.update(settings, _actor(user), doc_id, body))


@router.post("/documents/{doc_id}/append")
def append(doc_id: str, body: AppendDoc, user: SessionUser = Depends(require_session),
           settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.append(settings, _actor(user), doc_id, body))


@router.post("/documents/{doc_id}/move")
def move(doc_id: str, body: MoveDoc, user: SessionUser = Depends(require_session),
         settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.move(settings, _actor(user), doc_id, body.target_project, body.target_folder))


@router.post("/documents/{doc_id}/trash")
def trash(doc_id: str, user: SessionUser = Depends(require_session),
          settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.trash(settings, _actor(user), doc_id))


@router.post("/documents/{doc_id}/restore")
def restore(doc_id: str, body: RestoreDoc, user: SessionUser = Depends(require_session),
            settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.restore(settings, _actor(user), doc_id, body.version))


@router.get("/documents/{doc_id}/history")
def history(doc_id: str, user: SessionUser = Depends(require_session),
            settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.get_history(settings, doc_id))


@router.get("/projects")
def projects(user: SessionUser = Depends(require_session), settings: Settings = Depends(get_settings)):
    return service.list_projects(settings)


@router.get("/audit-logs")
def audit_logs(user: SessionUser = Depends(require_session), settings: Settings = Depends(get_settings)):
    from ..aidoc import db, audit
    conn = db.connect(settings)
    try:
        return audit.list_logs(conn, 200)
    finally:
        conn.close()
```
- [ ] **Step 3c: Modify `backend/main.py`** — import + register + startup 초기화:
  - import 목록에 `aidoc_web`, `aidoc_ai` 추가 (routers).
  - `lifespan`에서 `settings.ensure_storage()` 다음에:
    ```python
    from .aidoc import db as aidoc_db, paths as aidoc_paths
    aidoc_paths.ensure_layout(settings)
    aidoc_db.init_db(settings)
    ```
  - 보호 라우터 등록부에:
    ```python
    app.include_router(aidoc_web.router, dependencies=_PROTECTED)  # 세션 보호
    app.include_router(aidoc_ai.router)  # 토큰 자체 검증(세션 의존성 없음)
    ```
    (주의: `aidoc_ai`는 `_PROTECTED`(세션) 넣지 말 것 — 자체 Bearer 검증.)
- [ ] **Step 4: Run → PASS.** 모든 test 함수 `__main__`에서 순차 호출하도록 러너 작성:
```python
if __name__ == "__main__":
    test_settings_aidoc(); test_ids(); test_errors(); test_paths(); test_db_init()
    test_store_atomic_and_history(); test_audit(); test_tokens(); test_schemas()
    test_service_create_get(); test_service_update_conflict_and_append()
    test_service_move_trash_restore(); test_service_list_search()
    test_routers_web_and_token()
    print("ALL AIDOC TESTS PASSED")
```
Run: `./.venv/Scripts/python.exe -m backend.test_aidoc` → `ALL AIDOC TESTS PASSED`.
- [ ] **Step 5:** 기존 `backend/test_smoke.py`도 여전히 통과하는지 확인: `./.venv/Scripts/python.exe -m backend.test_smoke` → `ALL SMOKE TESTS PASSED`.
- [ ] **Step 6: Commit** — `git add backend/routers/aidoc_web.py backend/routers/aidoc_ai.py backend/main.py backend/test_aidoc.py && git commit -m "feat(aidoc): 세션/토큰 라우터 + startup 초기화"`

---

## Self-Review (계획 검토)
- **Spec coverage:** 저장구조(Task4)·메타/DB(5)·API(10~14)·검색(13)·낙관적잠금(11)·이력/복원(11,12)·휴지통(12)·토큰권한(8,14)·감사(7,14)·안전경로(4,6)·원자저장(6)·환경변수(1). 노트 UI 편집·MCP·Cloudflare는 Phase 2~4로 분리(스펙 통과).
- **Placeholder scan:** 전 Task 실코드(플레이스홀더 없음).
- **Type consistency:** `service.Actor(name, is_admin)`·`Principal(actor,scopes,allowed_projects)`·`_apply_new_content`·`_row_to_meta`(+content 별도)·`storage_path` 상대경로 규약 일관.
- MVP 제외 항목(PDF/벡터/영구삭제)은 계획에 없음 — 의도적.

## 배포 참고 (Phase 1 이후 실서버)
- `.env`에 `DOCUMENT_ROOT=/mnt/hdd/server/AI_documents`, `AIDOC_DB_PATH`, `AIDOC_TOKENS_FILE`, `AIDOC_PROJECTS` 설정.
- `tokens.json`을 HDD에 생성(각 AI별 토큰 원문은 발급 후 안전 보관, 서버엔 sha256만). 예: `python -c "import secrets,hashlib;t=secrets.token_urlsafe(32);print(t, hashlib.sha256(t.encode()).hexdigest())"`.
- Docker: 기존 `/mnt/hdd/server` 볼륨에 이미 포함 → 추가 마운트 불필요. `docker compose up -d --build` 후 startup에서 폴더·DB 자동 생성.
