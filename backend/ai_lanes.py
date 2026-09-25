"""AI 차례가 모델을 기다리는 자리 — 다른 화면이 쓰는 스레드와 떼어 둔다.

대화(/api/ai/chat)는 동기 생성기를 StreamingResponse 로 흘린다. Starlette 는 그런 생성기의
조각 하나하나를 **공용 스레드 풀**(기본 40)에서 꺼내는데, 조각 하나를 꺼내는 동안 모델의
답을 기다린다(수 초~수십 초). 그래서 AI 차례가 40개쯤 동시에 돌면 문서 목록·저장처럼
동기로 도는 화면 **전부**가 스레드를 못 얻어 멈췄다 — 22차 실측(가짜 느린 모델): AI 45개가
도는 동안 /api/notes/list 가 29ms → 13,139ms. 한 사람이 탭을 여러 개 열거나 스크립트로
보내면 서버 전체가 선다.

- 조각은 Starlette 와 **같은 방식**(anyio.to_thread.run_sync)으로 꺼내되 AI 전용 한도
  (STREAMS)를 쓴다. 공용 한도의 몫을 쓰지 않으므로 AI 가 아무리 밀려도 다른 화면은 돈다.
  넘친 차례는 거절하지 않고 자리가 날 때까지 기다린다.
- 한 사람이 한꺼번에 기다릴 수 있는 차례는 PER_USER 개. 넘으면 429 로 까닭을 말한다 —
  한 사람이 AI 자리를 다 차지하면 다른 사람의 차례가 몇 분씩 밀리고, 모델 비용은 서버
  주인의 키로 나간다.
- 생성기를 닫는 방식은 그대로다(끊기면 버려질 때 닫혀 finally 가 받은 데까지 남긴다).
"""
from __future__ import annotations

import logging
import threading
import weakref
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import contextmanager

import anyio
import anyio.to_thread

from .slots import Slots

logger = logging.getLogger(__name__)

#: 서버 전체에서 동시에 모델을 기다릴 수 있는 AI 차례 수(넘치면 줄을 선다). 스레드는 거의
#: 네트워크를 기다리며 놀고 있으므로 이만큼은 파이에서도 가볍다.
STREAMS = 16
#: 한 사람이 한꺼번에 기다릴 수 있는 AI 차례 수(넘치면 429). 영어 튜터·논문·회의·비서를
#: 탭 여러 개에 열어 두고 동시에 묻는 정도(동시성 시험이 한 사람당 6개를 보낸다)는 받는다.
PER_USER = 6

_limiter: anyio.CapacityLimiter | None = None
# 멈춘 차례도 모델이 끝날 때까지는 자리를 쓴다(모델은 이미 일하는 중이다) — 방금 멈췄는데 왜 막히는지
# 모르지 않게 그 말도 한다. PER_USER 는 부를 때마다 읽는다(시험·느린 모델 하네스가 바꾼다).
_slots = Slots(
    lambda: PER_USER,
    lambda n: (f"AI 가 아직 앞의 답 {n}개를 만들고 있습니다(멈춘 것도 끝날 때까지는 "
               "자리를 씁니다). 잠시 뒤 다시 보내 주세요."),
)


def _lane() -> anyio.CapacityLimiter:
    # 이벤트 루프 안에서 만들어야 한다(anyio 가 지금 도는 백엔드를 보고 만든다).
    global _limiter
    if _limiter is None:
        _limiter = anyio.CapacityLimiter(STREAMS)
    return _limiter


def inflight(username: str) -> int:
    return _slots.held(username)


def claim(username: str) -> Callable[[], None]:
    """한 사람 몫을 하나 잡는다. 넘치면 429. 돌려준 함수로 놓는다(여러 번 불러도 한 번만)."""
    return _slots.claim(username)


class _End(Exception):
    """생성기가 끝났다 — StopIteration 은 스레드 경계를 넘기지 못해 바꿔 던진다."""


def _next(it: Iterator[str]) -> str:
    try:
        return next(it)
    except StopIteration:
        raise _End from None


async def _stream(it: Iterator[str], release: Callable[[], None]) -> AsyncIterator[str]:
    try:
        while True:
            try:
                chunk = await anyio.to_thread.run_sync(_next, it, limiter=_lane())
            except _End:
                return
            yield chunk
    finally:
        release()


#: 무거운 뒷일(논문 추출·회의 받아쓰기)을 서버 전체에서 동시에 몇 개까지 돌리나. 넘친 것은
#: '처리 중'인 채 줄을 선다(화면은 상태를 되물어 볼 뿐 포기 시한이 없다).
HEAVY_JOBS = 2
_heavy = threading.BoundedSemaphore(HEAVY_JOBS)


@contextmanager
def heavy_job() -> Iterator[None]:
    """원본을 통째로 읽어 모델에 싣는 일의 자리 하나.

    논문 추출은 PDF(최대 100MB)를, 받아쓰기는 녹음을 **통째로** 읽고 요청에 싣느라 부풀린다.
    올린 것마다 곧바로 스레드를 띄우던 때는 여러 편을 한꺼번에 올리면 전부가 동시에 돌았다 —
    23차 실측: 31.5MB 논문 12편 → 서버 메모리 53MB → 1,166MB. 파이는 다른 서비스와 메모리를
    나눠 쓴다. 자리를 기다리는 스레드는 가볍다(아무것도 읽지 않고 멈춰 있다).
    """
    with _heavy:
        yield


class HeavyJobs:
    """항목마다 하나씩만 도는 무거운 뒷일 — 논문 추출과 회의 받아쓰기가 같은 모양이라 한 벌로.

    - 같은 항목을 두 번 세우지 않는다. 자리를 기다리는 것도 '도는 중'이다.
    - 도는 것은 서버 전체에서 HEAVY_JOBS 개씩(heavy_job).
    - 일이 예외로 끝나면 on_fail 로 항목에 까닭을 남긴다 — 상태가 '처리 중'에 멈춰 있지 않게.
    """

    def __init__(self, what: str):
        self._what = what
        self._running: set[tuple[str, str]] = set()
        self._guard = threading.Lock()

    def start(self, key: tuple[str, str], thread_name: str,
              work: Callable[[], object], on_fail: Callable[[], object]) -> bool:
        """뒷일을 세운다. 이미 서 있으면 False."""
        with self._guard:
            if key in self._running:
                return False
            self._running.add(key)

        def worker() -> None:
            try:
                with heavy_job():
                    work()
            except Exception:  # noqa: BLE001
                logger.exception("%s 스레드 실패: %s", self._what, key[1])
                try:
                    on_fail()
                except Exception:  # noqa: BLE001
                    pass
            finally:
                with self._guard:
                    self._running.discard(key)

        threading.Thread(target=worker, name=thread_name, daemon=True).start()
        return True

    def is_running(self, key: tuple[str, str]) -> bool:
        with self._guard:
            return key in self._running


def streaming(it: Iterator[str], username: str) -> AsyncIterator[str]:
    """동기 생성기를 AI 자리에서 흘리는 비동기 반복자로. 사람 몫은 여기서 잡는다(넘치면 429).

    응답이 한 번도 돌지 못하고 버려져도(보내기 전에 끊긴 연결) 몫을 돌려준다 — finally 는
    시작한 비동기 생성기에서만 돈다.
    """
    release = claim(username)
    agen = _stream(it, release)
    weakref.finalize(agen, release)
    return agen
