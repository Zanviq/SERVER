# AI 문서 시스템 Phase 2 (MCP 서버 + 연결) Implementation Plan

**Goal:** 기존 FastAPI 앱에 `/mcp`(MCP Streamable-HTTP, JSON-RPC 2.0) 엔드포인트를 추가해 Claude Code/Codex가 aidoc 문서 도구를 원격 MCP로 사용하게 한다. Phase 1의 Bearer 토큰·프로젝트 격리를 재사용.

**Architecture:** 무거운 MCP SDK 의존성 없이 MCP Streamable-HTTP의 JSON-RPC(initialize/tools.list/tools.call/ping/notifications)를 직접 구현. 도구는 서비스 레이어에 위임하고, 권한 검사는 REST 라우터와 공유하는 `backend/aidoc/authz.py`를 사용(격리 규칙 단일 출처). MCP는 REST 위의 얇은 어댑터.

**Tech Stack:** Python 3.11, FastAPI, stdlib json. 새 pip 의존성 없음.

## Global Constraints
- 인증: `/mcp`도 `/mcp/api/*`와 동일한 Bearer 토큰(require_principal). 세션 의존성 없음.
- 권한: scope + 문서 실제 project로 판정. list/search는 allowed로 축소. inbox(None) 읽기는 `*`만.
- 응답: 단일 JSON(`application/json`). 스테이트리스(Mcp-Session-Id 미요구).
- 테스트: `backend/test_aidoc.py`에 MCP 테스트 추가. 커밋은 각 Task 끝.

## 파일 구조
- Create `backend/aidoc/authz.py` — Principal 권한 검사(도메인 예외 Forbidden 발생). REST/MCP 공유.
- Modify `backend/routers/aidoc_ai.py` — authz 모듈 사용으로 리팩터(동작 동일).
- Create `backend/aidoc/mcp_server.py` — 도구 레지스트리(TOOLS) + dispatch(initialize/tools.list/tools.call).
- Create `backend/routers/mcp.py` — `POST /mcp` JSON-RPC 엔드포인트(Bearer).
- Modify `backend/main.py` — `/mcp` 라우터 등록.
- Modify `backend/test_aidoc.py` — MCP 핸드셰이크·도구·격리 테스트.
- Create `docs/aidoc-mcp-connection.md` — Claude Code/Codex 연결 가이드.

## Task 1: 권한 모듈 추출 (authz.py) + 라우터 리팩터
- authz: `need_scope/need_create/need_resource/filter_allowed`가 `Forbidden`(AidocError) 발생.
- aidoc_ai.py를 authz 사용으로 바꾸되 모든 검사를 `_mapped` 안에서 수행 → 기존 테스트 통과 유지.

## Task 2: MCP 도구 레지스트리 + dispatch (mcp_server.py)
- `TOOLS`: list/search/get/create/update/append/move/trash/restore/history/projects (11개), 각 name/description/inputSchema.
- `call_tool(settings, principal, name, arguments) -> dict|list`: authz 적용 후 service 호출.

## Task 3: `/mcp` JSON-RPC 라우터 (routers/mcp.py)
- initialize → protocolVersion echo + capabilities.tools + serverInfo.
- notifications/* (id 없음) → 202.
- tools/list → {tools}. tools/call → {content:[{type:text,text}], isError?}.
- Bearer 없으면 401. AidocError → isError 텍스트.

## Task 4: main 등록 + 연결 문서
- `/mcp` 라우터 등록(토큰 자체검증). 연결 가이드 작성.

## 이후(Phase 3/4)
- Phase 3: cloudflared `mcp.zanviq.dev` 라우팅 + Cloudflare Access.
- Phase 4: 노트 "AI 문서" 소스 편집 UI + 최소 관리 뷰.
