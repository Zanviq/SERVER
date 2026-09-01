"""로그인 시도 제한 — 비밀번호 무차별 대입을 실용적으로 불가능하게 만든다.

이 서버는 도메인으로 외부에 열려 있고, 로그인은 아이디+비밀번호 하나뿐이다.
제한이 없으면 초당 수십 번씩 계속 찔러 볼 수 있다(실제로 30회 연속 시도해도
아무 저항이 없었다). pbkdf2 반복이 시간을 조금 벌어 주긴 하지만, 그건 서버
CPU도 같이 태우는 것이라 방어라고 부를 수 없다.

**아이디 기준으로만 센다.** IP 기준이 흔한 방식이지만 여기선 못 쓴다 —
요청은 Cloudflare 터널 → nginx → 백엔드로 들어오므로 백엔드가 보는 주소는
항상 nginx 하나다. X-Forwarded-For를 믿으면 헤더를 지어내서 우회할 수 있고,
반대로 그 값 하나에 모두를 묶으면 공격자 한 명이 전원을 잠글 수 있다.

대신 아이디를 아는 사람이 그 계정을 잠깐 잠글 수 있다는 약점이 남는다.
그래서 잠금은 30초에서 시작해 최대 10분까지만 늘린다 — 무차별 대입은 막되
주인이 오래 갇히지는 않게.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass

# 사람이 흔히 내는 오타 — 이 횟수까지는 벌하지 않는다.
FREE_TRIES = 5
# 실패 기록이 살아 있는 시간. 이만큼 조용하면 처음부터 다시 센다.
WINDOW = 15 * 60
# 처음 걸렸을 때 기다리는 시간, 그리고 상한.
FIRST_DELAY = 30
MAX_DELAY = 10 * 60
# 아이디를 바꿔 가며 두드리면 기록이 사전만큼 쌓인다 — 상한을 둔다.
MAX_KEYS = 4096


@dataclass
class _State:
    fails: int = 0
    seen: float = 0.0   # 마지막으로 움직인 시각(정리 기준)
    until: float = 0.0  # 이 시각까지는 시도 자체를 받지 않는다


_states: dict[str, _State] = {}
_lock = threading.Lock()


def _prune(now: float) -> None:
    """창을 넘긴 기록을 버린다. 그래도 넘치면 오래된 것부터 버린다."""
    stale = [k for k, s in _states.items() if now - s.seen > WINDOW and now >= s.until]
    for k in stale:
        del _states[k]
    if len(_states) > MAX_KEYS:
        for k, _ in sorted(_states.items(), key=lambda kv: kv[1].seen)[: len(_states) - MAX_KEYS]:
            del _states[k]


def _key(username: str) -> str:
    return (username or "").strip().lower()


def retry_after(username: str, now: float | None = None) -> int:
    """지금 시도할 수 있으면 0, 막혀 있으면 남은 초(올림)."""
    now = time.time() if now is None else now
    with _lock:
        s = _states.get(_key(username))
        if s is None or now >= s.until:
            return 0
        return max(1, int(s.until - now + 0.999))


def record_failure(username: str, now: float | None = None) -> int:
    """실패를 세고, 잠겼다면 잠금 시간(초)을 돌려준다."""
    now = time.time() if now is None else now
    with _lock:
        _prune(now)
        s = _states.get(_key(username))
        if s is None or now - s.seen > WINDOW:
            s = _State()
            _states[_key(username)] = s
        s.fails += 1
        s.seen = now
        if s.fails <= FREE_TRIES:
            return 0
        # 6번째 실패 = 30초, 그다음부터 두 배씩. 상한에서 멈춘다.
        delay = min(FIRST_DELAY * 2 ** (s.fails - FREE_TRIES - 1), MAX_DELAY)
        s.until = now + delay
        return delay


def record_success(username: str) -> None:
    """제대로 들어왔으면 기록을 지운다 — 다음 오타부터 다시 센다."""
    with _lock:
        _states.pop(_key(username), None)


def reset() -> None:
    """테스트용 — 프로세스 안에 남은 기록을 전부 지운다."""
    with _lock:
        _states.clear()
