"""기록(일기·상태) 저장소 — 캘린더의 '기록' 모드가 쓴다.

users/<u>/diary/diary.json
  {days: {"YYYY-MM-DD": {body, heart, mind, text, updated_at}}}

body/heart/mind(육체/마음/정신)는 도형 이름 하나이거나 빈 문자열:
  star(매우 좋음) · circle(좋음) · triangle(보통) · square(힘듦) · pentagon(매우 힘듦)
비어 있으면 "표시하지 않음" — 캘린더 칸에서 '-' 로 나온다.
세 축과 일기가 모두 비면 그 날짜는 통째로 지운다(칸에 아무것도 안 보여야 한다).
"""
from __future__ import annotations

import re
import time
from datetime import date

from fastapi import HTTPException

from . import json_store
from .auth import SessionUser
from .config import Settings

SHAPES = ("star", "circle", "triangle", "square", "pentagon")
AXES = ("body", "heart", "mind")
MAX_TEXT = 20000
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _path(user: SessionUser, settings: Settings):
    base = settings.user_root(user.username) / "diary"
    base.mkdir(parents=True, exist_ok=True)
    return base / "diary.json"


def _load(user: SessionUser, settings: Settings) -> dict[str, dict]:
    data = json_store.read_json_strict(_path(user, settings), None)
    if not isinstance(data, dict):
        return {}
    days = data.get("days")
    if not isinstance(days, dict):
        return {}
    return {k: v for k, v in days.items() if isinstance(k, str) and isinstance(v, dict)}


def _save(days: dict[str, dict], user: SessionUser, settings: Settings) -> None:
    json_store.write_atomic(_path(user, settings), {"days": days})


def check_date(s: str) -> str:
    s = str(s or "").strip()
    if not _DATE.match(s):
        raise HTTPException(status_code=400, detail="날짜는 YYYY-MM-DD 형식이어야 합니다.")
    try:
        date.fromisoformat(s)
    except ValueError:
        raise HTTPException(status_code=400, detail="없는 날짜입니다.")
    return s


def _shape(v) -> str:
    s = str(v or "").strip().lower()
    if s and s not in SHAPES:
        raise HTTPException(status_code=400, detail="도형은 star/circle/triangle/square/pentagon 중 하나입니다.")
    return s


def _entry(day: str, raw: dict) -> dict:
    return {
        "date": day,
        "body": raw.get("body") if raw.get("body") in SHAPES else "",
        "heart": raw.get("heart") if raw.get("heart") in SHAPES else "",
        "mind": raw.get("mind") if raw.get("mind") in SHAPES else "",
        "text": str(raw.get("text") or "")[:MAX_TEXT],
        "updated_at": float(raw.get("updated_at") or 0),
    }


def empty(day: str) -> dict:
    return {"date": day, "body": "", "heart": "", "mind": "", "text": "", "updated_at": 0.0}


def get_day(user: SessionUser, settings: Settings, day: str) -> dict:
    day = check_date(day)
    raw = _load(user, settings).get(day)
    return _entry(day, raw) if raw else empty(day)


def list_range(user: SessionUser, settings: Settings, start: str, end: str) -> list[dict]:
    """[start, end] 안의 기록. 캘린더 한 화면(6주)치를 한 번에 받는다."""
    start, end = check_date(start), check_date(end)
    if end < start:
        start, end = end, start
    days = _load(user, settings)
    out = [_entry(d, v) for d, v in days.items() if start <= d <= end]
    out.sort(key=lambda e: e["date"])
    return out


def save_day(user: SessionUser, settings: Settings, day: str, patch: dict) -> dict:
    """부분 수정. 준 필드만 바꾸고, 결과가 전부 비면 그 날짜를 지운다."""
    day = check_date(day)
    p = _path(user, settings)
    with json_store.lock_for(p):
        days = _load(user, settings)
        cur = _entry(day, days.get(day) or {})
        for axis in AXES:
            if axis in patch and patch[axis] is not None:
                cur[axis] = _shape(patch[axis])
        if "text" in patch and patch["text"] is not None:
            cur["text"] = str(patch["text"])[:MAX_TEXT]
        if not any(cur[a] for a in AXES) and not cur["text"].strip():
            days.pop(day, None)
            _save(days, user, settings)
            return empty(day)
        cur["updated_at"] = time.time()
        days[day] = {k: cur[k] for k in ("body", "heart", "mind", "text", "updated_at")}
        _save(days, user, settings)
    return cur
