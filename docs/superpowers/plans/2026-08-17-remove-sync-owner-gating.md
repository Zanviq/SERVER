# 로컬 연동 제거 + 폴더 다운로드 + 주인 전용 화면 — 실행 계획

작성일: 2026-08-17 · 개편 5단계

## 목표

1. 로컬 폴더 연동(sync)을 완전히 제거하고 **다운로드**로 대체한다
2. `.env`에서 만들어진 **주인 계정에만** 대시보드·시스템 상태·터미널·계정 관리를 노출한다
3. **Google 캘린더 연동은 주인만** — 가입 사용자는 내부 캘린더를 그대로 쓴다

## 순서 (의존성 때문에 이 순서여야 함)

**A. `origin` 필드 + 백필** → **B. sync 제거 + zip 다운로드** → **C. 주인 게이팅**

A가 C보다 먼저다. `ensure_seed`는 `accounts.json`이 있으면 early-return하므로,
백필 없이 게이트를 켜면 **실제 배포된 주인이 `signup`으로 읽혀 잠긴다.**

---

## A. 주인(owner) 구별

`role`의 세 번째 값으로 만들지 **않는다**. `accounts._admin_count`가
`role=="admin"`을 세어 "마지막 관리자 잠금"을 막고 있어서, owner를 role로 만들면
그 가드가 조용히 무력화된다. 직교 필드로 둔다.

```
origin: "bootstrap" | "signup"
```

| 파일 | 변경 |
|---|---|
| `backend/accounts.py` | `Account.origin` 필드, `_to_account`에서 읽기, `ensure_seed`는 `"bootstrap"`, `signup`은 `"signup"` 기록. `set_role`·`set_status`에서는 **쓰지 않는다** |
| `backend/accounts.py` | **백필**: `ensure_seed`의 early-return **앞**에서, `origin`이 없는 행에 `approved_by == "system(.env 이관)"` 또는 `username in settings.users`면 `bootstrap`, 아니면 `signup` |
| `backend/auth.py` | `SessionUser.origin` + `is_owner` property, `require_session`에서 전달, `require_owner` 의존성 신설 |
| `backend/routers/auth.py` | `SessionInfo.origin` — **`login()`과 `session()` 두 곳 모두** 채운다(한쪽만 하면 로그인 직후와 세션 갱신 후 UI가 달라진다) |
| `frontend/src/lib/api.ts` | `SessionInfo.origin`, `AdminUser.origin` |

`list_all()`이 `password_hash`만 걸러내므로 `origin`은 관리자 API에 자동 노출된다.

## B. sync 제거 + 다운로드 대체

**삭제 (5)**: `backend/routers/sync.py`, `frontend/src/pages/Sync.tsx`,
`frontend/src/store/sync.ts`, `frontend/src/lib/syncDb.ts`,
`frontend/src/lib/fsAccess.ts`(store/sync.ts 전용 고아).

**수정**:
- `backend/main.py` — import 튜플의 `sync,` **와** `include_router` 줄 **둘 다**(하나만 지우면 `NameError`)
- `backend/user_settings.py` — DEFAULTS의 `sync` 블록
- `backend/test_smoke.py` — `test_sync_manifest_upload_download` 정의 **와** `__main__` 호출 **둘 다**
- `frontend/src/App.tsx` — `useSync` import, loaders 항목, lazy, Route, 로그인 후 `init()` 호출
- `frontend/src/components/layout/Sidebar.tsx` — NAV 항목 + `FolderSync` import
- `frontend/src/pages/Settings.tsx` — 탭 항목 + `sync` 패널(`s.sync.*`를 가드 없이 읽으므로 백엔드와 **같은 커밋**이어야 함) + `FolderSync` import
- `frontend/src/lib/api.ts` — sync 메서드 3개, `SyncManifest` 타입, `UserSettings.sync`

