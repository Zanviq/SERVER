"""admin 전용 웹 터미널 PTY 서버 (별도 컨테이너).

- 웹소켓 핸드셰이크의 server_session 쿠키를 백엔드와 동일한 SESSION_SECRET/솔트로 검증.
- TERMINAL_ADMINS 목록의 사용자만 허용.
- nsenter로 라즈베리파이 '호스트'의 실제 셸(bash)에 접속 (pid:host + privileged 필요).
- 프로토콜: 클라이언트→서버 바이너리=stdin, 텍스트 JSON {"resize":[cols,rows]}=창크기.
           서버→클라이언트 바이너리=stdout/stderr.
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import os
import pty
import signal
import struct
import termios
from http.cookies import SimpleCookie

import websockets
from itsdangerous import URLSafeTimedSerializer
from urllib.parse import urlparse

SECRET = os.getenv("SESSION_SECRET", "")
SALT = "server-session-v1"
TTL = int(os.getenv("SESSION_TTL_SECONDS", "3600"))
ADMINS = {a.strip() for a in os.getenv("TERMINAL_ADMINS", "admin").split(",") if a.strip()}
# CSWSH 방지: 허용 Origin 목록. 비어 있으면 요청 Host와 동일 출처만 허용.
ALLOWED_ORIGINS = {o.strip() for o in os.getenv("TERMINAL_ORIGINS", "").split(",") if o.strip()}
COOKIE_NAME = "server_session"
PORT = int(os.getenv("TERMINAL_PORT", "7681"))

# 호스트 네임스페이스로 진입해 실제 라즈베리파이 셸 실행
HOST_SHELL = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "bash", "-l"]


def _verify(token: str) -> str | None:
    if not SECRET or not token:
        return None
    try:
        data = URLSafeTimedSerializer(SECRET, salt=SALT).loads(token, max_age=TTL)
    except Exception:
        return None
    u = data.get("u")
    return u if u in ADMINS else None


def _origin_ok(headers) -> bool:
    """Cross-Site WebSocket Hijacking 방지: 핸드셰이크 Origin 검증.

    브라우저 요청엔 항상 Origin이 있으므로 없으면 거부.
    TERMINAL_ORIGINS가 설정되면 그 목록만, 아니면 요청 Host와 동일 출처만 허용.
    """
    origin = headers.get("Origin", "")
    if not origin:
        return False
    if ALLOWED_ORIGINS:
        return origin in ALLOWED_ORIGINS
    host = headers.get("Host", "")
    try:
        return bool(host) and urlparse(origin).netloc == host
    except Exception:
        return False


def _cookie_token(header: str) -> str:
    if not header:
        return ""
    jar = SimpleCookie()
    try:
        jar.load(header)
    except Exception:
        return ""
    morsel = jar.get(COOKIE_NAME)
    return morsel.value if morsel else ""


async def handler(ws):
    # ── Origin 검증 (CSWSH 방지) → 인증 ──
    if not _origin_ok(ws.request.headers):
        await ws.close(code=4403, reason="bad origin")
        return
    cookie_header = ws.request.headers.get("Cookie", "")
    user = _verify(_cookie_token(cookie_header))
    if not user:
        await ws.close(code=4403, reason="forbidden")
        return

    # ── PTY + 호스트 셸 ──
    pid, fd = pty.fork()
    if pid == 0:  # child
        try:
            os.execvp(HOST_SHELL[0], HOST_SHELL)
        except Exception:
            os._exit(127)

    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def on_master_readable():
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if data:
            queue.put_nowait(data)
        else:
            loop.remove_reader(fd)
            queue.put_nowait(None)  # EOF

    loop.add_reader(fd, on_master_readable)

    async def pump_out():
        while True:
            data = await queue.get()
            if data is None:
                break
            try:
                await ws.send(data)
            except Exception:
                break

    out_task = asyncio.create_task(pump_out())
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                os.write(fd, msg)
            else:
                try:
                    obj = json.loads(msg)
                except Exception:
                    os.write(fd, msg.encode())
                    continue
                if "resize" in obj:
                    cols, rows = obj["resize"]
                    fcntl.ioctl(
                        fd, termios.TIOCSWINSZ,
                        struct.pack("HHHH", int(rows), int(cols), 0, 0),
                    )
    except websockets.ConnectionClosed:
        pass
    finally:
        try:
            loop.remove_reader(fd)
        except Exception:
            pass
        out_task.cancel()
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except OSError:
            pass


async def main():
    if not SECRET:
        print("[terminal] SESSION_SECRET 미설정 — 모든 연결 거부", flush=True)
    async with websockets.serve(handler, "0.0.0.0", PORT, max_size=None):
        print(f"[terminal] listening on :{PORT}, admins={ADMINS}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
