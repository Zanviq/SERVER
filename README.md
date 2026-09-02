# TwoMES Home Server v2

라즈베리파이 5 기반 **멀티유저 개인 홈서버 워크스페이스**. 비밀번호 세션 로그인 위에
문서(마크다운/위키링크/그래프)·캘린더·할 일·시스템 모니터링·**ReAct AI 비서**를
하나의 FastAPI + React 앱으로 통합한다. Nextcloud 같은 기성 솔루션 없이 전부 직접 구현.

## 핵심 기능

- 🔐 **비밀번호 세션 로그인** — 가입은 신청만, 주인이 승인해야 로그인. 전 API 보호
- 👥 **멀티유저 저장소** — `users/<id>/` 로 완전 격리(공통 공간은 없다)
- 📝 **문서** — 마크다운 실시간 편집, `[[위키링크]]`·백링크·그래프 뷰, 표·형광펜·콜아웃·토글,
  이미지 붙여넣기와 크기 조절. 이미지·PDF·미디어도 같은 트리에서 열린다
- 📅 **캘린더** — FullCalendar 월/주/일, 내부 저장 + 선택적 **Google Calendar 동기화**
- ✅ **할 일** — 폴더식 카테고리 + 타임라인. 마감이 있으면 캘린더에도 보인다(구글과는 동기화하지 않는다)
- 🗑️ **휴지통** — 문서·일정·할 일 삭제는 모두 휴지통을 거쳐 되돌릴 수 있다
- 🤖 **AI 비서** — Gemini **ReAct** 에이전트. 스킬을 연속 실행하며 문서·일정·할 일을 처리. 사용자별 격리
- 🎨 **디자인** — 다크/라이트 토글, 좌측 사이드바, 반응형
- ⚙️ **설정/프로필** — 개인 `settings.json`(AI 말투·캘린더·문서·세션 시간 등)
- 📊 **시스템 모니터링** — CPU·RAM·온도·디스크 실시간(psutil, 주인 전용)

## 아키텍처

```
[ React + Tailwind SPA ]  로그인 게이트 · 좌측 사이드바 · 다크/라이트
        │ (세션 쿠키, /api)
[ FastAPI 게이트웨이 ]  전 라우터 require_session 보호
   ├─ auth        세션 발급/검증 (itsdangerous) + 로그인 시도 제한
   ├─ notes       문서 트리 — 사용자별 격리(safe_join)
   ├─ calendar    내부 events.json + 선택적 Google Calendar
   ├─ todo        할 일 + 카테고리
   ├─ trash       휴지통(문서·일정·할 일)
   ├─ settings    개인 settings.json
   ├─ admin       가입 승인·계정 관리 (주인 전용)
   ├─ system      psutil (주인 전용)
   └─ ai          ReAct 오케스트레이터 + 스킬 레지스트리 (google-genai)
        │
[ 저장소 STORAGE_ROOT ]  accounts.json · users/<id>/{data,calendar,todo,.trash}
```

## 빠른 시작 (로컬)

```bash
cp .env.example .env          # AUTH_USERS(최초 주인), SESSION_SECRET, GEMINI_API_KEY 등
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
python -m pytest backend/test_smoke.py -q   # 백엔드 전체
cd frontend && npm test                     # 표·살균·형광펜·위키링크
```

`python -m backend.test_smoke` 로도 돌릴 수 있다(같은 테스트를 전부 찾아 실행하고,
pytest 픽스처가 필요한 것은 건너뛴 개수를 알려 준다).

## 라즈베리파이 배포 (Docker)

```bash
git clone <repo> && cd twomes-server
cp .env.example .env           # 값 채우기
docker compose up -d --build           # backend + frontend(nginx)
docker compose --profile tunnel up -d  # + Cloudflare Tunnel(외부 접속)
```

저장소 마운트가 선행되어야 함 — 서버 데이터는 외장하드(NTFS) 위의 **ext4 loop 이미지**에 둔다:

```bash
# 최초 1회
sudo truncate -s 200G /mnt/HDD/server/server.img
sudo mkfs.ext4 -F -m 0 -L SERVERDATA /mnt/HDD/server/server.img
# /etc/fstab
# /mnt/HDD/server/server.img /mnt/server ext4 loop,noatime,nofail,x-systemd.requires=/mnt/HDD 0 0
sudo mount /mnt/server
```

NTFS에 데이터를 직접 두지 않는 이유: `os.replace` 원자성이 보장되지 않아
저장 도중 파일이 순간적으로 사라지고(실측 300회 중 38회), 그 사이 읽기가
빈 기본값을 돌려받아 노트·일정이 유실될 수 있다.

## 환경변수

| 변수 | 설명 |
|------|------|
| `AUTH_USERS` | **최초 주인 계정 부트스트랩 전용**(JSON 배열). 저장소가 비어 있을 때 한 번만 `accounts.json` 으로 옮겨진다. 그 뒤 계정 추가·변경은 여기가 아니라 가입 신청 + 관리 화면에서 한다 |
| `SESSION_SECRET` | 세션 토큰 서명키 (필수) |
| `SESSION_TTL_SECONDS` | 세션 유효시간 (기본 3600) |
| `STORAGE_ROOT` | 저장소 루트 (`/mnt/server` 또는 `./data`) |
| `CORS_ORIGINS` | 허용 오리진 (콤마, 와일드카드 불가) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | AI (기본 `gemini-2.5-flash`) |
| `GOOGLE_*` | Google Calendar 연동(선택) |
| `DEBUG` | 에러 상세 노출 (기본 false) |

## AI 비서 (ReAct)

스킬은 `backend/ai/skills/` 에 있고 레지스트리가 모은다 — 문서(목록·읽기·검색·쓰기·덧붙이기·
삭제·이름변경·이동·백링크), 일정(조회·생성·수정·삭제·빈시간찾기 + 일괄 생성/수정/삭제),
할 일(조회·생성·수정·완료·삭제 + 카테고리), 휴지통(목록·복원), 시스템 상태(주인 전용), `think`.
정확한 목록은 `default_registry()` 가 만드는 것이 기준이다.

한 번의 요청에서 여러 스킬을 연속 호출한다(예: 일정 조회 → 수정 → 문서에 정리).
모든 스킬은 로그인 사용자의 저장소로만 동작해 다른 사용자 데이터에 닿을 수 없다.
**나중에 스스로 실행하는 일(예약)은 하지 않는다** — 대화가 끝나면 아무것도 돌지 않는다.

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

## 배포

`main`에 push하면 Pi(셀프호스티드 러너)에서 자동으로 재빌드된다. 설정은
[docs/auto-deploy.md](docs/auto-deploy.md) 참고.
