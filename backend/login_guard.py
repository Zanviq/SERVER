"""로그인 시도 제한 — 비밀번호 무차별 대입을 실용적으로 불가능하게 만든다.

이 서버는 도메인으로 외부에 열려 있고, 로그인은 아이디+비밀번호 하나뿐이다.
제한이 없으면 초당 수십 번씩 계속 찔러 볼 수 있다(실제로 30회 연속 시도해도
아무 저항이 없었다). pbkdf2 반복이 시간을 조금 벌어 주긴 하지만, 그건 서버
CPU도 같이 태우는 것이라 방어라고 부를 수 없다.

**아이디 + 보낸 사람의 IP 로 센다.** 아이디만으로 세면 방어 수단이 그대로
공격 수단이 된다 — 아이디만 아는 사람이 잠금이 풀릴 때마다 5번씩 틀리는 것을
반복하면 대기시간이 상한에 눌러앉고, 잠긴 동안에는 올바른 비밀번호도 거절되므로
**주인이 자기 서버에 영영 못 들어온다**(실측으로 재현했다). 아이디+IP 로 세면
공격자는 자기 IP 만 잠그고, 주인은 다른 회선에서 그대로 들어온다.

IP 는 nginx 가 `X-Client-IP` 로 넘겨준다. 그 값은 클라우드플레어가 터널에서
덮어쓰는 `CF-Connecting-IP`(없으면 nginx 가 본 주소)이고, nginx 의
`proxy_set_header` 가 들어온 헤더를 **덮어쓰므로** 바깥에서 지어낼 수 없다.
헤더가 아예 없으면(직접 호출·테스트) 아이디만으로 센다.

한 IP 가 아이디를 바꿔 가며 두드리는 것은 MAX_KEYS 상한이 받아 낸다.
잠금은 30초에서 시작해 최대 10분까지만 늘린다.
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
# 열쇠로 삼을 아이디 길이의 상한. 로그인 요청의 아이디에는 길이 제한이 없어서
# (계정 규칙 3~32자는 가입에만 걸린다) 수 MB 짜리 문자열을 보낼 수 있고, 그게
# 그대로 열쇠가 되면 창(15분) 동안 메모리에 눌러앉는다. 잘라서 담는다 —
# 어차피 실제 계정 아이디는 32자를 넘지 않으므로 정상 사용자에겐 영향이 없다.
MAX_KEY_CHARS = 64


@dataclass
class _State:
    fails: int = 0      # 이번 창에서 확인된 실패 수
    inflight: int = 0   # 결과를 아직 모르는 진행 중 시도
    locks: int = 0      # 지금까지 몇 번 잠갔는지(해제된 뒤에도 남는다)
    seen: float = 0.0   # 마지막으로 움직인 시각(정리 기준)
    until: float = 0.0  # 이 시각까지는 시도 자체를 받지 않는다
    probed: bool = False  # 이번 잠금 동안 비밀번호를 한 번 확인해 줬는가


_states: dict[str, _State] = {}
_lock = threading.Lock()


def _prune(now: float) -> None:
    """창을 넘긴 기록을 버린다. 그래도 넘치면 오래된 것부터 버린다.

    **잠겨 있는 항목은 버리지 않는다.** 버리면 잠금과 실패 횟수가 함께 사라져,
    아이디를 바꿔 가며 4096개를 채우는 것만으로 잠금을 풀 수 있다.
    """
    stale = [k for k, s in _states.items() if now - s.seen > WINDOW and now >= s.until]
    for k in stale:
        del _states[k]
    if len(_states) > MAX_KEYS:
        # 한 번에 여유분까지 비운다. 상한에 딱 맞춰 버리면 그 뒤로 기록이 하나
        # 들어올 때마다 4096개를 정렬하게 되어, 방어하려던 대상에게 오히려
        # CPU 를 내주는 꼴이 된다.
        target = max(1, MAX_KEYS * 3 // 4)
        droppable = sorted(
            ((k, s) for k, s in _states.items() if now >= s.until),
            key=lambda kv: kv[1].seen,
        )
        for k, _ in droppable[: max(0, len(_states) - target)]:
            del _states[k]


def _key(username: str, client_ip: str = "") -> str:
    """세는 단위. 아이디만으로 세면 아이디를 아는 사람이 주인을 잠글 수 있다."""
    who = (username or "").strip().lower()[:MAX_KEY_CHARS]
    ip = (client_ip or "").strip()[:MAX_KEY_CHARS]
    return f"{who}|{ip}" if ip else who


def _delay_for(locks: int) -> int:
    """몇 번째 잠금인지에 따른 대기 시간. 30초에서 두 배씩, 상한에서 멈춘다."""
    return int(min(FIRST_DELAY * 2 ** max(0, locks - 1), MAX_DELAY))


def retry_after(username: str, now: float | None = None, client_ip: str = "") -> int:
    """지금 시도할 수 있으면 0, 막혀 있으면 남은 초(올림). 상태를 바꾸지 않는다."""
    now = time.time() if now is None else now
    with _lock:
        s = _states.get(_key(username, client_ip))
        if s is None or now >= s.until:
            return 0
        return max(1, int(s.until - now + 0.999))


def begin_attempt(username: str, now: float | None = None, client_ip: str = "") -> int:
    """시도 하나를 '진행 중'으로 잡는다. 막혀 있으면 남은 초.

    **막을지 말지는 여기서만 정한다.** 확인과 기록이 갈라져 있으면, 동시에 들어온
    요청이 전부 확인을 통과한 뒤 각자 비밀번호를 검증한다 — 5회 제한이 사실상
    '동시 요청 수만큼' 늘어난다. 그래서 아직 결과를 모르는 시도(inflight)까지
    합쳐서 세고, 한도에 닿으면 그 자리에서 잠근다.
    """
    now = time.time() if now is None else now
    key = _key(username, client_ip)
    with _lock:
        _prune(now)
        s = _states.get(key)
        if s is None or (now - s.seen > WINDOW and now >= s.until):
            s = _State()
            _states[key] = s

        if now < s.until:
            return max(1, int(s.until - now + 0.999))
        if s.until:
            # 잠금이 방금 풀렸다. 표시만 지운다 — 실패 수는 **잠글 때** 이미 비웠다.
            # (여기서 한 번 더 비우는 코드가 있었는데 아무 일도 하지 않았다.
            #  돌연변이 검사에서 '지워도 아무 테스트가 안 깨진다'로 드러났다.)
            s.until = 0.0

        if s.fails + s.inflight >= FREE_TRIES:
            s.locks += 1
            s.fails = 0
            s.probed = False  # 새 잠금 = 확인 기회도 새로 하나
            s.until = now + _delay_for(s.locks)
            s.seen = now
            return _delay_for(s.locks)

        s.inflight += 1
        s.seen = now
        return 0


def allow_probe(username: str, now: float | None = None, client_ip: str = "") -> bool:
    """잠겨 있어도 **이번 잠금에 한 번은** 비밀번호를 확인해 준다.

    부르는 쪽은 잠긴 상태(begin_attempt 가 0이 아닌 값을 준 뒤)에서만 쓴다.
    True 를 받으면 비밀번호를 검증해도 된다 — 맞으면 들여보내고(record_success
    가 기록을 지운다), 틀리면 429 로 돌려보낸다.

    기회를 쓰는 것과 세는 것을 한 락 안에서 한다 — 나누면 동시에 들어온 요청이
    모두 True 를 받아 잠금이 그 수만큼 뚫린다.
    """
    now = time.time() if now is None else now
    with _lock:
        s = _states.get(_key(username, client_ip))
        if s is None or now >= s.until:
            return True  # 애초에 잠겨 있지 않다
        if s.probed:
            return False
        s.probed = True
        s.seen = now
        return True


def end_attempt(username: str, client_ip: str = "") -> None:
    """진행 중 표시를 거둔다(성공·실패 어느 쪽이든 반드시 부른다)."""
    with _lock:
        s = _states.get(_key(username, client_ip))
        if s is not None and s.inflight > 0:
            s.inflight -= 1


def record_failure(username: str, now: float | None = None, client_ip: str = "") -> None:
    """실패를 센다. **여기서는 잠그지 않는다.**

    잠그는 판단은 begin_attempt 한 곳에서만 한다 — 두 곳에서 정하면 규칙이
    갈라진다(실제로 5번째 실패가 401 대신 429가 되어 있었다).
    """
    now = time.time() if now is None else now
    with _lock:
        s = _states.get(_key(username, client_ip))
        if s is None:
            s = _State()
            _states[_key(username, client_ip)] = s
        s.fails += 1
        s.seen = now


def record_success(username: str, client_ip: str = "") -> None:
    """제대로 들어왔으면 기록을 지운다 — 다음 오타부터 다시 센다."""
    with _lock:
        _states.pop(_key(username, client_ip), None)


def reset() -> None:
    """테스트용 — 프로세스 안에 남은 기록을 전부 지운다."""
    with _lock:
        _states.clear()
