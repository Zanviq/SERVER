# 회원가입 + 관리자 승인 설계

작성일: 2026-08-17 · 대규모 개편 3단계

## 문제

계정이 `.env`의 `AUTH_USERS`(JSON)에 **평문 비밀번호**로 박혀 있다.

```python
return hmac.compare_digest(password, acc.password)   # 평문 대 평문
```

계정을 추가하려면 서버에 SSH로 들어가 `.env`를 고치고 컨테이너를 재시작해야 한다.
가입 기능을 붙이면 계정 수가 늘어나므로, 저장 방식부터 바꾸지 않으면 위험이 커진다.

## 목표

- 웹에서 **회원가입** 신청
- 내 승인 없이는 로그인 불가 — **관리자 승인 대기열**
- 비밀번호를 **해시**로 저장
- 기존 `admin` 계정은 그대로 동작 (무중단)

## 계정 저장소

`STORAGE_ROOT/accounts.json` — 기존 `json_store`(원자적 쓰기 + 락)를 그대로 쓴다.

```json
[{
  "username": "admin",
  "display_name": "관리자",
  "password_hash": "pbkdf2_sha256$600000$<salt_b64>$<hash_b64>",
  "role": "admin",              // admin | user
  "status": "active",           // pending | active | rejected | disabled
  "created_at": 1755400000.0,
  "approved_at": 1755400000.0,
  "approved_by": "admin"
}]
```

**해시**: `hashlib.pbkdf2_hmac("sha256", …, 600_000)` — 표준 라이브러리만 쓴다.
bcrypt/argon2는 새 의존성이 필요하고, 라즈베리파이에서 빌드가 무거워진다.
검증은 `hmac.compare_digest`로 상수시간 비교.

**형식**을 문자열에 담아(`알고리즘$반복수$salt$hash`) 나중에 반복수를 올리거나
알고리즘을 바꿔도 기존 해시를 계속 검증할 수 있게 한다.

### `.env`에서의 이관

서버 시작 시 `accounts.json`이 없으면 `AUTH_USERS`의 계정을 해시로 변환해 만든다
(1회). 이후 `.env`의 `AUTH_USERS`는 **부트스트랩 용도로만** 남고, 계정 관리는
저장소가 단일 출처가 된다. 이관된 계정은 `role=admin`, `status=active`로 둔다 —
지금 `.env`에 있는 계정은 내가 직접 넣은 것뿐이기 때문이다.

## 가입 흐름

```
1. POST /api/auth/signup   {username, password, display_name}
     → status=pending 계정 생성. 즉시 로그인 불가.
2. 관리자가 승인 대기열에서 승인/거절
     → approve: status=active  (이때 문서 폴더 골격 생성)
     → reject : status=rejected
3. POST /api/auth/login
     pending  → 403 "승인 대기 중입니다"
     rejected → 403 "가입이 거절되었습니다"
     active   → 정상 로그인
```

로그인 실패 메시지는 **아이디 존재 여부를 흘리지 않도록** 기존처럼
"아이디 또는 비밀번호가 올바르지 않습니다"로 통일한다. 단 승인 대기·거절은
본인이 신청한 것을 아는 상태이므로 구분해서 알려준다.

**가입 제한**: 아이디는 `[a-z0-9_-]{3,32}`(경로에 쓰이므로 엄격히), 비밀번호는
8자 이상. 동일 아이디가 이미 있으면(상태 무관) 409.

## 권한

`role`은 `admin` | `user`. 관리자 전용 엔드포인트는 `require_admin` 의존성으로 보호한다.

기존 `TERMINAL_ADMINS` 환경변수는 터미널 접근 제어에 계속 쓰되, 계정의 `role`과
**둘 다 만족**해야 터미널을 쓸 수 있게 한다(권한 축소는 안전한 방향).

## API

| 메서드 | 경로 | 권한 | 설명 |
|---|---|---|---|
| `POST` | `/api/auth/signup` | 없음 | 가입 신청 |
| `GET` | `/api/admin/users` | admin | 전체 계정(비밀번호 제외) |
| `POST` | `/api/admin/users/{username}/approve` | admin | 승인 |
| `POST` | `/api/admin/users/{username}/reject` | admin | 거절 |
| `POST` | `/api/admin/users/{username}/disable` | admin | 비활성화 |
| `DELETE` | `/api/admin/users/{username}` | admin | 삭제(문서는 남김) |

**자기 자신 보호**: 마지막 관리자는 자신을 강등·비활성화·삭제할 수 없다
(잠겨서 아무도 승인 못 하는 상태 방지).

세션 무효화: 계정이 `active`가 아니게 되면 `verify_token`이 즉시 None을 돌려주므로
승인 취소·비활성화가 곧바로 반영된다.

## 프런트

- **로그인 페이지**: "회원가입" 전환 탭. 신청 후 "승인을 기다리는 중" 안내.
- **설정 페이지에 "계정 관리" 탭**(관리자에게만 보임): 대기 중 목록을 위에,
  나머지 계정을 아래에. 승인/거절/비활성화 버튼.
- 세션 응답에 `role`을 실어 프런트가 관리자 UI 노출 여부를 판단한다.

## 순서

1. `accounts.py` (저장소 + 해시) — 단위 테스트
2. `auth.py`·`config.py`를 저장소 기반으로 전환, `.env` 이관
3. `/api/auth/signup` + 로그인 상태 분기
4. `/api/admin/*` + `require_admin`
5. 프런트 로그인/가입, 계정 관리 탭
6. 배포 후 실제 가입→승인 왕복 확인

## 검증

- 기존 `admin` 계정이 이관 후에도 같은 비밀번호로 로그인된다
- pending 계정은 로그인 403, 승인 후 200
- 비관리자가 `/api/admin/*` 호출 시 403
- 마지막 관리자 자기 강등 시도 400
- 저장된 값에 평문 비밀번호가 없다

## 위험

- **이관 실패 시 로그인 불가**가 된다. `accounts.json` 생성은 원자적 쓰기로 하고,
  이관 후에도 `.env`의 `AUTH_USERS`는 지우지 않아 롤백(파일 삭제)이 가능하다.
- 승인 대기 계정이 문서 폴더를 만들지 않으므로, 승인 시점에 골격을 생성한다.
