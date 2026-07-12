# AI 문서 관리 시스템 설계 (SERVER 통합)

**작성일:** 2026-07-12
**대상:** Claude Code·Codex가 홈서버를 중앙 문서 저장소로 쓰도록 하는 안전한 문서 API/MCP 계층

## 확정 결정 (사용자 승인)
- **배치:** 기존 `server-backend`(FastAPI) 앱에 문서 모듈 통합 (별도 컨테이너 X)
- **진행:** 단계별(Phase). 각 단계 = 설계→구현→검토
- **저장 위치:** `/mnt/hdd/server/AI_documents` (이미 마운트된 `/mnt/hdd/server` 하위 → 볼륨 추가 불필요)
- **웹 UI:** 최소 관리 범위 (목록/읽기/이력/복원/휴지통/감사뷰 + AI 배지)
- **토큰/권한:** 설정 파일(JSON, git 제외). scope·허용 프로젝트 포함
- **Cloudflare Access:** MVP는 내부 Bearer 토큰만. Access는 이후 레이어(대시보드 설정은 사용자)
- **AI 연결:** 원격 MCP(HTTP) + REST 병행. MCP는 REST 위의 얇은 어댑터
- **저장소 관계:** 기존 notes/files와 완전 별개. 단, **기존 노트 페이지에서 "AI 문서" 소스로 열람·편집 가능**(저장은 문서 API 경유 → 버전·감사·잠금 적용)
- **DB:** stdlib `sqlite3` + FTS5 (새 의존성 없음). SQLAlchemy/SQLModel 미사용(기존 프로젝트 무-ORM 스타일 유지)

## 아키텍처
```
웹 브라우저(server.zanviq.dev, 세션쿠키) ── /api/aidoc/*  ┐
                                                          ├─ aidoc 서비스 레이어 ── SQLite(메타/버전/감사/FTS5)
Claude Code/Codex(mcp.zanviq.dev, Bearer) ─ /mcp/api/*, /mcp ┘        └─ /mnt/hdd/server/AI_documents (Markdown + .history)
```
- 두 출입구(세션/토큰)는 동일한 `aidoc` 서비스 레이어를 호출. 인증만 다름.
- cloudflared(토큰형 터널)는 대시보드에서 `mcp.zanviq.dev` → 내부(backend) 라우팅(Phase 3). `server.zanviq.dev`는 그대로 유지.

## 저장 구조
```
AI_documents/
├─ inbox/                 # 프로젝트 미지정 draft
├─ projects/{allowed}/    # 등록된 프로젝트만 (설정)
├─ knowledge/{programming,ai,university,research}/
├─ templates/
├─ archive/
├─ trash/                 # 삭제 = 이동 (원경로 메타 기록)
└─ .history/{doc_id}/0001.md ...   # 수정 전 이전본 백업
```
- AI가 최상위 폴더를 새로 만들 수 없음. 새 문서는 `inbox/` 또는 `projects/{allowed}/`에만.
- `storage_path`는 AI_documents 기준 상대경로만 DB에 저장(절대경로 금지).

## 데이터 모델 (SQLite, stdlib)
- `documents(id TEXT PK, title, project, category, tags(JSON), status, storage_path, version INT, content_hash, created_by, updated_by, created_at, updated_at)`
- `document_versions(doc_id, version, actor, change_summary, prev_hash, new_hash, created_at, history_path)`  — (doc_id, version) PK
- `audit_logs(id, actor, action, doc_id, project, from_version, to_version, change_summary, ok, detail, timestamp)`
- `documents_fts` (FTS5: title, content, tags, project, category) — 본문은 저장 시 색인 갱신
- `id`는 `doc_` + 26자 base32(ULID 유사, 시간정렬). 파일명은 서버가 안전 생성(제목 그대로 X).

## 인증/권한 (Phase 1)
- 설정 파일 `aidoc_tokens.json`(git 제외, `.env`의 `AIDOC_TOKENS_FILE`로 경로 지정):
  ```json
  [{"name":"claude-editor","token_sha256":"...","actor":"claude-code",
    "scopes":["documents:read","documents:create","documents:update","documents:append","documents:move","documents:trash"],
    "allowed_projects":["*"]},
   {"name":"codex-orchestra-room","token_sha256":"...","actor":"codex",
    "scopes":["documents:read","documents:create","documents:update"],
    "allowed_projects":["orchestra-room"]}]
  ```
