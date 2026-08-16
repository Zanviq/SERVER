# SERVER v3 기능 확장 설계

**작성일:** 2026-07-01
**대상:** 노트 폴더 · 그래프 폴더뷰 · 휴지통 · ~~로컬 폴더 연동~~(2026-08-17 제거) · 웹 터미널 · 캘린더 팝오버 수정

## 결정 사항 (사용자 확인 완료)
- **로컬 연동(#5):** 브라우저 방식 (PC 크롬/엣지 전용, File System Access API). 폰/사파리 미지원.
- **웹 터미널(#6):** 대화형 셸 + 호스트(라즈베리파이) 제어. 별도 컨테이너 + nsenter.
- **삭제 전파:** v1 제외 (합집합 미러 + 충돌해결만). 웹 삭제는 휴지통 경유.
- **병합 규칙:** 로컬(원본) 위 / 웹 아래, 줄 기준.
- **구현 순서:** #1 → #2 → #4 → #3 → #5 → #6 (휴지통이 연동보다 먼저).

---

## #1 캘린더 `+more` 팝오버 수정
- 원인: `.fc-popover`에 테마 CSS 없음 → 투명 배경.
- `index.css` `.fc-server` 스코프에 `.fc-popover / -header / -body` 스타일 추가 (bg-surface, border-line, 그림자, 글자색).

## #2 노트 폴더
- 백엔드 `routers/notes.py`:
  - `POST /api/notes/folder` `{scope, path}` — 폴더 생성.
  - `DELETE /api/notes/folder?scope&path` — 폴더 → 휴지통.
  - `GET /api/notes/tree?scope` — `{folders: [rel...], notes: [{path,title,modified}...]}`.
- 프론트 `pages/Notes.tsx`: 폴더 트리 사이드바, "새 폴더", 선택 폴더 내 노트 작성.

## #3 그래프뷰 폴더 단위
- `GET /api/notes/graph?scope&folder=<rel>&mode=<links|folders>`:
  - `mode=links` (기본): `folder` 하위 노트들만의 위키링크 그래프.
  - `mode=folders`: `folder`의 **직속 하위 폴더**를 노드로 (드릴다운 네비게이션). 각 폴더 노드에 노트 수.
- `notes_graph.build_graph(root, folder=None, mode="links")`로 확장.
- 프론트 `pages/Graph.tsx`: 브레드크럼, 폴더 노드 클릭 시 진입, `링크/폴더구조` 토글.

## #4 휴지통
- 위치: `users/<id>/.trash/` — 개인, 목록·검색·동기화·그래프에서 제외.
- 구조: `.trash/index.json` (엔트리 배열) + `.trash/data/<id>/` (원본 파일/폴더).
  - 엔트리: `{id, scope, orig_rel, name, is_dir, kind(file|note), deleted_at}`.
- 백엔드 `trash.py`:
  - `move_to_trash(scope, rel, user, settings, kind) -> id`
  - `list_trash(user, settings) -> [entry]`
  - `restore(id, user, settings)` — 원위치 복원, 충돌 시 ` (restored)` 접미.
  - `purge(id)`, `empty(user, settings)`.
- 연결: 파일 삭제, 노트/폴더 삭제, 동기화 웹 덮어쓰기/삭제.
- 프론트 `pages/Trash.tsx` + 사이드바 항목 + `api.trash*`.

## #5 로컬 폴더 연동 (브라우저) — **2026-08-17 제거됨**

> ⚠️ 이 절은 **역사 기록**이다. 로컬 연동은 제거되었고 폴더 zip 다운로드
> (`GET /api/notes/archive`)로 대체됐다. 아래 `/api/sync/*` 엔드포인트는
> **더 이상 존재하지 않는다**. 살아있는 API로 읽지 말 것.
### 프론트
- `lib/fsAccess.ts`: `showDirectoryPicker`, 재귀 walk(`{rel, file, size, hash}`), Web Crypto sha256.
- `lib/syncDb.ts`: IndexedDB — 사용자별 매핑 `{userId, dirHandle, webScope, webPath}` 저장/조회.
- `store/sync.ts`: 상태(`idle|syncing|resume|unsynced|conflict`), 로그인 시 자동 시도.
- `pages/Sync.tsx` (또는 파일 페이지 내 패널): "연동" 버튼, 상태 표시, 충돌 diff 모달.
- 로그인 자동: 매핑 있음 + `queryPermission=granted` → 자동 `연동중…`; `prompt` → `연동 재개`(클릭); 없음 → `연동 안됨`.
### 동기화 로직 (pair 단위)
1. 로컬 walk → 웹 `GET /api/sync/manifest` → 해시 비교.
2. 로컬 only → `POST /api/sync/upload`. 웹 only → `GET /api/sync/download` → 로컬 기록.
3. 양쪽 상이:
   - 텍스트/md → 충돌 목록에 넣고 diff 모달 → `local|web|merge` 선택.
     - merge: 줄 기반, 동일 충돌 영역은 로컬 위 + 웹 아래.
   - 바이너리 → 로컬 우선(설정 변경 가능) → 업로드.
   - 웹 파일 덮어쓰기 전 기존본 → 휴지통.
### 백엔드 `routers/sync.py`
- `GET /api/sync/manifest?scope&path` — 재귀 `{rel, size, mtime, hash(sha256)}`.
- `POST /api/sync/upload?scope&path&rel` (body=bytes) — 기존본 휴지통 후 기록.
- `GET /api/sync/download?scope&path&rel` — bytes.
- 텍스트 판정: 확장자 화이트리스트(.md,.txt,.json,.csv,.log,코드류).

## #6 웹 터미널 (admin, 호스트)
- 별도 컨테이너 `server-terminal` (compose 프로필 `terminal`, 옵트인):
  - `pid: host`, `privileged: true`, `network_mode`는 기본, `/:/host` 마운트 불필요(nsenter 사용).
  - 파이썬 웹소켓 PTY 서버: `nsenter -t 1 -m -u -i -n -p -- bash`로 호스트 셸.
  - admin 세션 토큰 검증(백엔드와 동일 SESSION_SECRET/salt 공유) 후 PTY 연결.
- 프론트 `pages/Terminal.tsx`: xterm.js + `ws`. admin 아니면 사이드바/라우트 숨김.
- 보안: admin only, `.env` `ENABLE_TERMINAL`, compose 프로필로만 실행. admin 비밀번호 강화 권고.

## 설정 페이지 추가
- 연동 섹션: 텍스트 충돌 기본(`ask|local|web|merge`), 바이너리 정책(`local|web`).

## 테스트
- 백엔드: `test_smoke.py`에 notes 폴더/트리, trash 이동·복원, sync manifest/upload/download 추가.
- 프론트: 빌드 통과 + 브라우저 수동 확인.
