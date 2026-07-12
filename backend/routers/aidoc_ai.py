"""AI(Bearer 토큰) 문서 라우터 — /mcp/api/*."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from ..config import Settings, get_settings
from ..aidoc import service, tokens
from ..aidoc.errors import AidocError
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
        raise HTTPException(status_code=403, detail={"error": "FORBIDDEN", "message": f"scope 없음: {scope}"})
    if not p.project_ok(project):
        raise HTTPException(
            status_code=403,
            detail={"error": "FORBIDDEN", "message": f"프로젝트 권한 없음: {project}"},
        )


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
