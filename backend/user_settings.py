"""사용자별 설정 — users/<u>/settings.json. 기본값 위에 병합."""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

from . import json_store
from .auth import SessionUser
from .config import Settings

DEFAULTS: dict[str, Any] = {
    "ai": {
        "tone": "assistant",  # counselor | assistant | friend
        "max_steps": 8,
        "model": "",  # 빈 값 = 서버 기본(GEMINI_MODEL). 설정 화면에서 고른다.
    },
    "calendar": {
        "default_color": "2",
        "default_view": "dayGridMonth",  # dayGridMonth | timeGridWeek | timeGridDay
        "week_start": 0,  # 0=일요일
        "default_remind": 0,  # AI 일정 기본 알림(분, 0=없음)
        "ai_rules": "",  # AI가 일정 생성/수정 때 항상 적용할 필수 규칙(예: 동아리는 보라색)
    },
    "notes": {
        "autosave_ms": 900,
        "confirm_delete": True,
    },
    "display": {
        "show_seconds_in_timer": True,
    },
    "security": {
        "session_ttl_minutes": 60,  # 세션 자동 로그아웃(무활동 시 만료). 5분~30일.
    },
}


def _path(user: SessionUser, settings: Settings) -> Path:
    base = settings.user_root(user.username)
    base.mkdir(parents=True, exist_ok=True)
    return base / "settings.json"


def _deep_merge(base: dict, patch: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load(user: SessionUser, settings: Settings) -> dict:
    stored = json_store.read_json(_path(user, settings), {})
    if not isinstance(stored, dict):
        stored = {}
    # 예전 버전이 남긴 이상한 값(섹션이 dict 가 아님 등)도 여기서 흘려보낸다 —
    # 읽기가 죽으면 그 계정은 로그인조차 못 한다.
    stored = {k: v for k, v in stored.items() if isinstance(v, dict)}
    return _prune(_deep_merge(DEFAULTS, stored))


def _prune(merged: dict) -> dict:
    """DEFAULTS에 없는 최상위 키를 버린다.

    _deep_merge는 저장된 여분 키를 그대로 보존하므로, 기능이 사라져도(예: 로컬 연동)
    죽은 설정이 영원히 남아 계속 내려간다. 저장 시점에 정리한다.
    """
    return {k: v for k, v in merged.items() if k in DEFAULTS}


def _coerce(section: str, key: str, value: Any, fallback: Any) -> Any:
    """저장해도 되는 값으로 맞춘다. 못 맞추면 기본값.

    예전에는 아무 값이나 그대로 저장했다. `{"ai": 1}` 처럼 섹션을 스칼라로 넣으면
    다음 load 에서 _deep_merge 가 dict 를 기대하다 어긋나고, 그 계정은 설정을 읽는
    모든 요청(로그인 포함)이 영구히 500 이 됐다 — 스스로 되돌릴 방법도 없다.
    """
    if isinstance(fallback, bool):
        return bool(value)
    if isinstance(fallback, int):
        try:
            n = int(value)
        except (TypeError, ValueError):
            return fallback
        rng = _RANGES.get((section, key))
        return min(max(n, rng[0]), rng[1]) if rng else n
    if isinstance(fallback, str):
        if not isinstance(value, (str, int, float)):
            return fallback
        text = str(value)
        allowed = _CHOICES.get((section, key))
        if allowed and text not in allowed:
            return fallback
        return text[:_MAX_TEXT]
    return fallback


#: 숫자 설정의 허용 범위 — 화면에서 막아도 API 로는 아무 값이나 들어온다.
_RANGES: dict[tuple[str, str], tuple[int, int]] = {
    ("ai", "max_steps"): (1, 16),
    ("calendar", "week_start"): (0, 6),
    ("calendar", "default_remind"): (0, 40320),   # 최대 4주 전
    ("notes", "autosave_ms"): (300, 60_000),
    ("security", "session_ttl_minutes"): (5, 43_200),  # 5분 ~ 30일
}
#: 정해진 값만 받는 설정
_CHOICES: dict[tuple[str, str], set[str]] = {
    ("ai", "tone"): {"counselor", "assistant", "friend"},
    ("calendar", "default_view"): {"dayGridMonth", "timeGridWeek", "timeGridDay"},
    ("calendar", "default_color"): {str(i) for i in range(1, 12)},
}
#: 자유 입력 문자열의 길이 상한(AI 규칙 등)
_MAX_TEXT = 2000


def sanitize(changes: dict) -> dict:
    """들어온 변경분을 DEFAULTS 의 모양·타입에 맞춰 걸러 낸다."""
    out: dict[str, Any] = {}
    for section, values in (changes or {}).items():
        base = DEFAULTS.get(section)
        if not isinstance(base, dict) or not isinstance(values, dict):
            continue  # 모르는 섹션이거나 섹션이 dict 가 아니다 — 통째로 버린다
        clean = {k: _coerce(section, k, v, base[k]) for k, v in values.items() if k in base}
        if clean:
            out[section] = clean
    return out


def patch(user: SessionUser, settings: Settings, changes: dict) -> dict:
    p = _path(user, settings)
    with json_store.lock_for(p):
        merged = _prune(_deep_merge(load(user, settings), sanitize(changes)))
        json_store.write_atomic(p, merged)
    return merged


def get_session_ttl(username: str, settings: Settings) -> int:
    """사용자가 설정한 세션 TTL(초). 로그인 시 토큰 만료 기준으로 사용."""
    from .auth import SessionUser, clamp_ttl
    u = SessionUser(username=username, display_name="", expires_at=0, remaining=0)
    mins = load(u, settings).get("security", {}).get("session_ttl_minutes", 60)
    try:
        seconds = int(float(mins) * 60)
    except (TypeError, ValueError):
        seconds = settings.session_ttl
    return clamp_ttl(seconds, settings)
