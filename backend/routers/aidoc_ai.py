"""AI(Bearer 토큰) 문서 라우터 — /mcp/api/*.

보안: scope 검사에 더해, 문서 접근은 **문서의 실제 project**로 권한을 판정한다
(호출자가 준 project 힌트를 신뢰하지 않음 → 교차 프로젝트 IDOR 방지).
- 생성/이동 대상: project 미지정(inbox/공유)은 create 규약상 허용(project_ok).
- 읽기/수정/삭제 등 기존 리소스 접근: 문서의 project가 allowed에 있어야 하며,
  project 미지정(inbox) 문서는 '*' 토큰만 접근 가능.
"""
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


def _forbid(msg: str):
    raise HTTPException(status_code=403, detail={"error": "FORBIDDEN", "message": msg})


def _need_scope(p: Principal, scope: str):
    if not p.can(scope):
        _forbid(f"scope 없음: {scope}")


def _need_create(p: Principal, project):
    """생성/이동 대상 권한: '*' 또는 project 미지정(inbox/공유) 또는 allowed 포함."""
    if not p.project_ok(project):
        _forbid(f"프로젝트 권한 없음: {project}")


def _need_resource(p: Principal, project):
    """기존 문서 접근 권한: 문서의 실제 project로 판정.

    '*'가 아니면 project 미지정(inbox) 문서는 접근 불가(정보 노출 방지).
    """
    if "*" in p.allowed_projects:
        return
    if project is None or project not in p.allowed_projects:
        _forbid(f"프로젝트 권한 없음: {project}")


def _filter_allowed(p: Principal, docs: list[dict]) -> list[dict]:
    """'*'가 아니면 결과를 allowed project로 강제 축소(inbox/타 프로젝트 제외)."""
    if "*" in p.allowed_projects:
        return docs
    allowed = set(p.allowed_projects)
    return [d for d in docs if d.get("project") in allowed]


@router.get("/documents")
def list_docs(project: str = Query(None), p: Principal = Depends(require_principal),
              settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:read")
    if project:
        _need_resource(p, project)  # 명시 project는 접근 가능한 것만
        return _mapped(lambda: service.list_docs(settings, project=project))
    docs = _mapped(lambda: service.list_docs(settings))
    return _filter_allowed(p, docs)


@router.get("/documents/search")
def search(q: str = Query(...), p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:read")
    hits = _mapped(lambda: service.search(settings, q))
    return _filter_allowed(p, hits)


@router.get("/documents/{doc_id}")
def get_doc(doc_id: str, p: Principal = Depends(require_principal),
            settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:read")

    def op():
        _need_resource(p, service.get_project(settings, doc_id))
        return service.get(settings, doc_id)
    return _mapped(op)


@router.post("/documents")
def create(body: CreateDoc, p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:create")
    _need_create(p, body.project)
    return _mapped(lambda: service.create(settings, service.Actor(p.actor), body))


@router.put("/documents/{doc_id}")
def update(doc_id: str, body: UpdateDoc, p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:update")

    def op():
        _need_resource(p, service.get_project(settings, doc_id))
        return service.update(settings, service.Actor(p.actor), doc_id, body)
    return _mapped(op)


@router.post("/documents/{doc_id}/append")
def append(doc_id: str, body: AppendDoc, p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:append")

    def op():
        _need_resource(p, service.get_project(settings, doc_id))
        return service.append(settings, service.Actor(p.actor), doc_id, body)
    return _mapped(op)


@router.post("/documents/{doc_id}/move")
def move(doc_id: str, body: MoveDoc, p: Principal = Depends(require_principal),
         settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:move")

    def op():
        _need_resource(p, service.get_project(settings, doc_id))  # 원본 접근권
        _need_create(p, body.target_project)                      # 대상 권한
        return service.move(settings, service.Actor(p.actor), doc_id,
                            body.target_project, body.target_folder)
    return _mapped(op)


@router.post("/documents/{doc_id}/trash")
def trash(doc_id: str, p: Principal = Depends(require_principal),
          settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:trash")

    def op():
        _need_resource(p, service.get_project(settings, doc_id))
        return service.trash(settings, service.Actor(p.actor), doc_id)
    return _mapped(op)


@router.post("/documents/{doc_id}/restore")
def restore(doc_id: str, body: RestoreDoc, p: Principal = Depends(require_principal),
            settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:update")

    def op():
        _need_resource(p, service.get_project(settings, doc_id))
        return service.restore(settings, service.Actor(p.actor), doc_id, body.version)
    return _mapped(op)


@router.get("/documents/{doc_id}/history")
def history(doc_id: str, p: Principal = Depends(require_principal),
            settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:read")

    def op():
        _need_resource(p, service.get_project(settings, doc_id))
        return service.get_history(settings, doc_id)
    return _mapped(op)


@router.get("/projects")
def projects(p: Principal = Depends(require_principal), settings: Settings = Depends(get_settings)):
    _need_scope(p, "documents:read")
    all_projects = service.list_projects(settings)
    if "*" in p.allowed_projects:
        return all_projects
    return [pr for pr in all_projects if pr in p.allowed_projects]
