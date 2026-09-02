"""admin 전용 웹 터미널 PTY 서버 (별도 컨테이너).

- 웹소켓 핸드셰이크의 server_session 쿠키를 백엔드와 동일한 SESSION_SECRET/솔트로 검증.
- 서버 주인(accounts.json의 origin=bootstrap·role=admin·status=active)이면서
  TERMINAL_ADMINS 목록에도 있는 사용자만 허용. 이름만 대조하면 같은 아이디로
  가입한 계정에 호스트 셸이 열린다(여기가 실제 권한 경계다).
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
import time
from http.cookies import SimpleCookie

import websockets
from itsdangerous import URLSafeTimedSerializer
from urllib.parse import urlparse

SECRET = os.getenv("SESSION_SECRET", "")
SALT = "server-session-v1"
TTL = int(os.getenv("SESSION_TTL_SECONDS", "3600"))
# 계정 저장소(읽기 전용 마운트). 없으면 아무도 통과시키지 않는다(fail closed).
ACCOUNTS_FILE = os.getenv("ACCOUNTS_FILE", "/accounts.json")
ADMINS = {a.strip() for a in os.getenv("TERMINAL_ADMINS", "admin").split(",") if a.strip()}
# CSWSH 방지: 허용 Origin 목록. 비어 있으면 요청 Host와 동일 출처만 허용.
ALLOWED_ORIGINS = {o.strip() for o in os.getenv("TERMINAL_ORIGINS", "").split(",") if o.strip()}
COOKIE_NAME = "server_session"
# 출력 큐에 쌓아 둘 덩어리 수. 클라이언트가 느릴 때 컨테이너 메모리가 출력량만큼
# 무한히 늘어나던 것을 막는다(한 덩어리는 최대 64KB).
OUT_QUEUE_MAX = 256
# 열린 셸의 세션을 다시 확인하는 주기(초).
RECHECK_SECONDS = 60
PORT = int(os.getenv("TERMINAL_PORT", "7681"))

# 호스트 네임스페이스로 진입해 실제 라즈베리파이 셸 실행
HOST_SHELL = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "bash", "-l"]


def _is_owner(username: str) -> bool:
    """accounts.json에서 서버 주인인지 확인. 파일이 없거나 못 읽으면 거부."""
    try:
        with open(ACCOUNTS_FILE, encoding="utf-8") as f:
            rows = json.load(f)
    except Exception:
        return False
    for r in rows if isinstance(rows, list) else []:
        if r.get("username") == username:
            return (
                r.get("origin") == "bootstrap"
                and r.get("role") == "admin"
                and r.get("status") == "active"
            )
    return False


def _verify(token: str) -> str | None:
    if not SECRET or not token:
        return None
    try:
        # 백엔드와 동일하게 payload의 ttl로 만료를 판정한다.
        # max_age=SESSION_TTL_SECONDS로 고정하면 사용자별 세션 시간 설정과 어긋나,
        # 짧게 설정한 사용자는 만료 뒤에도 통과하고 길게 설정한 사용자는 일찍 끊긴다.
        data, ts = URLSafeTimedSerializer(SECRET, salt=SALT).loads(
            token, return_timestamp=True
        )
    except Exception:
        return None
    raw = data.get("ttl")
    try:
        ttl = max(300, min(int(raw), 2_592_000)) if raw is not None else TTL
    except (TypeError, ValueError):
        ttl = TTL
    if (time.time() - ts.timestamp()) > ttl:
        return None
    u = data.get("u")
    if not u or u not in ADMINS:
        return None
    # 이름 대조만으로는 부족하다 — 실제 계정이 서버 주인이어야 한다.
    return u if _is_owner(u) else None


def _headers(ws):
    """websockets 버전 호환: v13+ 는 ws.request.headers, 레거시(v12)는 ws.request_headers."""
    req = getattr(ws, "request", None)
    if req is not None and getattr(req, "headers", None) is not None:
        return req.headers
    return ws.request_headers


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
    headers = _headers(ws)
    if not _origin_ok(headers):
        await ws.close(code=4403, reason="bad origin")
        return
    cookie_header = headers.get("Cookie", "")
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

    # 마스터 fd 를 논블로킹으로 둔다. 블로킹인 채로 이벤트 루프 스레드에서 쓰면,
    # 자식이 stdin 을 안 읽는 순간(예: 화면 갱신 중) os.write 가 거기서 멈춰
    # **서버 전체**가 선다 — 다른 연결의 입출력까지 함께 멈추고, 출력을 읽어 주는
    # 쪽도 같은 루프라 버퍼가 비지 않아 영영 풀리지 않는다.
    os.set_blocking(fd, False)

    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=OUT_QUEUE_MAX)
    closed = asyncio.Event()

    paused: set = set()

    def on_master_readable():
        # 큐가 찼는지 **읽기 전에** 본다. 읽고 나서 판단하면 이미 꺼낸 출력을
        # 버리게 되어, 화면에 글자가 빠진 채로 남는다.
        if queue.full():
            # 클라이언트가 느리면 큐가 무한정 자란다. 넘치면 읽기를 잠시 멈춰
            # PTY 쪽에 배압을 준다 — 버리는 것보다 늦는 편이 낫다.
            loop.remove_reader(fd)
            paused.add(True)
            return
        try:
            data = os.read(fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if data:
            queue.put_nowait(data)
        else:
            loop.remove_reader(fd)
            queue.put_nowait(None)  # EOF

    def resume_reader():
        if paused:
            paused.clear()
            try:
                loop.add_reader(fd, on_master_readable)
            except (OSError, ValueError):
                pass

    loop.add_reader(fd, on_master_readable)

    async def pump_out():
        while True:
            data = await queue.get()
            resume_reader()
            if data is None:
                # 셸이 끝났다. 화면에 '연결됨'으로 남겨 두면 다음 입력이
                # EIO 를 내며 핸들러를 죽인다 — 여기서 정직하게 닫는다.
                closed.set()
                try:
                    await ws.close(code=1000, reason="shell exited")
                except Exception:
                    pass
                break
            try:
                await ws.send(data)
            except Exception:
                closed.set()
                break

    async def write_all(data: bytes) -> None:
        """PTY에 전부 쓴다. 한 번에 다 못 쓰거나(긴 붙여넣기) 지금은 못 쓸 수 있다."""
        view = memoryview(data)
        while view:
            try:
                n = os.write(fd, view)
            except BlockingIOError:
                # 버퍼가 찼다. 이벤트 루프를 막지 않고 잠깐 양보한다.
                await asyncio.sleep(0.005)
                continue
            except OSError:
                closed.set()
                return
            view = view[n:]

    async def watch_session():
        """입력이 없어도 세션을 계속 확인한다.

        수신 메시지가 있을 때만 확인하면, 화면만 띄워 둔 세션은 만료·강등돼도
        영원히 재확인되지 않는다 — 호스트 루트 셸이 주인 없이 남는다.
        """
        while not closed.is_set():
            try:
                await asyncio.wait_for(closed.wait(), timeout=RECHECK_SECONDS)
                return
            except asyncio.TimeoutError:
                pass
            if _verify(_cookie_token(cookie_header)) != user:
                closed.set()
                try:
                    await ws.close(code=4403, reason="session expired")
                except Exception:
                    pass
                return

    out_task = asyncio.create_task(pump_out())
    watch_task = asyncio.create_task(watch_session())
    checked_at = time.time()
    try:
        async for msg in ws:
            if closed.is_set():
                break
            # 세션은 접속할 때 한 번만 봤다. 그러면 만료되거나 계정이 비활성·강등돼도
            # 이미 열린 **호스트 루트 셸**이 무제한으로 남는다. 주기적으로 다시 본다.
            now = time.time()
            if now - checked_at >= RECHECK_SECONDS:
                checked_at = now
                if _verify(_cookie_token(cookie_header)) != user:
                    await ws.close(code=4403, reason="session expired")
                    break
            if isinstance(msg, bytes):
                await write_all(msg)
            else:
                try:
                    obj = json.loads(msg)
                except Exception:
                    await write_all(msg.encode())
                    continue
                if isinstance(obj, dict) and "resize" in obj:
                    # 형식이 어긋난 메시지 하나로 셸이 끊기면 안 된다.
                    try:
                        cols, rows = obj["resize"]
                        size = struct.pack("HHHH", int(rows), int(cols), 0, 0)
                    except (TypeError, ValueError, struct.error, OverflowError):
                        continue
                    try:
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
                    except OSError:
                        continue
    except websockets.ConnectionClosed:
        pass
    finally:
        try:
            loop.remove_reader(fd)
        except Exception:
            pass
        closed.set()
        out_task.cancel()
        watch_task.cancel()
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
