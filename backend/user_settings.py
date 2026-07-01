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
    },
    "calendar": {
        "default_color": "2",
        "default_view": "dayGridMonth",  # dayGridMonth | timeGridWeek | timeGridDay
        "week_start": 0,  # 0=일요일
    },
    "notes": {
        "default_scope": "me",  # common | me
        "autosave_ms": 900,
    },
    "files": {
        "default_scope": "common",
        "confirm_delete": True,
    },
    "sync": {
        # 텍스트/md 충돌 시 기본 동작: ask | local | web | merge
        "text_conflict": "ask",
        # 바이너리(.pdf/.png 등) 충돌 시: local | web
        "binary_policy": "local",
    },
    "display": {
        "show_seconds_in_timer": True,
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
    return _deep_merge(DEFAULTS, stored if isinstance(stored, dict) else {})


def patch(user: SessionUser, settings: Settings, changes: dict) -> dict:
    p = _path(user, settings)
    with json_store.lock_for(p):
        merged = _deep_merge(load(user, settings), changes)
        json_store.write_atomic(p, merged)
    return merged
