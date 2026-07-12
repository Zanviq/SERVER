"""AI 문서 서비스 레이어 — 파일+DB+버전+감사 오케스트레이션."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone

from ..config import Settings
from . import audit, db, ids, paths, store
from .errors import BadRequest, NotFound, VersionConflict
from .schemas import AppendDoc, CreateDoc, UpdateDoc


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
        "storage_path": row["storage_path"],
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
