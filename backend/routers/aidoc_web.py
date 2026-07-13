"""웹(세션) 문서 라우터 — /api/aidoc/*. 로그인 사용자는 편집자."""
from __future__ import annotations

import sqlite3

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
    except sqlite3.OperationalError:
        raise HTTPException(status_code=503,
                            detail={"error": "STORAGE_BUSY", "message": "저장소가 잠시 바쁩니다. 다시 시도하세요."})


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


@router.get("/documents/semantic-search")
def semantic_search(q: str = Query(...), project: str = Query(None), limit: int = Query(10),
                    user: SessionUser = Depends(require_session),
                    settings: Settings = Depends(get_settings)):
    return _mapped(lambda: service.semantic_search(settings, q, project=project or None, limit=limit))


@router.post("/reindex")
def reindex(user: SessionUser = Depends(require_session), settings: Settings = Depends(get_settings)):
    from ..aidoc import embeddings
    return _mapped(lambda: embeddings.reindex(settings))


@router.get("/graph")
def graph(project: str = Query(None), threshold: float = Query(None), max_edges: int = Query(None),
          user: SessionUser = Depends(require_session), settings: Settings = Depends(get_settings)):
    from ..aidoc import graph as aidoc_graph
    return _mapped(lambda: aidoc_graph.build_graph(
        settings, project=project or None, threshold=threshold, max_edges=max_edges))


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
