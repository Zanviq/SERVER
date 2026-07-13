"""MCP 도구 어댑터 — aidoc 서비스를 MCP 도구로 노출(REST 위의 얇은 계층).

권한은 authz 모듈로 REST 라우터와 공유(문서 실제 project 기준, 교차 프로젝트 IDOR 방지).
전송(JSON-RPC/HTTP)은 routers/mcp.py가 담당하고, 여기서는 순수 로직만 둔다.
"""
from __future__ import annotations

from . import authz, service
from .errors import BadRequest
from .schemas import AppendDoc, CreateDoc, MoveDoc, RestoreDoc, UpdateDoc
from .tokens import Principal

SERVER_NAME = "aidoc"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL = "2025-06-18"

_STR = {"type": "string"}


def _tool(name, description, properties, required=None):
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required or [],
        },
    }


TOOLS = [
    _tool("list_documents", "문서 목록을 조회한다. project로 필터 가능(권한 있는 것만).",
          {"project": {"type": "string", "description": "프로젝트명(선택)"}}),
    _tool("search_documents", "전문 검색(FTS5). 제목/본문/태그/프로젝트/카테고리.",
          {"q": {"type": "string", "description": "검색어"}}, ["q"]),
    _tool("get_document", "문서 상세(본문 포함)를 조회한다.",
          {"document_id": _STR}, ["document_id"]),
    _tool("create_document",
          "새 문서를 만든다. project 미지정 시 inbox, 지정 시 등록된 projects/{project}에 저장. "
          "folder 지정 시 그 하위 폴더에 저장(없으면 자동 생성).",
          {"title": _STR, "content": _STR,
           "project": {"type": "string", "description": "등록 프로젝트명(선택)"},
           "folder": {"type": "string", "description": "프로젝트/인박스 하위 폴더 경로(선택)"},
           "category": _STR, "tags": {"type": "array", "items": {"type": "string"}},
           "status": _STR},
          ["title"]),
    _tool("update_document",
          "문서를 수정한다. expected_version이 현재와 다르면 409 충돌(먼저 get으로 최신 버전 확인).",
          {"document_id": _STR, "expected_version": {"type": "integer"},
           "title": _STR, "content": _STR, "change_summary": _STR},
          ["document_id", "expected_version"]),
    _tool("append_document", "문서 끝에 내용을 덧붙인다(새 버전 생성).",
          {"document_id": _STR, "content": _STR, "change_summary": _STR},
          ["document_id", "content"]),
    _tool("move_document", "문서를 다른 프로젝트/폴더로 이동한다.",
          {"document_id": _STR, "target_project": _STR,
           "target_folder": {"type": "string", "description": "knowledge/templates/archive/inbox 하위"}},
          ["document_id"]),
    _tool("trash_document", "문서를 휴지통으로 이동한다(영구삭제 아님).",
          {"document_id": _STR}, ["document_id"]),
    _tool("restore_document",
          "문서를 복원한다. version 미지정 시 휴지통 복원, 지정 시 그 버전 내용으로 새 버전 생성.",
          {"document_id": _STR, "version": {"type": "integer"}}, ["document_id"]),
    _tool("get_document_history", "문서의 버전 이력을 조회한다.",
          {"document_id": _STR}, ["document_id"]),
    _tool("list_projects", "접근 가능한 등록 프로젝트 목록.", {}),
    _tool("semantic_search",
          "의미(임베딩) 기반 검색. 질의와 뜻이 가까운 문서를 찾는다(관련 문서 탐색). "
          "project 지정 시 그 프로젝트로 범위 한정, 미지정 시 권한 내 전체.",
          {"query": _STR,
           "project": {"type": "string", "description": "범위 프로젝트(선택). 미지정=전체"},
           "limit": {"type": "integer", "description": "최대 결과 수(기본 10)"}},
          ["query"]),
    _tool("reindex",
          "임베딩이 없거나 본문이 바뀐 문서를 일괄 재색인(임베딩 갱신). "
          "옛 문서를 의미검색·그래프에 포함시킬 때 사용. 권한 내 프로젝트만 처리.",
          {}),
    _tool("export_folder",
          "웹 프로젝트 폴더의 '내용물'을 로컬로 내려받기 위해, 그 폴더 안 문서들의 "
          "relative_path + content를 반환한다. 폴더가 통째로 오는 게 아니라 안의 파일들이 온다. "
          "→ 먼저 로컬 대상 폴더를 정한 뒤, 각 항목을 <로컬폴더>/<relative_path> 로 저장하라. "
          "project 미지정=inbox, folder 미지정=프로젝트 전체.",
          {"project": {"type": "string", "description": "프로젝트명(선택). 미지정=inbox"},
           "folder": {"type": "string", "description": "프로젝트 하위 폴더(선택). 미지정=전체"},
           "recursive": {"type": "boolean", "description": "하위 폴더까지 포함(기본 true)"}},
          []),
]