**설정 잔재 정리**: `user_settings.patch`가 화이트리스트 없는 deep-merge라
디스크의 `sync` 블록이 영원히 남는다. DEFAULTS에 없는 최상위 키를 저장 시
버리도록 정리한다(이번에 `default_scope` 잔재도 같이 사라진다).

**브라우저 잔재**: IndexedDB `server-sync`는 코드를 지워도 남는다.
`main.tsx`에 1회성 `deleteDatabase` 정리를 넣는다.

### 폴더 zip 다운로드

단일 파일은 이미 `/api/notes/raw?download=true`로 동작한다. 없는 것은 폴더 단위다.

```
GET /api/notes/archive?path=<rel>   (path="" → 전체)
```

- `zipfile`·`tempfile` 표준 라이브러리만 사용 — 의존성 추가 없음
- **임시파일 + `FileResponse`**로 만든다. `BytesIO`는 라즈베리파이에서 사진·영상
  폴더를 통째로 메모리에 올리고, 수동 `Content-Disposition`은 한글 폴더명이 깨진다.
  `FileResponse`는 RFC 5987 인코딩을 알아서 붙인다.
- **심볼릭 링크는 건너뛴다.** `safe_join`은 요청 경로만 검증하므로 rglob이 루트
  밖 링크를 따라갈 수 있고, zip은 그 내용을 통째로 내보낸다.
- `.trash`는 `data/`의 형제라 자동 제외된다.

**UI**: 폴더 행에 다운로드, 상단에 "전체 다운로드", 그리고 지금 버튼이 없는
**편집 가능 문서(md/txt)**에도 다운로드를 추가한다.

## C. 주인 전용 게이팅

클라이언트 숨김만으로는 화장이다. **서버를 먼저 막는다.**

| 대상 | 서버 | 클라이언트 |
|---|---|---|
| 시스템 상태 | `system.router`에 `require_owner` | 대시보드에서 패널 숨김 |
| 계정 관리 | `admin.router`를 `require_owner`로 | 설정 탭 숨김 |
| 터미널 | `terminal.py`의 `is_admin`을 `is_owner`로 | 기존 capability probe 그대로 |
| Google 연동 | `auth-url`·`callback`·`disconnect`에 `require_owner` | 연동 카드 숨김 |
| 대시보드 | (페이지 자체는 데이터만 막으면 됨) | 라우트를 주인만, 그 외 `/notes`로 |

`/`는 catch-all(`*`) 목적지이기도 하므로, 주인이 아니면 **`/`와 `*` 모두**
`/notes`로 보낸다. 사이드바는 nav를 데스크톱·모바일 두 번 렌더하므로
**JSX가 아니라 배열을 필터**한다.

Google `status`는 막지 않는다 — 가입 사용자에게 "연동은 관리자 전용"임을
알려주려면 상태 조회는 되어야 한다. 대신 `server_ready`를 주인이 아닐 때 false로.

## 검증

- 백필: `origin` 없는 기존 행이 `bootstrap`으로 승격되는지
- 가입 사용자로 `/api/system`·`/api/admin/users`·`/api/google/auth-url` → 403
- 가입 사용자 로그인 시 `/`가 `/notes`로 리다이렉트
- 가입 사용자도 캘린더 CRUD는 정상
- zip: 폴더 다운로드가 하위 구조를 유지, 심볼릭 링크 제외, 한글 이름 유지
- `python -m backend.test_smoke` 전체 통과 (새 테스트는 `__main__` 목록에 등록)

## 위험

- **백필 실패 시 주인이 잠긴다.** 백필을 게이트보다 먼저 넣고, 배포 후 실제
  계정의 `origin`을 확인한 뒤 다음 단계로 간다.
- 백엔드·프런트를 **같은 커밋**으로. 한쪽만 나가면 배포된 설정 화면이 크래시한다.
- 사용자 체감: 로컬 연동이 사라지므로 zip 다운로드를 **같은 릴리스**에 넣는다.
