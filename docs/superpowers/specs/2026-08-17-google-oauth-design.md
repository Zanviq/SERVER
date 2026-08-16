# Google 캘린더 OAuth 연동 설계

작성일: 2026-08-17 · 대규모 개편 4단계

## 문제

지금은 사용자가 **직접** Google에서 refresh token을 발급받아 `.env`에 유저별
접두사로 넣어야 한다.

```
admin_GOOGLE_CLIENT_ID=...
admin_GOOGLE_CLIENT_SECRET=...
admin_GOOGLE_REFRESH_TOKEN=...      ← 손으로 받아와야 함
```

계정마다 이 과정을 반복해야 하고, 서버에 SSH로 들어가 `.env`를 고치고 재시작해야
한다. 3단계에서 웹 회원가입이 생겼으므로 이 방식은 더 이상 맞지 않는다.

## 목표

설정 화면에서 **"Google 연동" 버튼 → 구글 동의 화면 → 자동 완료**.
refresh token은 서버가 받아 사용자별로 저장한다.

## 구성

OAuth 클라이언트는 **앱 하나**를 공유하고(유저별 접두사 제거), 발급된 토큰만
사용자별로 보관한다.

```
GOOGLE_CLIENT_ID=...        # 앱 공통 (Google Cloud Console에서 1회 발급)
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://server.zanviq.dev/api/google/callback
```

토큰 저장: `users/<username>/google.json`

```json
{
  "refresh_token": "1//0g...",
  "calendar_id": "primary",
  "email": "me@gmail.com",
  "connected_at": 1755400000.0
}
```

## 흐름

```
1. GET  /api/google/auth-url    (로그인 필요)
     → state 서명 발급 + 구글 동의 URL 반환
2. 사용자가 구글에서 동의
3. GET  /api/google/callback?code=&state=
     → state 검증(위조·다른 사용자 주입 차단)
     → code를 refresh_token으로 교환해 사용자별 저장
     → 설정 화면으로 리다이렉트
4. 이후 calendar_google이 그 토큰으로 동작 (기존 코드 그대로)
```

`state`는 `itsdangerous`로 **사용자명과 발급시각을 서명**해 담는다. 검증 시
현재 세션 사용자와 일치해야 한다 — 다른 사람의 계정에 내 구글 계정을 붙이는
CSRF를 막는다. 유효시간 10분.

`access_type=offline` + `prompt=consent`로 요청해야 refresh token이 온다.
(이미 동의한 계정은 `prompt` 없이는 refresh token을 주지 않는다.)

토큰 교환은 **표준 라이브러리 `urllib`** 로 한다. `requests`·
`google-auth-oauthlib`를 새로 넣지 않는다.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/google/status` | 연동 여부·이메일·캘린더 ID |
| `GET` | `/api/google/auth-url` | 동의 URL 발급 |
| `GET` | `/api/google/callback` | 코드 교환 후 설정 화면으로 리다이렉트 |
| `POST` | `/api/google/disconnect` | 저장된 토큰 삭제(내부 캘린더로 복귀) |

## 기존 설정과의 관계

`config.google_config(username)`이 **저장소를 먼저** 보고, 없으면 기존
`<username>_GOOGLE_*` 환경변수로 폴백한다. 지금 `.env`로 연동된 admin 계정은
그대로 동작하며, 웹에서 다시 연동하면 저장소 값이 우선한다.

## 프런트

설정 → 캘린더 탭 상단에 연동 상태 카드:
- 미연동: "Google 캘린더 연동" 버튼 → `auth-url`을 받아 이동
- 연동됨: 계정 이메일 표시 + "연동 해제"
- 서버에 `GOOGLE_CLIENT_ID`가 없으면 안내 문구만 표시(버튼 숨김)

## 검증

- 미설정 서버에서 `auth-url` → 503과 안내 메시지
- state 위조/만료 → 400
- 다른 사용자의 state로 콜백 → 403
- 연동 해제 후 내부 캘린더로 폴백

## 위험

- **redirect URI를 Google Console에 등록**해야 한다(사용자 수동 작업).
  등록 전에는 구글이 `redirect_uri_mismatch`로 거부한다.
- refresh token은 평문으로 저장된다. 파일 권한은 컨테이너 root 전용이며,
  저장소가 외장하드의 ext4라 POSIX 권한이 정상 동작한다.