_TOOL_NAMES = {t["name"] for t in TOOLS}


def list_tools() -> list[dict]:
    return TOOLS


def _actor(p: Principal) -> service.Actor:
    return service.Actor(p.actor)


def call_tool(settings, p: Principal, name: str, args: dict):
    """도구 실행. 권한 검사(authz) 후 서비스 위임. AidocError는 호출자가 매핑."""
    args = args or {}
    if name == "list_documents":
        authz.need_scope(p, "documents:read")
        project = args.get("project")
        if project:
            authz.need_resource(p, project)
            return service.list_docs(settings, project=project)
        return authz.filter_allowed(p, service.list_docs(settings))

    if name == "search_documents":
        authz.need_scope(p, "documents:read")
        return authz.filter_allowed(p, service.search(settings, _require(args, "q")))

    if name == "get_document":
        authz.need_scope(p, "documents:read")
        doc_id = _require(args, "document_id")
        authz.need_resource(p, service.get_project(settings, doc_id))
        return service.get(settings, doc_id)

    if name == "create_document":
        authz.need_scope(p, "documents:create")
        body = CreateDoc(
            title=_require(args, "title"), content=args.get("content", ""),
            project=args.get("project"), category=args.get("category"),
            tags=args.get("tags", []), status=args.get("status", "draft"),
            folder=args.get("folder"),
        )
        authz.need_create(p, body.project)
        return service.create(settings, _actor(p), body)

    if name == "update_document":
        authz.need_scope(p, "documents:update")
        doc_id = _require(args, "document_id")
        authz.need_resource(p, service.get_project(settings, doc_id))
        body = UpdateDoc(
            expected_version=int(_require(args, "expected_version")),
            title=args.get("title"), content=args.get("content"),
            change_summary=args.get("change_summary", ""),
        )
        return service.update(settings, _actor(p), doc_id, body)

    if name == "append_document":
        authz.need_scope(p, "documents:append")
        doc_id = _require(args, "document_id")
        authz.need_resource(p, service.get_project(settings, doc_id))
        body = AppendDoc(content=_require(args, "content"),
                         change_summary=args.get("change_summary", ""))
        return service.append(settings, _actor(p), doc_id, body)

    if name == "move_document":
        authz.need_scope(p, "documents:move")
        doc_id = _require(args, "document_id")
        authz.need_resource(p, service.get_project(settings, doc_id))
        body = MoveDoc(target_project=args.get("target_project"),
                       target_folder=args.get("target_folder"))
        authz.need_create(p, body.target_project)
        return service.move(settings, _actor(p), doc_id, body.target_project, body.target_folder)

    if name == "trash_document":
        authz.need_scope(p, "documents:trash")
        doc_id = _require(args, "document_id")
        authz.need_resource(p, service.get_project(settings, doc_id))
        return service.trash(settings, _actor(p), doc_id)

    if name == "restore_document":
        authz.need_scope(p, "documents:update")
        doc_id = _require(args, "document_id")
        authz.need_resource(p, service.get_project(settings, doc_id))
        body = RestoreDoc(version=args.get("version"))
        return service.restore(settings, _actor(p), doc_id, body.version)

    if name == "get_document_history":
        authz.need_scope(p, "documents:read")
        doc_id = _require(args, "document_id")
        authz.need_resource(p, service.get_project(settings, doc_id))
        return service.get_history(settings, doc_id)

    if name == "list_projects":
        authz.need_scope(p, "documents:read")
        return authz.allowed_projects(p, service.list_projects(settings))

    if name == "semantic_search":
        authz.need_scope(p, "documents:read")
        project = args.get("project")
        if project:
            authz.need_resource(p, project)
        limit = int(args.get("limit") or 10)
        return authz.filter_allowed(
            p, service.semantic_search(settings, _require(args, "query"), project=project, limit=limit)
        )

    if name == "reindex":
        from . import embeddings
        authz.need_scope(p, "documents:update")
        scope = None if "*" in p.allowed_projects else list(p.allowed_projects)
        return embeddings.reindex(settings, projects=scope)

    if name == "export_folder":
        authz.need_scope(p, "documents:read")
        project = args.get("project")
        authz.need_resource(p, project)  # project 접근권(inbox=None은 '*'만)
        return service.export_folder(settings, project=project, folder=args.get("folder"),
                                     recursive=args.get("recursive", True))

    raise BadRequest(f"알 수 없는 도구: {name}")


def _require(args: dict, key: str):
    if key not in args or args[key] in (None, ""):
        raise BadRequest(f"필수 인자 누락: {key}")
    return args[key]
