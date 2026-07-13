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

CREATE TABLE IF NOT EXISTS document_embeddings (
  doc_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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
    conn.execute("PRAGMA busy_timeout=5000")  # 쓰기 경쟁 시 5s 대기 후 실패(잠금 오류 완화)
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
