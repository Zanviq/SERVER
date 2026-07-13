# Hermes 메모리 시스템 설계 (aidoc 확장)

**작성일:** 2026-07-13
**대상:** 여러 프로젝트의 Claude/Codex 세션이 지속 지식(사용자 의도 정정·실수·결정·기능 진화)을 기록하고 빠르게 회상하는 교차 세션 메모리 계층. aidoc(문서·버전·임베딩·의미검색) 위에 얹는다.

## 확정 결정 (사용자 승인)
- **업서트:** `feature_key` 지정 방식(같은 기능 = 같은 문서).
- **위치:** 전용 `hermes` 네임스페이스(`memory/global` + `memory/projects/{이름}`), 항상 사용 가능(env 등록 불필요).
- **global 접근:** 모든 인증 토큰 읽기+쓰기(사용자 성향/교훈은 사용자 전역).
- **브랜딩:** MCP를 "Hermes — AI 문서 관리 + 교차 세션 메모리"로 명시.

## 목표·비목표
- 목표: 작업 전 "이거 전에 어떻게 했지 / 사용자가 실제 원하는 건" 빠르고 정확한 회상 → 같은 지시 반복 감소.
- 비목표: 자동 캡처(MCP는 AI가 도구를 호출해야 함 — 프로토콜은 도구 설명+교차프로젝트 문서로 유도), 별도 메모리 DB(aidoc 재사용).

## 아키텍처 — aidoc 확장(재사용)
메모리 = `documents` 테이블의 문서(버전·임베딩·의미검색 공유), 단 `mem_type`으로 일반 문서와 구분.
```
memory/global/                 # scope=global (전 토큰 read+write)
memory/projects/{project}/     # scope=project (해당 프로젝트 권한 토큰만)
```
- **스키마 추가(하위호환, 기존 문서는 NULL):**
  - `documents.mem_type TEXT` — NULL=일반 문서, 아니면 메모리 유형(`preference|mistake|decision|feature`).
  - `documents.feature_key TEXT` — 업서트 키(scope 내 유일 지향).
  - 인덱스 `ix_documents_feature ON documents(project, feature_key)`.
- **scope 표현:** 메모리의 `project` 컬럼 = global이면 예약 sentinel `_global`, 프로젝트면 실제 프로젝트명. `_global`은 일반 문서 도구가 절대 쓰지 않음(등록 프로젝트/NULL만) → 메모리 전용.
- **격리(중요):** 일반 문서 조회(`list_docs`·`search`·`semantic_search`·`graph`·`export_folder`)는 `mem_type IS NULL` 필터 추가로 메모리 제외. 메모리 도구는 `mem_type IS NOT NULL`만.

## "같은 기능 = 같은 문서" (핵심)
`remember(scope, type, title, content, feature_key?, change_note?)`:
- feature_key 있고 (scope, feature_key)로 기존 메모리 발견 → **그 문서를 새 버전으로 업데이트**(content=현재 진실 전체, change_summary=change_note). 없으면 새 메모리 생성.
- **진화 표현 = 버전이력**: 문서 본문은 항상 "현재 최종본". 각 remember가 새 버전을 남기고 `change_note`("AI가 X를 만들었는데 사용자가 Y를 원해 Z로 바꿈")가 진화 로그가 됨. 마크다운 섹션 파싱 불필요 — aidoc 버전관리 그대로 활용.
- 최신 버전 = 최종 수정본. 같은 feature_key면 항상 같은 문서에서만 갱신.

## 빠른 회상
`recall(query, project?, limit=8, full=false)`:
- 메모리(scope=global + scope=project) 대상 의미검색(임베딩; 불가 시 FTS 폴백).
- **반환 상세도 선택(full 파라미터)** — AI가 상황에 맞게 고름:
  - `full=false`(기본): **간결 요약** `{id, feature_key, type, scope, title, summary(현재상태 앞 ~240자), score, updated_at, last_change}` — 빠른 스킴.
  - `full=true`: 요약 필드 + **`content`(본문 전체)** 포함 — 정확히 이전 방식 그대로 볼 때.
- 일반 문서 검색과 분리 — 메모리만.

## 도구 (MCP + REST)
- `remember` — 위 업서트. authz: global은 전 토큰, project는 need_resource.
- `recall` — 회상(위). authz: read; project 지정 시 need_resource, global은 항상 포함.
- `list_memories(scope?, type?)` — 목록(간결 메타).
- REST: `POST /mcp/api/memory`(remember) · `GET /mcp/api/memory/recall` · `GET /mcp/api/memory`(list). 웹(세션)도 동일 제공(읽기/관리 뷰는 이후).
- 도구 총 15~17개.

## 권한 (메모리 전용)
- global(scope=`_global`): 모든 인증 토큰 read+write.
- project 메모리: 토큰이 그 프로젝트 접근권(need_resource) 보유 시 read+write.
- recall(project=X): global + X 메모리(토큰이 X 접근 가능할 때). global은 항상 포함.

## 브랜딩 (MCP 정체성)
- `serverInfo.name = "hermes"`, version bump.
- initialize 응답에 `instructions` 추가: "Hermes MCP — 홈서버 AI 문서 관리 + 교차 세션 메모리. 작업 전 recall로 과거 결정·사용자 의도를 확인하고, 사용자 정정 후 remember로 기록하라." (AI에게 프로토콜을 상기시킴.)

## 데이터 흐름
```
작업 시작 → recall("이 기능 관련 과거 결정/사용자 성향") → 관련 메모리 요약 수신 → 반영해 작업
사용자 정정 발생 → remember(feature_key, 새 현재본, change_note="AI안 → 사용자 의도") → 같은 문서 새 버전
다음 세션/프로젝트 → recall → 최신 최종본 즉시 확인(반복 지시↓)
```

## 오류 처리·보안
- 메모리도 임베딩 best-effort(키 없으면 recall은 FTS 폴백). 경로는 `resolve_rel` 재검증.
- `_global` sentinel은 일반 문서 경로로 새지 않음(create/new_doc_dir는 등록 프로젝트/NULL만).
- 영구삭제 없음(휴지통만). 메모리 트래시도 일반 문서와 동일.

## 테스트 (주입 가짜 임베더)
- remember 업서트: 같은 feature_key → 같은 doc, 버전++·change_note 기록; 다른 key → 새 doc.
- recall 랭킹(가까운 메모리 상위) + 간결 반환 형태.
- 격리: 일반 list/search/graph에 메모리 미노출; 메모리 도구엔 일반 문서 미노출.
- 권한: 스코프 토큰이 global read+write 가능, 타 프로젝트 메모리 접근 불가.
- 기존 test_aidoc/test_smoke 회귀.

## 제작 순서 (단일 계획)
1. 스키마(mem_type/feature_key + memory 폴더) + 일반 조회에 `mem_type IS NULL` 필터.
2. 메모리 서비스(remember 업서트/recall/list) + 메모리 authz.
3. MCP 도구 + REST + serverInfo/instructions 브랜딩.
4. 테스트.

## 이후(별도, 사용자 프롬프트 단계 후)
- 이 프로젝트 설명 문서(타 세션 제공용) 생성.
- 이 프로젝트 정리 문서를 자기 프로젝트 폴더로 이관.
(둘 다 이번 설계 범위 아님 — 메모리 업그레이드 완료 후 진행.)
