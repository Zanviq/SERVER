"""로그아웃한 세션 토큰을 **만료까지** 거절한다.

세션 토큰은 서명만 된 상태 없는 토큰이다(auth.issue_token). 예전에는 로그아웃이 브라우저의
쿠키만 지워서, 그 전에 복사된 토큰(확장 프로그램·함께 쓰는 컴퓨터·새어 나간 기록)은 만료될
때까지 그대로 통했다 — 로그아웃한 뒤에도 문서 목록이 200 으로 열렸다(19차 실측).

로그아웃할 때 그 토큰의 해시를 만료 시각과 함께 적어 두고, 검증할 때 본다. 토큰 원문은
남기지 않는다. 만료가 지난 것은 다음에 쓸 때 걸러 내므로 목록은 '지금 살아 있을 수 있는
로그아웃한 토큰' 만큼만 크다. 파일에 두는 것은 배포마다 컨테이너가 다시 뜨기 때문이다.
그 기기 하나만 로그아웃된다(다른 기기의 세션은 그대로).
"""
from __future__ import annotations

import hashlib
import threading
import time

from . import json_store
from .config import Settings

_lock = threading.Lock()
_cache: dict[str, float] = {}
_seen_mtime: float | None = None


def _path(settings: Settings):
    return settings.storage_root / "revoked_sessions.json"


def _key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _current(settings: Settings) -> dict[str, float]:
    """파일이 바뀌었을 때만 다시 읽는다(검증은 요청마다 불린다)."""
    global _cache, _seen_mtime
    p = _path(settings)
    try:
        mtime = p.stat().st_mtime
    except OSError:
        mtime = 0.0
    with _lock:
        if mtime != _seen_mtime:
            raw = json_store.read_json(p, {})
            _cache = ({str(k): float(v) for k, v in raw.items() if isinstance(v, (int, float))}
                      if isinstance(raw, dict) else {})
            _seen_mtime = mtime
        return _cache


def revoke(token: str, until: float, settings: Settings) -> None:
    """이 토큰을 until(만료 시각)까지 거절한다."""
    global _cache, _seen_mtime
    p = _path(settings)
    with json_store.lock_for(p):
        now = time.time()
        live = {k: v for k, v in _current(settings).items() if v > now}
        live[_key(token)] = float(until)
        json_store.write_atomic(p, live)
        with _lock:
            _cache = live
            try:
                _seen_mtime = p.stat().st_mtime
            except OSError:
                _seen_mtime = None


def is_revoked(token: str, settings: Settings) -> bool:
    until = _current(settings).get(_key(token))
    return until is not None and until > time.time()
