"""일정 목록을 잠깐 담아 둔다 — 전체 검색과 링크 후보가 함께 쓴다.

일정은 저장소가 둘이다 — 내부 JSON 이거나 구글이다. `calendar_store` 만 보면
구글을 쓰는 사용자에게는 늘 0건이 된다(실제로 그렇게 짰다가 걸렸다). 그래서
서비스 계층을 거치되, 구글이면 호출이 요금·지연을 부르므로 잠깐 재사용한다.
검색과 링크 후보는 타자마다 불리기 때문이다.

예전에는 이 캐시가 search_all 안에 있었는데 링크 모듈도 그것을 빌려 썼다. 두
쓰는 곳의 한가운데로 옮겨, 캐시의 규칙(얼마나 담아 두나)이 한 곳에 있게 한다.
"""
from __future__ import annotations

import datetime
import time

from .auth import SessionUser
from .config import Settings

#: 사용자 이름 → (받은 시각, 일정 목록)
_CACHE: dict[str, tuple[float, list[dict]]] = {}
TTL = 30.0     # 초. 타자 한 번에 구글을 한 번씩 두드리지 않기 위한 것뿐이다.
WINDOW = 365   # 일. 앞뒤로 이만큼만 본다(반복 일정이 무한히 펼쳐진다).


def events(user: SessionUser, settings: Settings) -> list[dict]:
    """오늘 앞뒤 1년치 일정. TTL 동안은 같은 것을 돌려준다."""
    from . import calendar_service

    now = time.time()
    hit = _CACHE.get(user.username)
    if hit and now - hit[0] < TTL:
        return hit[1]
    today = datetime.date.today()
    span = datetime.timedelta(days=WINDOW)
    found = calendar_service.list_events(
        user, settings, (today - span).isoformat(), (today + span).isoformat())
    _CACHE[user.username] = (now, found)
    return found


def warm(user: SessionUser) -> list[dict] | None:
    """받아 둔 일정이 아직 쓸 만하면 그것, 아니면 None(구글에 묻지 않는다)."""
    hit = _CACHE.get(user.username)
    return hit[1] if hit and time.time() - hit[0] < TTL else None
