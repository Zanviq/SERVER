"""요청 본문 크기 한도 — 본문을 **읽기 전에** 거절한다.

FastAPI 는 본문(JSON·폼)을 **인증 의존성보다 먼저** 통째로 읽고 푼다. 그래서 로그인하지 않은
누구든 아무 쓰기 창구에나 큰 본문을 보내면 서버가 그것을 다 메모리에 올린 뒤에야 401 을
돌려줬다. 25차 실측(격리 서버): 로그인 없이 90MB × 6 을 /api/notes/save 로 → 서버 메모리
73MB → 1,240MB, /api/auth/login 으로 → +2,551MB(422 가 그 본문을 되읊기까지 했다 — main 의
validation 처리 참고). 클라우드플레어는 요청 하나를 100MB 까지 넘기고 수에는 한도가 없다.
nginx 는 파일 올리기 때문에 2GB 까지 받는다. 파이의 메모리를 인터넷 누구나 비울 수 있었다.

한도(부르는 쪽이 로그인했는가로 가른다 — 쿠키의 서명·계정 상태까지 본다):
- 로그인 전: ANON_BODY (가입·로그인 본문은 수백 바이트다)
- 로그인 뒤 JSON 등: JSON_BODY (채팅에 사진 8장 × 3MB 를 base64 로 싣는 것이 가장 크다)
- 로그인 뒤 파일 올리기(multipart): settings.max_upload_bytes — 창구마다 제 한도를 다시 본다

Content-Length 가 있으면 풀지 않고 곧바로 413. 없으면(청크 전송) 읽는 만큼 세다가 넘는 순간
413. 로그인 확인은 본문이 ANON_BODY 를 넘을 때만 한다(작은 요청에는 비용이 없다).

끊는 방식은 둘이다. 로그인하지 않은 쪽은 **곧바로 닫는다**(한 바이트도 더 받을 까닭이 없다).
로그인한 사람은 남은 본문을 **받아서 버린 뒤** 413 을 준다 — 다 받기 전에 닫으면 운영체제가
연결을 리셋해, 브라우저는 413 대신 "연결 오류"만 보고 무엇이 문제인지 말하지 못했다(실측).
버리는 것이라 메모리는 들지 않는다.
"""
from __future__ import annotations

from collections.abc import Callable
from http.cookies import SimpleCookie

from fastapi import HTTPException

from .asgi_util import WRITE_METHODS, headers_of, refuse

ANON_BODY = 64 * 1024
JSON_BODY = 40 * 1024 * 1024


def _cookie(headers: dict[str, str], name: str) -> str:
    raw = headers.get("cookie", "")
    if not raw:
        return ""
    jar = SimpleCookie()
    try:
        jar.load(raw)
    except Exception:  # noqa: BLE001
        return ""
    m = jar.get(name)
    return m.value if m else ""


def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):.0f}MB" if n >= 1024 * 1024 else f"{n // 1024}KB"


class BodyLimit:
    """순수 ASGI 미들웨어. signed_in(토큰) 은 그 토큰이 지금 유효한 세션인지 답한다."""

    def __init__(self, app, *, cookie_name: str, upload_limit: Callable[[], int],
                 signed_in: Callable[[str], bool]):
        self.app = app
        self.cookie_name = cookie_name
        self.upload_limit = upload_limit
        self.signed_in = signed_in

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in WRITE_METHODS:
            return await self.app(scope, receive, send)
        headers = headers_of(scope)
        multipart = headers.get("content-type", "").lower().startswith("multipart/")
        known: dict[str, int] = {}

        def limit() -> int:
            # 한 요청에 한 번만 본다(청크마다 계정 파일을 읽지 않게)
            if "n" not in known:
                try:
                    ok = self.signed_in(_cookie(headers, self.cookie_name))
                except Exception:  # noqa: BLE001 — 확인하지 못했으면 로그인하지 않은 것으로
                    ok = False
                known["n"] = (self.upload_limit() if multipart else JSON_BODY) if ok else ANON_BODY
            return known["n"]

        def too_big(n: int) -> bool:
            return n > ANON_BODY and n > limit()

        async def drain(msg=None) -> None:
            # 로그인한 사람에게만 — 남은 본문을 받아 버린다(위 설명: 리셋 대신 413 을 보게)
            if limit() <= ANON_BODY:
                return
            while msg is None or (msg["type"] == "http.request" and msg.get("more_body")):
                msg = await receive()

        length = headers.get("content-length")
        if length is not None:
            try:
                declared = int(length)
            except ValueError:
                declared = -1
            if declared < 0:
                return await refuse(scope, receive, send, 400, "본문 길이(Content-Length)가 잘못되었습니다.",
                                    close=True)
            if too_big(declared):
                await drain()
                return await refuse(scope, receive, send, 413, _message(limit()), close=True)

        seen = 0

        async def counted():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if too_big(seen):
                    await drain(msg)
                    # 읽는 쪽(FastAPI 의 본문 풀기)은 HTTPException 을 그대로 올려 보낸다
                    raise HTTPException(status_code=413, detail=_message(limit()))
            return msg

        return await self.app(scope, counted, send)


def _message(limit: int) -> str:
    if limit <= ANON_BODY:
        return f"요청이 너무 큽니다(로그인 전 최대 {_mb(limit)}). 로그인했는지 확인해 주세요."
    return f"요청이 너무 큽니다(최대 {_mb(limit)})."

