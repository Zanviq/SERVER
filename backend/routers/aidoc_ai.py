"""AI(Bearer 토큰) 문서 라우터 — /mcp/api/*.

보안: scope 검사에 더해, 문서 접근은 **문서의 실제 project**로 권한을 판정한다
(호출자가 준 project 힌트를 신뢰하지 않음 → 교차 프로젝트 IDOR 방지).
권한 검사는 `backend.aidoc.authz`에 두어 MCP 어댑터와 동일 구현을 공유한다.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from ..config import Settings, get_settings
from ..aidoc import authz, cf_access, service, tokens
from ..aidoc.errors import AidocError
from ..aidoc.schemas import AppendDoc, CreateDoc, MoveDoc, RestoreDoc, UpdateDoc
from ..aidoc.tokens import Principal

router = APIRouter(prefix="/mcp/api", tags=["aidoc-ai"])


def require_principal(
    authorization: str = Header(default=""),
    cf_access_jwt: str = Header(default="", alias="Cf-Access-Jwt-Assertion"),
    settings: Settings = Depends(get_settings),
) -> Principal:
    # 선택적 Cloudflare Access 계층(설정 시): Access 정책까지 통과해야 함.
    if cf_access.enabled(settings) and cf_access.verify(settings, cf_access_jwt) is None:
        raise HTTPException(status_code=403, detail="Cloudflare Access 검증 실패.")
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


@router.get("/documents")
def list_docs(project: str = Query(None), p: Principal = Depends(require_principal),
              settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:read")
        if project:
            authz.need_resource(p, project)  # 명시 project는 접근 가능한 것만
            return service.list_docs(settings, project=project)
        return authz.filter_allowed(p, service.list_docs(settings))
    return _mapped(op)


@router.get("/documents/search")
def search(q: str = Query(...), p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:read")
        return authz.filter_allowed(p, service.search(settings, q))
    return _mapped(op)


@router.get("/documents/{doc_id}")
def get_doc(doc_id: str, p: Principal = Depends(require_principal),
            settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:read")
        authz.need_resource(p, service.get_project(settings, doc_id))
        return service.get(settings, doc_id)
    return _mapped(op)


@router.post("/documents")
def create(body: CreateDoc, p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:create")
        authz.need_create(p, body.project)
        return service.create(settings, service.Actor(p.actor), body)
    return _mapped(op)


@router.put("/documents/{doc_id}")
def update(doc_id: str, body: UpdateDoc, p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:update")
        authz.need_resource(p, service.get_project(settings, doc_id))
        return service.update(settings, service.Actor(p.actor), doc_id, body)
    return _mapped(op)


@router.post("/documents/{doc_id}/append")
def append(doc_id: str, body: AppendDoc, p: Principal = Depends(require_principal),
           settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:append")
        authz.need_resource(p, service.get_project(settings, doc_id))
        return service.append(settings, service.Actor(p.actor), doc_id, body)
    return _mapped(op)


@router.post("/documents/{doc_id}/move")
def move(doc_id: str, body: MoveDoc, p: Principal = Depends(require_principal),
         settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:move")
        authz.need_resource(p, service.get_project(settings, doc_id))  # 원본 접근권
        authz.need_create(p, body.target_project)                      # 대상 권한
        return service.move(settings, service.Actor(p.actor), doc_id,
                            body.target_project, body.target_folder)
    return _mapped(op)


@router.post("/documents/{doc_id}/trash")
def trash(doc_id: str, p: Principal = Depends(require_principal),
          settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:trash")
        authz.need_resource(p, service.get_project(settings, doc_id))
        return service.trash(settings, service.Actor(p.actor), doc_id)
    return _mapped(op)


@router.post("/documents/{doc_id}/restore")
def restore(doc_id: str, body: RestoreDoc, p: Principal = Depends(require_principal),
            settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:update")
        authz.need_resource(p, service.get_project(settings, doc_id))
        return service.restore(settings, service.Actor(p.actor), doc_id, body.version)
    return _mapped(op)


@router.get("/documents/{doc_id}/history")
def history(doc_id: str, p: Principal = Depends(require_principal),
            settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:read")
        authz.need_resource(p, service.get_project(settings, doc_id))
        return service.get_history(settings, doc_id)
    return _mapped(op)


@router.get("/projects")
def projects(p: Principal = Depends(require_principal), settings: Settings = Depends(get_settings)):
    def op():
        authz.need_scope(p, "documents:read")
        return authz.allowed_projects(p, service.list_projects(settings))
    return _mapped(op)
