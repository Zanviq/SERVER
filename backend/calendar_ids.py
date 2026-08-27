"""반복 일정 id 규칙 — 한 곳에서만 정한다.

인스턴스 id 형식이 백엔드마다 다르다.
  내부 캘린더 : `시리즈@YYYY-MM-DD`
  구글 캘린더 : `시리즈_YYYYMMDD` 또는 `시리즈_YYYYMMDDTHHMMSSZ`

이 규칙이 세 군데에 따로 적혀 있었고(스킬·서비스·저장소), 서비스 계층은 `@`만
알아서 구글 인스턴스 id를 그대로 넘겼다. 그래서 일괄 삭제가 시리즈가 아니라
회차 하나만 지우고, 돌려받은 id가 안 맞아 "0개 삭제, 1개 실패"로 보고했다.
모델은 실패로 알고 재시도해 회차를 하나씩 갉아먹었다.
"""
from __future__ import annotations

import re

# 구글 이벤트 id는 base32hex(a-v, 0-9)라 `_`가 들어가지 않으므로 이 분리는 안전하다.
_GOOGLE_INSTANCE = re.compile(r"^(?P<base>[^_@]+)_\d{8}(T\d{6}Z)?$")


def base_id(eid: str) -> str:
    """인스턴스 id에서 시리즈 id만 뽑는다. 두 형식을 모두 처리한다."""
    s = str(eid)
    if "@" in s:
        return s.split("@", 1)[0]
    m = _GOOGLE_INSTANCE.match(s)
    return m.group("base") if m else s


def is_instance(eid: str) -> bool:
    """반복 일정의 특정 회차를 가리키는 id인가."""
    return base_id(eid) != str(eid)
