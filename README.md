# TwoMES Home Server v2

라즈베리파이 5 기반 **멀티유저 개인 홈서버 워크스페이스**. 비밀번호 세션 로그인 위에
파일 관리·노트(마크다운/위키링크/그래프)·캘린더·시스템 모니터링·**ReAct AI 비서**를
하나의 FastAPI + React 앱으로 통합한다. Nextcloud 같은 기성 솔루션 없이 전부 직접 구현.

## 핵심 기능

- 🔐 **비밀번호 세션 로그인** — `.env` 계정, 1시간 세션 자동 만료, 남은시간 표시, 전 API 보호
- 👥 **멀티유저 저장소** — `common`(공통) + `users/<id>`(개인) 분리, 사용자 간 완전 격리
- 📁 **파일 관리** — 업로드(드래그앤드롭)·다운로드·폴더·이름변경·삭제, 공통/개인 스코프
- 📝 **노트** — 마크다운 실시간 편집, `[[위키링크]]` + 자동완성, 백링크, **그래프 뷰**(옵시디언식)
- 📅 **캘린더** — FullCalendar 월/주/일, 내부 저장 + 선택적 **Google Calendar 동기화**(env 토큰)
- 🤖 **AI 비서** — Gemini **ReAct** 에이전트. 스킬을 연속 실행하며 파일·노트·일정을 자동 처리·스케줄링. 사용자 스코프로 격리
- 🎨 **디자인** — 따뜻한 올리브그린 테마, **다크/라이트** 토글, 좌측 사이드바, 반응형
- ⚙️ **설정/프로필** — 개인 `settings.json`(테마·AI 말투·캘린더·노트 등), 프로필 페이지
- 📊 **시스템 모니터링** — CPU·RAM·온도·디스크 실시간(psutil)

## 아키텍처

```
[ React + Tailwind SPA ]  로그인 게이트 · 좌측 사이드바 · 다크/라이트
        │ (세션 쿠키, /api)
[ FastAPI 게이트웨이 ]  전 라우터 require_session 보호
   ├─ auth        세션 발급/검증 (itsdangerous, 1h)
   ├─ files/notes 스코프 해석(common|me) — 사용자 격리
   ├─ calendar    내부 events.json + 선택적 Google Calendar
   ├─ settings    개인 settings.json
   ├─ system      psutil
   └─ ai          ReAct 오케스트레이터 + 스킬 레지스트리 (google-genai)
        │
[ 저장소 STORAGE_ROOT ]  common/ · users/<id>/{files,notes,calendar,ai}
```

## 빠른 시작 (로컬)

```bash
cp .env.example .env          # AUTH_USERS, SESSION_SECRET, GEMINI_API_KEY 등 설정
python -m venv .venv && .venv\Scripts\activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload     # :8000

cd frontend && npm install
npm run dev                            # :5173 (vite 프록시 → :8000)
```

`.env` 최소 설정 예:
```
AUTH_USERS=[{"username":"me","password":"...","display_name":"나"}]
SESSION_SECRET=<긴 무작위 문자열>
STORAGE_ROOT=./data
CORS_ORIGINS=http://localhost:5173
GEMINI_API_KEY=<키>            # AI 사용 시
```

## 테스트

```bash
python -m backend.test_smoke   # 인증·스코프격리·파일·노트·그래프·캘린더·설정·AI ReAct
```

## 라즈베리파이 배포 (Docker)

```bash
git clone <repo> && cd twomes-server
cp .env.example .env           # 값 채우기
docker compose up -d --build           # backend + frontend(nginx)
docker compose --profile tunnel up -d  # + Cloudflare Tunnel(외부 접속)
```

HDD 마운트가 선행되어야 함: `sudo mount /dev/sda1 /mnt/hdd` (NTFS면 ntfs-3g).

## 환경변수

| 변수 | 설명 |
|------|------|
| `AUTH_USERS` | 계정 JSON 배열 (수동 설정, 필수) |
| `SESSION_SECRET` | 세션 토큰 서명키 (필수) |
| `SESSION_TTL_SECONDS` | 세션 유효시간 (기본 3600) |
| `STORAGE_ROOT` | 저장소 루트 (`/mnt/hdd` 또는 `./data`) |
| `CORS_ORIGINS` | 허용 오리진 (콤마, 와일드카드 불가) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | AI (기본 `gemini-2.5-flash`) |
| `GOOGLE_*` | Google Calendar 연동(선택) |
| `DEBUG` | 에러 상세 노출 (기본 false) |

## AI 비서 (ReAct)

스킬: `think`, `list/read/search_files`, `list/read/write_note`, `list/create_calendar_event`.
한 번의 요청에서 여러 스킬을 연속 호출하며(예: 일정 조회 → 생성 → 노트 읽기) 계획·실행·스케줄링한다.
모든 스킬은 로그인 사용자의 스코프(`common` | 본인 `me`)로만 동작하여 타 사용자 데이터에 접근할 수 없다.

## 구현 단계

1. ✅ 인증(세션 로그인) + 보안 하드닝
2. ✅ 멀티유저 저장소 스코프
3. ✅ 디자인 시스템(다크/라이트) + 사이드바 + 라우팅
4. ✅ 로그인/대시보드/파일 페이지
5. ✅ 노트 + 위키링크 + 백링크 + 그래프
6. ✅ 캘린더(내부 + Google)
7. ✅ 설정 + 프로필
8. ✅ AI ReAct 오케스트레이터 + 스킬 + 스케줄링
9. ✅ 최적화(코드분할) + 리팩토링 + 보고서

자세한 작업 내역은 [docs/REPORT.md](docs/REPORT.md), 계획은
[docs/superpowers/plans/2026-07-01-twomes-v2.md](docs/superpowers/plans/2026-07-01-twomes-v2.md) 참고.
