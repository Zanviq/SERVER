# TwoEMS Home Server

라즈베리파이 5 기반 자작 홈서버. 파일 관리·시스템 모니터링·AI(Gemini)를
**FastAPI 단일 API**로 통합하고, **React+Tailwind 커스텀 대시보드**로 사용한다.
Nextcloud 같은 기성 솔루션을 쓰지 않고 전부 직접 구현한다.

## 아키텍처

```
[ React + Tailwind 통합 대시보드 ]
              ↓ API 호출
[ FastAPI 백엔드 (단일 API) ]
       ↓         ↓          ↓
  파일시스템    Gemini    시스템정보
  (/mnt/hdd)   (AI)      (psutil)
```

## 진행 단계

- [x] **1단계** FastAPI 골격 + 파일 관리 API + HDD 연동 + 시스템 모니터링
- [x] **2단계** React + Tailwind 통합 대시보드 ("Control Deck" 커스텀 디자인)
- [x] **3단계** Gemini AI 기능 (요약·자연어 검색·문서 Q&A, 민감문서 가드)
- [x] **4단계** Docker Compose (backend + frontend + Cloudflare Tunnel)

## API 엔드포인트 (1단계 구현됨)

| Method | Path | 설명 |
|--------|------|------|
| GET    | `/api/health`            | 헬스 체크 + 저장소 상태 |
| GET    | `/api/system`            | CPU·RAM·온도·디스크·업타임 |
| GET    | `/api/files/list?path=`  | 디렉토리 목록 |
| POST   | `/api/files/upload?path=`| 파일 업로드 (multipart) |
| GET    | `/api/files/download?path=` | 파일 다운로드 |
| POST   | `/api/files/mkdir`       | 폴더 생성 `{path}` |
| POST   | `/api/files/rename`      | 이동/이름변경 `{src,dst}` |
| DELETE | `/api/files/delete?path=`| 파일/폴더 삭제 |
| POST   | `/api/ai/summarize`      | 문서 요약 `{path}` |
| POST   | `/api/ai/chat`           | 문서 기반 Q&A `{path,question}` |
| POST   | `/api/ai/search`         | 자연어 파일 검색 `{query}` |

모든 `path`는 **저장소 루트(`STORAGE_ROOT`) 기준 상대경로**다.
`..` 및 루트 이탈은 서버에서 차단한다. AI 엔드포인트는 파일명/경로에
민감 키워드(비밀·계좌·password 등)가 있으면 외부 전송을 403으로 막는다.

## 프론트엔드 — "Control Deck" 대시보드

React + TypeScript + Tailwind + Vite. 다크 "관제 콘솔" 디자인:
실시간 SVG 게이지·스파크라인(시스템), 드래그앤드롭 파일 탐색기,
문서 미리보기 + AI 요약/Q&A 모달, 자연어 AI 검색 패널.

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 (vite 프록시로 /api -> :8000)
npm run build        # 타입체크 + 프로덕션 빌드 (dist/)
```

백엔드를 먼저 `uvicorn backend.main:app --reload`로 띄운 뒤 `npm run dev`.

## 로컬 개발 (Windows / PC)

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r backend/requirements.txt

# 저장소를 로컬 폴더로 지정 (HDD 대신)
set STORAGE_ROOT=./data            # PowerShell: $env:STORAGE_ROOT="./data"

uvicorn backend.main:app --reload
# http://localhost:8000/docs 에서 Swagger UI 확인
```

스모크 테스트:

```bash
python -m backend.test_smoke      # ALL SMOKE TESTS PASSED
```

## 라즈베리파이 배포 (4단계)

```bash
git clone <repo> && cd twoems-server
cp .env.example .env              # GEMINI_API_KEY 등 채우기
docker compose up -d --build
```

`docker-compose.yml`은 호스트 `/mnt/hdd`를 컨테이너에 마운트한다.
HDD 마운트가 선행되어야 한다:

```bash
sudo mkdir -p /mnt/hdd
sudo mount /dev/sda1 /mnt/hdd     # NTFS면 ntfs-3g 필요
```

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `STORAGE_ROOT`    | `/mnt/hdd` | 사용자 파일 저장소 루트 |
| `CORS_ORIGINS`    | `*` | CORS 허용 오리진(콤마 구분) |
| `GEMINI_API_KEY`  | (없음) | 3단계 AI 기능용 |
| `MAX_UPLOAD_BYTES`| `2147483648`(2GB) | 업로드 1건 최대 크기 |

## 프로젝트 구조

```
twoems-server/
├── docker-compose.yml     # backend + frontend + cloudflared(tunnel)
├── .env.example / .gitignore / README.md
├── backend/               # FastAPI 단일 API 게이트웨이
│   ├── Dockerfile · requirements.txt
│   ├── main.py            # 진입점 (CORS·lifespan·health)
│   ├── config.py          # 환경변수 설정
│   ├── schemas.py         # Pydantic 모델
│   ├── security_paths.py  # 경로 탈출 방지
│   ├── gemini_client.py   # Gemini 래퍼 (키 없으면 503)
│   ├── test_smoke.py      # 스모크 테스트
│   └── routers/
│       ├── files.py       # 파일 관리 API
│       ├── system.py      # 시스템 모니터링 API
│       └── ai.py          # Gemini AI (요약·검색·Q&A)
└── frontend/              # React + Tailwind 대시보드
    ├── Dockerfile · nginx.conf
    ├── tailwind.config.js # Control Deck 테마 (phosphor lime)
    └── src/
        ├── App.tsx        # 셸·토스트·레이아웃
        ├── lib/           # api 클라이언트·포맷 유틸
        ├── hooks/         # usePolling
        └── components/
            ├── system/    # Gauge·Sparkline·SystemMonitor
            ├── files/     # FileExplorer·FileViewer
            ├── ai/        # AIPanel (자연어 검색)
            └── ui/        # Modal
```
