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
