# TwoEMS v2 작업 보고서

작성일: 2026-07-01 · 작성: Claude (Opus 4.8)

## 1. 개요

기존 단일 페이지 "파일·시스템·AI 대시보드"(v1)를, 비밀번호 로그인 기반의
**멀티유저 개인 홈서버 워크스페이스**(v2)로 대대적으로 개편했다. Plant-Counselor의
디자인·ReAct 아키텍처와 CalenMate의 캘린더를 레퍼런스로 분석·반영했다.

작업은 9단계 계획(docs/superpowers/plans/2026-07-01-twoems-v2.md)에 따라
**기능 하나당 커밋**하며 진행했고, 단계마다 자동 테스트 + 실제 브라우저 검증을 거쳤다.

## 2. 단계별 작업 내역 (무엇을 / 왜)

### Phase 1 — 인증 + 보안 (`feat(auth)`)
- **무엇**: `.env`의 `AUTH_USERS`(JSON) 계정으로 로그인, itsdangerous 서명 토큰(1시간 TTL),
  `require_session` 의존성으로 전 API 보호, 로그인/로그아웃/세션조회 엔드포인트.
- **왜**: 외부 접속(Cloudflare Tunnel)을 전제로 하므로 인증이 최우선. 자동 보안리뷰가
  지적한 5건(인증 누락·CORS 와일드카드+credentials·에러 경로노출·AI 민감전송)도 함께 해결.
  CORS는 명시 오리진만, 에러 상세는 `DEBUG=false`면 일반 메시지로 숨김.

### Phase 2 — 멀티유저 저장소 (`feat(storage)`)
- **무엇**: `STORAGE_ROOT/common`(공통)과 `STORAGE_ROOT/users/<id>`(개인) 분리.
  `storage.resolve(scope, path, user)`는 개인 스코프를 항상 **세션 사용자**로만 해석.
- **왜**: "공통 공간 + 개인 폴더" 요구. 한 사용자가 (UI로도 AI로도) 다른 사용자의
  폴더에 접근하지 못하도록 경로 해석 단계에서 격리. 테스트로 두 사용자 격리 검증.

### Phase 3·4 — 디자인 시스템 + 셸 + 핵심 페이지 (`feat(ui)`)
- **무엇**: Plant-Counselor 팔레트(올리브그린/크림)를 CSS 변수(RGB 트리플렛)로 토큰화,
  `data-theme` 다크/라이트(플래시 방지), 64px 아이콘 사이드바, react-router, AuthGate,
  로그인·대시보드·파일(공통/개인 토글) 페이지.
- **왜**: 단일 페이지 → 사이드바 기반 멀티 페이지 앱으로 전환. 토큰을 RGB 트리플렛으로 둔 것은
  Tailwind opacity 수정자(`bg-accent/10`)를 CSS 변수와 함께 쓰기 위함.

### Phase 5 — 노트 + 그래프 (`feat(notes)`)
- **무엇**: 마크다운 노트 CRUD, `[[위키링크]]` 파싱/자동완성, 백링크 역색인,
  force-directed 그래프 뷰. 3컬럼(목록·에디터·프리뷰+백링크), 디바운스 자동저장.
- **왜**: 옵시디언식 지식관리 요구. 백엔드에서 위키링크/그래프를 계산하고
  프론트는 react-force-graph로 시각화.

### Phase 6 — 캘린더 (`feat(calendar)`)
- **무엇**: FullCalendar 월/주/일(한국어), 이벤트 CRUD(개인 events.json), 11색.
  `GOOGLE_*` 설정 시 서비스계정/refresh token으로 Google Calendar 동기화, 없으면 내부.
- **왜**: CalenMate식 캘린더. interactive 로그인 없이 env 토큰으로 연동 가능하게 하되,
  미설정/오류 시 내부 저장으로 graceful 폴백.

### Phase 7 — 설정 + 프로필 (`feat(settings)`)
- **무엇**: 개인 `settings.json`(기본값 깊은 병합), 탭(계정/AI/캘린더/노트/테마/정보),
  프로필 페이지(세션 남은시간·로그아웃).
