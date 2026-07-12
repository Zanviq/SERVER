# AI 문서 MCP 서버 연결 가이드

SERVER 백엔드는 `/mcp` 경로에서 **MCP Streamable-HTTP(JSON-RPC 2.0)** 서버를 제공합니다.
Claude Code·Codex가 이 서버에 연결하면 홈서버를 중앙 문서 저장소로 사용할 수 있습니다.

- 엔드포인트: `POST https://<host>/mcp` (Phase 3에서 `https://mcp.zanviq.dev/mcp` 예정)
- 인증: `Authorization: Bearer <토큰>` (문서 REST `/mcp/api/*`와 동일 토큰)
- 도구 11개: `list_documents`, `search_documents`, `get_document`, `create_document`,
  `update_document`, `append_document`, `move_document`, `trash_document`,
  `restore_document`, `get_document_history`, `list_projects`

## 1. 토큰 발급 (서버에서)

토큰 원문은 발급 시 1회만 보관하고, 서버에는 sha256만 저장합니다.

```bash
python -c "import secrets,hashlib; t=secrets.token_urlsafe(32); print('TOKEN=',t); print('SHA256=',hashlib.sha256(t.encode()).hexdigest())"
```

`AIDOC_TOKENS_FILE`(예: `/mnt/hdd/server/aidoc/tokens.json`)에 항목 추가:

```json
[
  {
    "name": "claude-editor",
    "token_sha256": "<위 SHA256>",
    "actor": "claude-code",
    "scopes": ["documents:read","documents:create","documents:update","documents:append","documents:move","documents:trash"],
    "allowed_projects": ["*"]
  },
  {
    "name": "codex-orchestra",
    "token_sha256": "<다른 SHA256>",
    "actor": "codex",
    "scopes": ["documents:read","documents:create","documents:update"],
    "allowed_projects": ["orchestra-room"]
  }
]
```

- `allowed_projects`: `"*"`는 전체. 특정 프로젝트만 주면 그 프로젝트 문서에만 접근(교차 프로젝트 차단).
- `inbox`(프로젝트 미지정) 문서는 `"*"` 토큰만 읽기/수정 가능(생성은 스코프 토큰도 허용).
- 파일 수정 후 서버 재시작 없이 반영되지만, 캐시 갱신이 필요하면 백엔드를 재기동하세요.

## 2. Claude Code에 등록

```bash
claude mcp add --transport http aidoc https://<host>/mcp \
  --header "Authorization: Bearer <TOKEN>"
```

또는 `~/.claude.json`(또는 프로젝트 `.mcp.json`)에:

```json
{
  "mcpServers": {
    "aidoc": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

## 3. Codex에 등록

`~/.codex/config.toml`:

```toml
[mcp_servers.aidoc]
url = "https://<host>/mcp"
http_headers = { Authorization = "Bearer <TOKEN>" }
```

## 4. 동작 확인 (curl)

```bash
# initialize
curl -s https://<host>/mcp -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'

# tools/list
curl -s https://<host>/mcp -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 문서 생성
curl -s https://<host>/mcp -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_document","arguments":{"title":"메모","content":"내용","project":"nodi"}}}'
```

## 프로토콜 메모

- 스테이트리스: `Mcp-Session-Id`를 요구하지 않습니다. 각 POST가 독립적으로 처리됩니다.
- 응답은 단일 JSON(`application/json`)입니다(SSE 스트리밍 미사용).
- 지원 메서드: `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/*`(알림은 202).
- `tools/call` 결과는 `content:[{type:"text", text:<JSON 문자열>}]` 형태이며, 오류 시 `isError:true`와
  `{"error":CODE,"message":...}` 텍스트가 들어갑니다(버전 충돌 시 `DOCUMENT_VERSION_CONFLICT`).

## 이후 단계 (Phase 3)

- cloudflared 대시보드에서 `mcp.zanviq.dev` → 내부 backend(`/mcp`) 라우팅 추가.
- Cloudflare Access(서비스 토큰/정책)로 한 번 더 보호(선택).
