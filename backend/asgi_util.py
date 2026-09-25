"""순수 ASGI 미들웨어(same_origin·body_limit)가 함께 쓰는 조각.

둘 다 요청 머리글을 같은 방식으로 읽고, 같은 '쓰기 메서드'를 보고, 같은 모양의 JSON 으로
거절한다. 따로 들고 있으면 한쪽만 고쳐진다(예: 쓰기 메서드에 하나를 더하면 CSRF 막기와 본문
한도가 서로 다른 요청을 걸러 낸다).

순수 ASGI 로 두는 까닭은 same_origin.py 설명 — BaseHTTPMiddleware 는 스트리밍 응답(AI 대화
SSE)을 감싸며 끊기 쉽다.
"""
from __future__ import annotations

from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send

#: 본문을 싣고 무언가를 바꾸는 메서드
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def headers_of(scope: Scope) -> dict[str, str]:
    """요청 머리글 — 이름은 소문자. 같은 이름이 여럿이면 마지막 것."""
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}


async def refuse(scope: Scope, receive: Receive, send: Send, status: int, detail: str,
                 *, close: bool = False) -> None:
    """`{"detail": ...}` 로 거절한다(화면의 오류 읽기가 이 모양을 안다). close 면 연결도 닫는다."""
    headers = {"connection": "close"} if close else None
    await JSONResponse({"detail": detail}, status_code=status, headers=headers)(scope, receive, send)
