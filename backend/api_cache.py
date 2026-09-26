"""/api 응답은 브라우저 캐시에 남기지 않는다 — 스스로 캐시 규칙을 정한 응답만 빼고(62차).

예전엔 /api 에 Cache-Control 이 하나도 없었다. 일기·문서·할 일 JSON 이 브라우저 디스크 캐시에
그대로 남고(공용 PC 라면 로그아웃해도 파일로 남는다), 검증자(Last-Modified)를 실은 응답은 브라우저가
나이의 10% 동안 서버에 묻지 않고 다시 썼다 — 실측: 로그아웃한 뒤에도 같은 주소가 200 으로 열렸다.

그래서 이미 Cache-Control 을 정한 응답(파일 — user_file 의 `private, no-cache`, zip — archive.py 의
no-store)은 그대로 두고, 나머지 /api 응답에는 no-store 를 붙인다. 오류 응답(401·404 …)도 포함 —
404 는 브라우저가 스스로 캐시해도 되는 상태라 붙이지 않으면 없던 것이 계속 없다고 나올 수 있다.

순수 ASGI(same_origin.py 설명 — BaseHTTPMiddleware 는 스트리밍 응답을 감싸며 끊기 쉽다).
"""
from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

API_DEFAULT = b"no-store"


class NoStoreApi:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return

        async def send_marked(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                if not any(k.lower() == b"cache-control" for k, _ in headers):
                    headers.append((b"cache-control", API_DEFAULT))
                    message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_marked)