- Bearer 토큰 → sha256 비교(상수시간) → scope·allowed_projects 검사. `*`는 전체.
- 웹(세션): 기존 `require_session`. admin은 전체 권한. (영구삭제는 웹 admin만)
- 등록 프로젝트 목록: 설정(`AIDOC_PROJECTS`, 기본 `orchestra-room,conversation-tree-ai,nodi,home-server`).

## REST API (Phase 1)
서비스 레이어는 공유, 라우터 2벌(세션 prefix `/api/aidoc`, 토큰 prefix `/mcp/api`):
```
GET    /documents?project=&category=&tag=&status=&created_by=&updated_by=
POST   /documents                         # {title,project,category,tags,status,content,duplicate_check_query?}
GET    /documents/{id}                     # → {..., version, content}
PUT    /documents/{id}                     # {expected_version,title?,content?,change_summary} → 409 on version mismatch
POST   /documents/{id}/append              # {content, change_summary}
POST   /documents/{id}/move                # {target_project|target_folder}
POST   /documents/{id}/trash               # 휴지통 이동(원경로 기록)
POST   /documents/{id}/restore             # 특정 버전으로 복원(새 버전 생성) / 휴지통 복원
GET    /documents/{id}/history
GET    /documents/search?q=               # FTS5 (title/content/tags/project/category)
GET    /projects
GET    /audit-logs
```
- 409 응답: `{"error":"DOCUMENT_VERSION_CONFLICT","expected_version":4,"current_version":5}`
- 검색 결과: id/title/project/category/tags/status/version/updated_at/updated_by/snippet.

## 원자적 저장 + 버전
1. 임시파일에 새 내용 쓰기 → fsync
2. 기존 본문을 `.history/{id}/{version:04}.md` 로 백업 + `document_versions` 기록
3. 임시파일 → 실제 파일 원자적 교체(os.replace)
4. `documents.version++`, content_hash, updated_* 갱신, FTS 갱신
5. 감사 로그 기록
- 중간 실패 시 가능한 범위 롤백. 이력은 삭제/덮어쓰기 금지.

## 보안 (계획서 19번 적용)
경로 외부입력 금지(id만), `DOCUMENT_ROOT` 하위 재검증, 심볼릭 차단, 본문 크기 제한(`AIDOC_MAX_BYTES`), Markdown만(초기), 영구삭제 AI 미제공, 모든 수정 전 버전 검증, 전 작업 감사, 비밀은 env, HDD 읽기전용/부재/용량부족 시 안전 오류, DB-파일 불일치 복구 점검.

## 노트 UI 통합 (Phase 4)
- 노트 소스 선택에 **"AI 문서"**(`base=aidoc`) 추가 → `/api/aidoc/documents`로 목록/열람.
- 편집 저장은 문서 API(PUT, `expected_version`) 경유 → 409 시 사용자에게 최신본 재읽기 안내.
- AI 생성/수정 배지, 버전 표시, 이력/복원/휴지통/감사 뷰.

## 단계별 범위
- **Phase 1 (MVP 코어, 먼저 제작):** SQLite/FTS5 스키마 · 저장 서비스(안전경로/원자저장/버전/이력/복원/휴지통) · REST(세션+토큰 라우터) · 설정파일 토큰·scope·프로젝트 · 감사 로그 · 스모크 테스트
- **Phase 2:** MCP 서버(HTTP, REST 어댑터, 11개 도구) + Claude Code/Codex 연결 문서
- **Phase 3:** cloudflared `mcp.zanviq.dev` 라우팅 + Cloudflare Access 가이드 + (선택) Access 헤더 검증
- **Phase 4:** 웹 UI(노트 "AI 문서" 소스 편집 + 최소 관리 뷰)

## MVP 제외 (계획서 20번)
PDF/Word 수정, OCR, 임베딩/벡터DB, 자동 병합, AI 영구삭제, AI_documents 외부 접근.

## 환경변수(.env)
```
DOCUMENT_ROOT=/mnt/hdd/server/AI_documents
AIDOC_DB_PATH=/mnt/hdd/server/aidoc/documents.db
AIDOC_TOKENS_FILE=/mnt/hdd/server/aidoc/tokens.json
AIDOC_PROJECTS=orchestra-room,conversation-tree-ai,nodi,home-server
AIDOC_MAX_BYTES=1048576
```
(로컬 개발은 ./data 하위 경로. 실제 값은 배포 시 설정.)
