"""MCP Streamable-HTTP 엔드포인트 — POST /mcp (JSON-RPC 2.0).

Claude Code/Codex가 원격 MCP로 연결. 인증은 /mcp/api/*와 동일한 Bearer 토큰.
스테이트리스(Mcp-Session-Id 미요구), 단일 JSON 응답(application/json).
지원 메서드: initialize, ping, tools/list, tools/call, notifications/*.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.responses import JSONResponse

from ..config import Settings, get_settings
from ..aidoc import cf_access, mcp_server, tokens
from ..aidoc.errors import AidocError
from ..aidoc.tokens import Principal

router = APIRouter(tags=["mcp"])

# JSON-RPC 표준 오류 코드
_PARSE_ERROR = -32700
_INVALID_REQUEST = -32600
_METHOD_NOT_FOUND = -32601


def _bearer(authorization: str) -> str:
    return authorization[7:] if authorization.lower().startswith("bearer ") else ""


def _rpc_result(req_id, result) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _rpc_error(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def _require_principal(settings: Settings, authorization: str) -> Principal | None:
    return tokens.verify_bearer(settings, _bearer(authorization))


@router.post("/mcp")
async def mcp_endpoint(
    request: Request,
    authorization: str = Header(default=""),
    cf_access_jwt: str = Header(default="", alias="Cf-Access-Jwt-Assertion"),
    settings: Settings = Depends(get_settings),
):
    # 0) 선택적 Cloudflare Access 계층(설정 시)
    if cf_access.enabled(settings) and cf_access.verify(settings, cf_access_jwt) is None:
        return JSONResponse(
            status_code=403,
            content={"jsonrpc": "2.0", "id": None,
                     "error": {"code": _INVALID_REQUEST, "message": "Cloudflare Access 검증 실패."}},
        )

    # 1) Bearer 인증 (WWW-Authenticate 포함 401)
    principal = _require_principal(settings, authorization)
    if not principal:
        return JSONResponse(
            status_code=401,
            content={"jsonrpc": "2.0", "id": None,
                     "error": {"code": _INVALID_REQUEST, "message": "유효한 토큰이 필요합니다."}},
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 2) 본문 파싱
    try:
        payload = json.loads(await request.body() or b"{}")
    except json.JSONDecodeError:
        return JSONResponse(status_code=400, content=_rpc_error(None, _PARSE_ERROR, "JSON 파싱 오류"))

    # 배치 요청 지원(리스트) — 각각 처리, 알림은 응답 제외
    if isinstance(payload, list):
        out = [r for r in (_handle_one(settings, principal, m) for m in payload) if r is not None]
        return JSONResponse(content=out) if out else Response(status_code=202)

    result = _handle_one(settings, principal, payload)
    if result is None:  # 알림(notification) — 응답 없음
        return Response(status_code=202)
    return JSONResponse(content=result)


def _handle_one(settings: Settings, principal: Principal, msg) -> dict | None:
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return _rpc_error(msg.get("id") if isinstance(msg, dict) else None,
                          _INVALID_REQUEST, "유효하지 않은 JSON-RPC 요청")
    method = msg.get("method")
    req_id = msg.get("id")
    is_notification = "id" not in msg

    # 알림(initialized 등)은 응답하지 않음
    if is_notification:
        return None

    if method == "initialize":
        params = msg.get("params") or {}
        client_proto = params.get("protocolVersion") or mcp_server.DEFAULT_PROTOCOL
        return _rpc_result(req_id, {
            "protocolVersion": client_proto,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": mcp_server.SERVER_NAME, "version": mcp_server.SERVER_VERSION},
        })

    if method == "ping":
        return _rpc_result(req_id, {})

    if method == "tools/list":
        return _rpc_result(req_id, {"tools": mcp_server.list_tools()})

    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name", "")
        args = params.get("arguments") or {}
        try:
            data = mcp_server.call_tool(settings, principal, name, args)
            text = json.dumps(data, ensure_ascii=False, default=str)
            return _rpc_result(req_id, {"content": [{"type": "text", "text": text}], "isError": False})
        except AidocError as e:
            detail = {"error": e.code, "message": e.message, **e.extra}
            text = json.dumps(detail, ensure_ascii=False)
            return _rpc_result(req_id, {"content": [{"type": "text", "text": text}], "isError": True})

    return _rpc_error(req_id, _METHOD_NOT_FOUND, f"알 수 없는 메서드: {method}")
