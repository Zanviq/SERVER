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

## 4-1. 검토 및 하드닝 패스 (코드 재점검)

독립 리뷰(백엔드 보안/정확성, 프론트 UI/UX/데드코드) 후 다음을 수정했다.

**보안** — AI 스킬(read_file/read_note/search)에 민감 키워드 가드 복원(외부 유출 차단),
`.env`를 AI 읽기 확장자에서 제외, 세션 쿠키 `secure`를 `COOKIE_SECURE`로 환경 제어.
**동시성** — calendar/settings JSON 쓰기를 원자적(`os.replace`)+경로별 락으로(`json_store.py`),
lost-update·파일 손상 방지.
**정확성** — AI `max_steps`를 개인 설정과 연동, `/chat` 멀티턴 대화 history 지원,
proto 인자 순수 변환, 디스크 폴백 크로스플랫폼화, 파일목록 TOCTOU 가드.
**UI/UX(가장 큰 문제: 설정이 적용되지 않던 것)** — 설정 스토어를 만들어 타이머·캘린더 뷰/주시작/색·
노트 스코프/자동저장·파일 스코프/삭제확인이 실제로 반영되게 연결. 파일 클릭 미리보기 모달 복원,
그래프 노드 클릭→노트 이동, 테마 토글 시 그래프 색상 갱신, 모바일 하단 탭바+노트 세로 스택,
prompt/confirm→커스텀 모달, 세션 만료 토스트, 캘린더 타임존 일관화.
**성능/접근성** — 탭 숨김 시 시스템 폴링 정지, source 1회 조회, 토스트 aria-live,
모달 role/포커스, 사이드바·버튼 aria-label.
**데드코드 제거** — Sparkline, rel_of, is_mutating/confirm_mutations 등.

## 4-2. 기능 확장 패스 (AI 스킬·검색·반복일정)

- **AI 스킬 23종으로 확장** — 도메인 모듈(files/notes/calendar/system/think)로 분리.
  파일(목록·읽기·검색·쓰기·덧붙이기·삭제·폴더생성·이동), 노트(목록·읽기·작성·덧붙이기·
  삭제·이름변경·검색·백링크), 일정(조회·생성·수정·삭제·빈시간찾기), 시스템 상태.
  이제 비서가 생성뿐 아니라 수정·삭제·검색·스케줄링까지 세밀하게 수행.
  (실검증: "빈 시간 찾아 회의 잡아줘" → find_free_slots→create 체이닝)
- **노트 전문 검색** — 제목·내용 인덱스 검색, 스니펫과 함께 Notes 페이지에서 제공.
- **캘린더 반복 일정 + 알림** — daily/weekly/monthly/yearly(+간격·종료일), 조회 시
  인스턴스 확장, 단일 발생 삭제(예외), 시작 N분 전 알림(브라우저 Notification/토스트).
- **AI 멀티턴 대화** — 이전 대화 컨텍스트 전달로 "방금 말한 것 중 두 번째" 같은 참조 이해.
- **대시보드 위젯**(최근 노트·다가오는 일정), **전역 에러 바운더리**.

## 5. 남은 개선 여지 (후속 제안)

- 비밀번호 해시화(현재는 .env 평문 — 내부 홈서버 전제), 다중 기기 로그아웃.
- AI 대화 히스토리 영속화(현재는 클라이언트 메모리 기반 멀티턴), 변경 작업 확인 UI.
- 노트 전문 검색(내용 인덱싱), 백링크 단일 패스 캐싱.
- 캘린더 반복 일정(rrule), 알림, 세션 슬라이딩 만료 옵션.
- 모달 완전 포커스 트랩, 폼 라벨 연결 등 a11y 추가 보강.
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
