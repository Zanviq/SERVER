# AI 문서(aidoc) + MCP 완전 제거 — 실행 계획

작성일: 2026-08-16 · 대규모 개편 1단계

## 목적

AI 문서 시스템과 MCP 서버를 코드·UI·데이터·문서에서 완전히 제거한다.
나중에 새로 구축할 예정이므로, 현재 구현은 남기지 않는다. 설계 문서도 워킹트리에서
지우되 git 이력에는 남으므로 재구축 시 참고할 수 있다.

**제거 후 남는 것**: 파일·노트·캘린더·AI 비서(ReAct)·그래프(노트)·휴지통·동기화·터미널.

## 제거 대상

### 삭제 (파일 전체)

| 경로 | 규모 |
|---|---|
| `backend/aidoc/` | 18파일 2,291줄 |
| `backend/routers/aidoc_ai.py` · `aidoc_web.py` · `mcp.py` · `_aidoc_util.py` | 4파일 |
| `backend/test_aidoc.py` | 1,038줄 |
| `frontend/src/components/notes/AidocWorkspace.tsx` | 953줄 |
| `docs/aidoc-cloudflare-access.md` · `docs/aidoc-mcp-connection.md` · `docs/hermes-mcp-guide.md` | 3파일 |
| `docs/superpowers/specs/2026-07-12-ai-document-system-design.md` | |
| `docs/superpowers/specs/2026-07-13-aidoc-embeddings-graph-design.md` | |
| `docs/superpowers/specs/2026-07-13-hermes-memory-design.md` | |
| `docs/superpowers/plans/2026-07-12-ai-document-system-phase1.md` · `phase2.md` | |

### 수정 (참조 제거)

- `backend/main.py` — import 3개, startup 초기화 4줄, `include_router` 3줄
- `backend/config.py` — aidoc 설정 13개 필드(`DOCUMENT_ROOT`, `AIDOC_*`)
- `frontend/src/lib/api.ts` — `aidoc*` 메서드 17개, `Aidoc*` 타입 6개
- `frontend/src/pages/Notes.tsx` — `aiDocMode`·`aidocOpenId` 상태, lazy import, 소스 셀렉터 옵션, 렌더 분기, URL 파라미터 처리
- `frontend/src/pages/Graph.tsx` — `Source` 타입에서 `"aidoc"` 제거, `isAidoc` 분기 전부
- `.env.example` — 69~84행 aidoc 블록
- `.gitignore` — `aidoc/tokens.json`, `data/aidoc/`

### 서버 데이터

- `/mnt/server/aidoc` (8.4M), `/mnt/server/AI_documents` (5.5M) 삭제
- 롤백용 백업 `/mnt/hdd/server`는 그대로 둔다

### 외부 설정 (사용자 작업)

- Cloudflare 대시보드에서 `mcp.zanviq.dev` Public Hostname 제거
- 개발 PC의 `claude mcp remove aidoc` (Claude Code 등록 해제)

## 순서

1. 프런트 UI 제거 (Notes 소스 셀렉터 → Graph → api.ts → AidocWorkspace 삭제)
2. 백엔드 라우터 등록 해제 → 라우터 파일 삭제 → `aidoc/` 패키지 삭제
3. `config.py` 설정 필드 제거, `.env.example`·`.gitignore` 정리
4. 테스트 파일 삭제, 잔여 참조 grep으로 0건 확인
5. 빌드·테스트 통과 확인 후 커밋
6. 배포(push) 후 서버 데이터 삭제

프런트를 먼저 하는 이유: 백엔드를 먼저 지우면 프런트가 죽은 API를 호출하는 중간
상태가 생긴다. UI를 먼저 끊으면 각 단계가 항상 동작하는 상태를 유지한다.

## 검증

- `grep -rn "aidoc\|Aidoc\|/mcp"` → 0건 (git 이력·이 계획서 제외)
- `backend.test_smoke` 통과 (37개)
- `tsc --noEmit` exit 0, `vite build` 성공
- 배포 후: 노트·그래프·비서·캘린더 정상, `/api/aidoc/*`·`/mcp` 404

## 위험

- **`/mcp` 사용 중인 외부 클라이언트가 끊긴다** — 의도된 동작. 사용자가 재구축 예정.
- 노트 페이지의 소스 셀렉터에서 옵션 하나가 사라지므로, 기존 URL
  `/notes?aidoc=<id>`는 무시된다. 일반 노트 동작에는 영향 없음.
