"""AI 문서 서비스 레이어 — 파일+DB+버전+감사 오케스트레이션."""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from ..config import Settings
from . import audit, db, embeddings, ids, paths, store
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


def _check_id(doc_id: str) -> None:
    """문서 id 형식 방어(경로 조작 차단). 잘못된 형식은 존재하지 않는 것으로 취급."""
    if not ids.is_document_id(doc_id):
        raise NotFound()


def _get_row(conn, doc_id):
    _check_id(doc_id)
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
    embeddings.index_document(settings, doc_id, data.title, data.content, store.sha256(data.content))
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


def get_project(settings: Settings, doc_id: str) -> str | None:
    """문서의 실제 project 반환(권한 검사용). 없으면 NotFound."""
    conn = db.connect(settings)
    try:
        return _get_row(conn, doc_id)["project"]
    finally:
        conn.close()


def _apply_new_content(settings, actor, doc_id, new_title, mutate, change_summary,
                       expected_version=None) -> dict:
    """새 본문으로 새 버전 생성. 새 본문은 **임계구역 안에서 최신 본문으로부터** 계산한다.

    `mutate(old_content) -> new_content` 는 항상 방금 읽은 최신 본문을 받아 새 본문을 만든다
    → append/복원처럼 이전 본문에 의존하는 연산이 스냅샷 경쟁으로 쓰기를 잃지 않는다.

    낙관적 잠금은 `UPDATE ... WHERE version=?`로 원자 보장:
      (1) 조건부 DB 갱신으로 버전 검증 → (2) 통과 시에만 파일 기록 → (3) commit.
      파일 기록 실패 시 커밋 전이라 롤백되어 DB·파일이 일관. 충돌 시 파일을 건드리지 않는다.
    - expected_version 지정(update): 기대와 다르면 즉시 VersionConflict(409).
    - expected_version 미지정(append/복원): 경쟁 쓰기로 실패하면 최신 본문으로 몇 회 재시도.
    """
    attempts = 1 if expected_version is not None else 16
    for attempt in range(attempts):
        conn = db.connect(settings)
        try:
            row = _get_row(conn, doc_id)
            cur_version = row["version"]
            if expected_version is not None and expected_version != cur_version:
                raise VersionConflict(expected_version, cur_version)
            old_content = store.read(settings, row["storage_path"])
            new_content = mutate(old_content)  # 최신 본문 기준으로 새 본문 계산(임계구역 내)
            if len(new_content.encode("utf-8")) > settings.aidoc_max_bytes:
                raise BadRequest("본문이 너무 큽니다.")
            new_version = cur_version + 1
            title = new_title if new_title is not None else row["title"]
            now = _now()
            hist_rel = f".history/{doc_id}/{cur_version:04d}.md"
            # 원자적 잠금: 우리가 읽은 버전일 때만 갱신 → 경쟁 쓰기는 rowcount 0으로 검출.
            res = conn.execute(
                "UPDATE documents SET title=?,content_hash=?,version=?,updated_by=?,updated_at=? "
                "WHERE id=? AND version=?",
                (title, store.sha256(new_content), new_version, actor.name, now, doc_id, cur_version),
            )
            if res.rowcount != 1:
                if expected_version is None and attempt < attempts - 1:
                    continue  # 경쟁 쓰기 — 최신 본문으로 재시도(finally가 conn 닫음)
                latest = conn.execute("SELECT version FROM documents WHERE id=?", (doc_id,)).fetchone()
                raise VersionConflict(
                    expected_version if expected_version is not None else cur_version,
                    latest["version"] if latest else cur_version,
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
            # DB 검증을 통과한 뒤에야 파일 기록(이전본 백업 + 원자 교체). 실패 시 아래 close에서 롤백.
            store.backup_and_write(settings, doc_id, row["storage_path"], new_content, old_content, cur_version)
            conn.commit()
            out = _get_row(conn, doc_id)
            meta = _row_to_meta(out)
            meta["content"] = new_content
            embeddings.index_document(settings, doc_id, title, new_content, store.sha256(new_content))
            return meta
        finally:
            conn.close()
    # 재시도 소진(극히 드묾): 최신 버전으로 충돌 보고
    raise VersionConflict(0, cur_version)  # pragma: no cover


def update(settings, actor: Actor, doc_id: str, data: UpdateDoc) -> dict:
    # 내용 미지정(제목만 변경 등)이면 최신 본문 유지. 새 내용이면 전체 교체.
    def mutate(old: str) -> str:
        return data.content if data.content is not None else old
    return _apply_new_content(settings, actor, doc_id, data.title, mutate,
                              data.change_summary, expected_version=data.expected_version)


def append(settings, actor: Actor, doc_id: str, data: AppendDoc) -> dict:
    def mutate(old: str) -> str:
        sep = "" if (not old or old.endswith("\n")) else "\n"
        return old + sep + data.content
    return _apply_new_content(settings, actor, doc_id, None, mutate, data.change_summary or "append")


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


def _update_path(conn, doc_id, storage_path, project=None, set_trash=None, orig_path=None):
    sets = ["storage_path=?"]; vals = [storage_path]
    sets.append("project=?"); vals.append(project)  # project는 명시적으로 갱신
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
            tf = target_folder.replace("\\", "/").strip("/")
            if ".." in tf.split("/") or tf.startswith("/"):
                raise BadRequest("허용되지 않은 폴더 경로입니다.")
            top = tf.split("/", 1)[0]
            if top not in allowed:
                raise BadRequest("허용되지 않은 폴더입니다.")
            dir_rel = tf; project = None
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
        # project 변경 → FTS 색인의 project 항목도 최신화(검색 일관성).
        _index_fts(conn, doc_id, row["title"], store.read(settings, dst),
                   json.loads(row["tags"] or "[]"), project, row["category"])
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
    _check_id(doc_id)  # version 분기가 _get_row 이전에 .history 경로를 읽으므로 선검증
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
            # 원경로 project 복원: projects/<p>/... → <p>, 그 외 → None
            parts = dst.split("/")
            proj = parts[1] if len(parts) >= 2 and parts[0] == "projects" else None
            store.move_file(settings, row["storage_path"], dst)
            _update_path(conn, doc_id, dst, project=proj, set_trash=False, orig_path="")
            _index_fts(conn, doc_id, row["title"], store.read(settings, dst),
                       json.loads(row["tags"] or "[]"), proj, row["category"])
            audit.log(conn, actor.name, "restore_document", doc_id=doc_id, project=proj)
            conn.commit()
            out = _get_row(conn, doc_id)
        finally:
            conn.close()
        meta = _row_to_meta(out); meta["content"] = store.read(settings, out["storage_path"]); return meta
    # 특정 버전 내용으로 복원 = 그 버전 본문으로 교체하는 새 버전 생성(의도적 덮어쓰기).
    hist = store.read(settings, f".history/{doc_id}/{int(version):04d}.md")
    return _apply_new_content(settings, actor, doc_id, None, lambda _old: hist, f"restore v{version}")


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


def _fts_query(q: str) -> str:
    """사용자 입력을 안전한 FTS5 식으로 변환.

    각 토큰을 큰따옴표로 감싸고 내부 따옴표는 이스케이프(`""`)한다. 이렇게 하면
    `:`(컬럼필터), `AND/OR/NOT`(예약어), `*`, `-`, `(`, 불균형 따옴표 등 어떤 입력도
    구문 오류 없이 리터럴 토큰으로 안전하게 검색된다(FTS5 인젝션/크래시 방지).
    """
    import re
    tokens = [t for t in re.split(r"\s+", (q or "").strip()) if t]
    return " ".join('"' + t.replace('"', '""') + '"' for t in tokens)


def _like_search(conn, q: str, limit: int) -> list[dict]:
    ql = f"%{(q or '').lower()}%"
    cur = conn.execute(
        "SELECT * FROM documents WHERE trashed=0 AND lower(title) LIKE ? "
        "ORDER BY updated_at DESC LIMIT ?",
        (ql, int(limit)),
    )
    out = []
    for r in cur.fetchall():
        m = _row_to_meta(r); m["snippet"] = _snippet(r["title"], q); out.append(m)
    return out


def search(settings, q: str, limit: int = 50) -> list[dict]:
    if not (q and q.strip()):
        return []
    conn = db.connect(settings)
    try:
        fq = _fts_query(q)
        if db.has_fts5(conn) and fq:
            try:
                cur = conn.execute(
                    "SELECT d.*, snippet(documents_fts,2,'[',']','…',12) AS snip "
                    "FROM documents_fts f JOIN documents d ON d.id=f.doc_id "
                    "WHERE documents_fts MATCH ? AND d.trashed=0 LIMIT ?",
                    (fq, int(limit)),
                )
                return [dict(_row_to_meta(r), snippet=r["snip"] or "") for r in cur.fetchall()]
            except sqlite3.OperationalError:
                pass  # 예기치 못한 FTS 파싱 실패 → LIKE 폴백(방어적)
        return _like_search(conn, q, limit)
    finally:
        conn.close()


def semantic_search(settings, query: str, *, project=None, limit: int = 10) -> list[dict]:
    """임베딩 코사인 유사도 기반 의미 검색. 임베딩 불가 시 FTS 검색으로 폴백.

    project 지정 시 그 프로젝트로 범위 한정. 결과는 DocMeta + score + snippet.
    (권한/격리 필터는 호출 라우터가 authz.filter_allowed로 적용.)
    """
    if not (query and query.strip()):
        return []
    qvec = embeddings.embed_text(settings, query)
    if not qvec:
        return search(settings, query, limit)  # 임베딩 불가 → FTS 폴백
    qn = embeddings.normalize(qvec)
    scored = sorted(
        ((embeddings.dot(qn, vec), doc_id)
         for doc_id, vec in embeddings.load_vectors(settings, project=project)),
        reverse=True,
    )[: max(1, int(limit))]
    if not scored:
        return []
    conn = db.connect(settings)
    try:
        out = []
        for score, doc_id in scored:
            row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
            if not row:
                continue
            m = _row_to_meta(row)
            m["score"] = round(float(score), 4)
            try:
                m["snippet"] = store.read(settings, row["storage_path"]).strip().replace("\n", " ")[:160]
            except Exception:  # noqa: BLE001
                m["snippet"] = ""
            out.append(m)
        return out
    finally:
        conn.close()


def list_projects(settings) -> list[str]:
    return list(settings.aidoc_projects)
