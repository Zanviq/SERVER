"""사람마다 몇 개·서버 전체 몇 개까지 — 자리 세기 하나.

AI 답 만들기(ai_lanes)와 zip 만들기(archive)가 같은 모양의 세기를 따로 적었다. 따로 적으면 한쪽만
"두 번 놓으면 두 번 뺀다" 같은 구멍을 갖게 된다(archive 의 첫 판이 그랬다 — ai_lanes 는 이미 한 번만 놓이는
함수를 돌려줬다). 잡으면 **한 번만 놓이는** 함수를 준다.
"""
from __future__ import annotations

import threading
from collections.abc import Callable

from fastapi import HTTPException


class Slots:
    """per_user() 개(사람마다)·total 개(전체)까지. 넘치면 429(사람)·503(전체).

    per_user 는 부를 때마다 읽는다 — 모듈 상수를 시험·운영 설정이 바꿀 수 있게.
    busy(n) 은 그 사람이 이미 n 개를 쥐고 있을 때의 말, full 은 전체가 찼을 때의 말.
    """

    def __init__(self, per_user: Callable[[], int], busy: Callable[[int], str], *,
                 total: int | None = None, full: str = "") -> None:
        self._per_user = per_user
        self._busy = busy
        self._total = total
        self._full = full
        self._held: dict[str, int] = {}
        self._lock = threading.Lock()

    def held(self, owner: str) -> int:
        with self._lock:
            return self._held.get(owner, 0)

    def claim(self, owner: str) -> Callable[[], None]:
        with self._lock:
            n = self._held.get(owner, 0)
            if n >= self._per_user():
                raise HTTPException(status_code=429, detail=self._busy(n))
            if self._total is not None and sum(self._held.values()) >= self._total:
                raise HTTPException(status_code=503, detail=self._full)
            self._held[owner] = n + 1
        done = False

        def release() -> None:
            nonlocal done
            with self._lock:
                if done:
                    return
                done = True
                left = self._held.get(owner, 1) - 1
                if left > 0:
                    self._held[owner] = left
                else:
                    self._held.pop(owner, None)

        return release
