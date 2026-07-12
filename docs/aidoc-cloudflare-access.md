# AI 문서 MCP — Cloudflare 라우팅 + Access 보호 (Phase 3)

`mcp.zanviq.dev`를 홈서버의 `/mcp`(및 `/mcp/api/*`)로 연결하고, Cloudflare Access로 한 번 더
보호하는 절차입니다. cloudflared는 **토큰형 터널**이므로 라우트는 config.yml이 아니라
대시보드의 **Public Hostname(게시된 애플리케이션 라우트)** 에서 관리합니다.

> 요약: (1) 터널에 `mcp.zanviq.dev` 공개 호스트네임 추가 → 내부 backend로 라우팅,
> (2) Access 애플리케이션 + 서비스 토큰 정책 생성, (3) 서버에 `AIDOC_ACCESS_*` 설정,
> (4) 클라이언트(Claude Code/Codex)에 서비스 토큰 헤더 추가.

## 1. 터널에 공개 호스트네임 추가 (라우팅)

Cloudflare Zero Trust 대시보드 → **Networks → Tunnels → (해당 터널) → Public Hostname → Add a public hostname**

- **Subdomain**: `mcp`
- **Domain**: `zanviq.dev`
- **Path**: 비움 (전체) — 백엔드가 `/mcp`, `/mcp/api/*`를 처리
- **Service**: `HTTP` → `http://<backend 컨테이너/호스트>:<포트>`
  - 같은 compose 네트워크면 `http://server-backend:8000` 형태(백엔드 서비스명/포트에 맞춤).
  - 단일 호스트면 `http://localhost:8000`.

저장하면 `mcp.zanviq.dev` CNAME이 자동 생성됩니다. `server.zanviq.dev`는 그대로 유지됩니다.

DNS만 붙은 상태에서 동작 확인:

```bash
curl -s https://mcp.zanviq.dev/mcp -H "Authorization: Bearer <AIDOC_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'
```

## 2. Cloudflare Access 애플리케이션 + 서비스 토큰

기계(자동화) 접근이므로 **Service Token**을 사용합니다.

1. **Zero Trust → Access → Service Auth → Service Tokens → Create Service Token**
   - 이름 예: `mcp-claude`. 생성 시 **Client ID**와 **Client Secret**을 1회만 보여줍니다 → 안전 보관.
2. **Zero Trust → Access → Applications → Add an application → Self-hosted**
   - **Application domain**: `mcp.zanviq.dev` (경로 비움).
   - **Identity providers**: 기계 접근만이면 IdP 없이 진행 가능.
   - **Policies**: `Action = Service Auth`, `Include = Service Token → (위에서 만든 토큰)`.
     사람 접근도 필요하면 별도 정책(이메일 등)을 추가.
3. 애플리케이션 개요에서 **Application Audience (AUD) Tag**를 복사 → 서버 설정에 사용.
   - 팀 도메인은 `https://<팀명>.cloudflareaccess.com` (Zero Trust → Settings → Custom Pages/Team domain).

## 3. 서버에 오리진 검증 설정(선택이지만 권장)

Access를 켜도 오리진이 헤더를 검증하지 않으면, 터널을 우회한 요청은 막지 못합니다.
백엔드가 `Cf-Access-Jwt-Assertion`을 **직접 검증**하도록 `.env`에 설정하세요.

```env
AIDOC_ACCESS_TEAM_DOMAIN=<팀명>.cloudflareaccess.com
AIDOC_ACCESS_AUD=<Application Audience(AUD) Tag>
```

- 둘 다 설정되면 `/mcp`·`/mcp/api/*`는 **유효한 Access JWT + 유효한 Bearer 토큰**을 모두 요구합니다.
- 비우면(기본) Bearer 토큰만 사용 — 기존 동작 유지.
- 검증 내용: 서명(팀 도메인 `/cdn-cgi/access/certs`의 공개 인증서, RS256), `aud`(AUD 태그 일치),
  `iss`(`https://<팀도메인>` 일치), `exp`(만료). 인증서는 1시간 캐시.
- 새 pip 의존성 없음(google-auth 사용). 설정 변경 후 백엔드 재기동.

## 4. 클라이언트에 서비스 토큰 헤더 추가

Cloudflare는 서비스 토큰 헤더가 있는 요청을 통과시키고, 오리진에는 `Cf-Access-Jwt-Assertion`을
주입합니다. 따라서 클라이언트는 **Bearer(aidoc 토큰) + 서비스 토큰 2개 헤더**를 함께 보냅니다.

Claude Code:

```bash
claude mcp add --transport http aidoc https://mcp.zanviq.dev/mcp \
  --header "Authorization: Bearer <AIDOC_TOKEN>" \
  --header "CF-Access-Client-Id: <SERVICE_TOKEN_CLIENT_ID>" \
  --header "CF-Access-Client-Secret: <SERVICE_TOKEN_CLIENT_SECRET>"
```

Codex(`~/.codex/config.toml`):

```toml
[mcp_servers.aidoc]
url = "https://mcp.zanviq.dev/mcp"
http_headers = { Authorization = "Bearer <AIDOC_TOKEN>", "CF-Access-Client-Id" = "<ID>", "CF-Access-Client-Secret" = "<SECRET>" }
```

curl 확인:

```bash
curl -s https://mcp.zanviq.dev/mcp \
  -H "Authorization: Bearer <AIDOC_TOKEN>" \
  -H "CF-Access-Client-Id: <ID>" \
  -H "CF-Access-Client-Secret: <SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## 문제 해결

- **403 "Cloudflare Access 검증 실패"**: `AIDOC_ACCESS_AUD`가 애플리케이션 AUD와 다르거나,
  클라이언트가 서비스 토큰 헤더를 안 보냈거나, 팀 도메인이 틀림. AUD/팀도메인 재확인.
- **Cloudflare 로그인 페이지(HTML)가 돌아옴**: Access 정책이 Service Auth가 아니라 IdP 로그인으로만
  설정됨 → 정책에 Service Token include 추가.
- **오리진 401**: Access는 통과했으나 aidoc Bearer 토큰이 없거나 무효 → `AIDOC_TOKENS_FILE` 확인.
- Phase 1~2 참고: `docs/aidoc-mcp-connection.md`(토큰 발급/도구 목록).
