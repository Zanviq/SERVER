"""쓰기 요청은 이 앱 자신(같은 출처)에서 온 것만 받는다 — CSRF 막기.

세션 쿠키는 SameSite=Lax 다. Lax 는 **다른 사이트**의 요청에는 쿠키를 싣지 않지만,
`evil.zanviq.dev` → `server.zanviq.dev` 처럼 **형제 서브도메인은 같은 사이트**라 쿠키가
그대로 실린다. 이 도메인 아래에는 다른 프로젝트들이 계속 올라간다({이름}.zanviq.dev).

그리고 FastAPI 는 Content-Type 이 **없는** 본문을 JSON 으로 읽는다. fetch 에 타입 없는
Blob 을 실으면 CORS 사전 요청이 없는 '단순 요청'이라 그대로 서버에 닿고, 응답은 못
읽어도 일은 벌어진다. 실측(로컬 서버): Origin evil.zanviq.dev · Sec-Fetch-Site same-site ·
타입 없는 본문으로 /api/notes/rename 이 **200 으로 이름을 바꿨다**. 같은 길로 AI 대화
(문서를 지우는 스킬이 있다)·관리자 승인도 된다. 형제 사이트 하나에 XSS 가 생기면 곧장
이 서버의 쓰기 권한이 된다.

판정(쓰기 메서드만 — 읽기는 CORS 가 응답을 가린다):
1. Origin 이 허용 목록(CORS_ORIGINS)에 있으면 받는다(개발 서버 등 일부러 연 곳).
2. Sec-Fetch-Site 가 있으면 그것을 믿는다 — same-site·cross-site 는 거절.
   (브라우저가 붙이는 헤더라 페이지 스크립트가 바꿀 수 없다. 요즘 브라우저는 모두 보낸다.)
3. 없으면(옛 브라우저) Origin 의 호스트가 요청 Host 와 다를 때 거절. Origin 이 "null"
   (샌드박스 iframe 등)이어도 거절.
4. 둘 다 없으면 브라우저가 아니다(스크립트·curl·시험) — 쿠키를 가진 쪽이 직접 보낸 것.

순수 ASGI 로 만든다. BaseHTTPMiddleware 는 스트리밍 응답(AI 대화 SSE)을 감싸며 끊기
쉽다.
"""
from __future__ import annotations

from urllib.parse import urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send

from .asgi_util import WRITE_METHODS, headers_of, refuse

REFUSED = "다른 사이트에서 온 요청은 받지 않습니다."


def is_foreign(method: str, headers: dict[str, str], allowed: frozenset[str]) -> bool:
    """이 쓰기 요청이 다른 출처의 페이지가 보낸 것인가. headers 의 이름은 소문자."""
    if method.upper() not in WRITE_METHODS:
        return False
    origin = headers.get("origin", "")
    if origin and origin in allowed:
        return False
    site = headers.get("sec-fetch-site", "")
    if site:
        return site in ("same-site", "cross-site")
    if not origin:
        return False
    if origin == "null":
        return True
    return urlsplit(origin).netloc.lower() != headers.get("host", "").lower()


class SameOriginWrites:
    def __init__(self, app: ASGIApp, allowed_origins: list[str] | tuple[str, ...] = ()) -> None:
        self.app = app
        self.allowed = frozenset(allowed_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            if is_foreign(scope.get("method", "GET"), headers_of(scope), self.allowed):
                await refuse(scope, receive, send, 403, REFUSED)
                return
        await self.app(scope, receive, send)