- **왜**: 레퍼런스의 상세 설정 요구. 설정을 개인 폴더에 JSON으로 저장(요청사항).

### Phase 8 — AI ReAct (`feat(ai)`)
- **무엇**: Plant-Counselor식 스킬 레지스트리 + ReAct 오케스트레이터. 스킬(think/파일/노트/캘린더)을
  연속 호출하며 observation을 피드백해 추론. SSE 스트리밍으로 스텝을 실시간 표시.
  스케줄링은 `list_calendar_events`(충돌 확인) → `create_calendar_event`로 수행.
- **왜**: "스킬을 연속 사용하고 스케줄을 짜는 ReAct" 요구. 모든 스킬은 SkillContext의
  세션 사용자 스코프로만 동작 → AI를 통한 타 사용자 접근 차단.
- **중요 수정**: 테스트 중 `gemini-2.0-flash`가 API에서 폐기됨을 발견. 폐기된
  `google-generativeai` → **`google-genai`(신 SDK)**로 마이그레이션하고 기본 모델을
  `gemini-2.5-flash`로 변경. 실제 Gemini로 "일정 잡고 노트 알려줘" → 일정조회→생성→노트읽기
  체이닝을 E2E 검증.

### Phase 9 — 최적화 + 리팩토링 (`perf+docs`)
- **무엇**: 무거운 라우트(캘린더·그래프·노트·AI·설정)를 `React.lazy`로 코드 분할 →
  초기 번들 **838KB → 217KB**. 폐기된 SDK 잔재 정리. README v2 + 본 보고서.
- **왜**: 라즈베리파이/모바일에서의 초기 로딩 성능. 무거운 라이브러리(FullCalendar,
  force-graph, react-markdown)는 해당 페이지 진입 시에만 로드.

## 3. 보안 설계 요약

- 전 API는 `require_session` 통과 필수(로그인/health 제외). 세션은 서명+TTL로 위조/만료 방지.
- 저장소·노트·캘린더·AI 스킬 모두 경로/스코프를 세션 사용자로만 해석 → 수평 권한 상승 차단.
- CORS 명시 오리진 + 자격증명 쿠키(HttpOnly). 에러 상세는 DEBUG 게이트. AI 검색 민감 키워드 필터.

## 4. 테스트

`backend/test_smoke.py` — 인증(미인증 차단/로그인/만료/로그아웃), 스코프 격리,
파일 라이프사이클·금지문자 새니타이즈, 노트 위키링크/백링크/그래프, 캘린더 CRUD,
설정 병합, **AI ReAct 스킬 연속실행(가짜 LLM)**. 전부 통과.
프론트는 각 단계마다 실제 브라우저(Playwright)로 라이트/다크·반응형·기능 동작 확인.

## 5. 남은 개선 여지 (후속 제안)

- 노트/파일 첨부 이미지 미리보기, 전문 검색(내용 인덱싱).
- AI 대화 히스토리 영속화 + 멀티턴 컨텍스트, 변경 작업 확인 UI(설정값 연동).
- 캘린더 반복 일정(rrule), 알림.
- 세션 갱신(슬라이딩 만료) 옵션, 다중 기기 로그아웃.
- 테스트를 pytest 구조로 분리, CI.

## 6. 커밋 로그 (주요)

```
feat(auth)      .env 세션 로그인(1h) + 전역 보호 + 보안 하드닝
feat(storage)   공통/개인 스코프 분리 + 경로 격리
feat(ui)        디자인 토큰(다크/라이트)+사이드바+라우팅+로그인/대시보드/파일
feat(notes)     마크다운+위키링크+백링크+그래프 뷰
feat(calendar)  내부 캘린더 + 선택적 Google 동기화
feat(settings)  개인 설정(JSON) + 프로필
feat(ai)        ReAct 오케스트레이터 + 스킬 레지스트리 + 스케줄링
perf+docs       코드분할 최적화 + 리팩토링 + 보고서
```
