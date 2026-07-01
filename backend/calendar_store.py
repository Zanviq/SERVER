"""내부 캘린더 저장소 — 사용자별 events.json (반복·알림·예외 지원).

이벤트 모델(CalenMate 확장):
  {
    id, title, description, start(ISO), end(ISO), allDay, color,
    recurrence: none|daily|weekly|monthly|yearly,
    interval: int(>=1),
    recur_until: ISO date 또는 "",
    exdates: [ISO date, ...]  # 제외된 단일 발생일
    remind_minutes: int  # 시작 N분 전 알림 (0=없음)
  }

조회 시 반복 이벤트는 범위 내 인스턴스로 확장된다.
인스턴스 id는 "<baseId>@<YYYY-MM-DD>" 형식으로, 단일 발생 삭제(예외)에 사용.
"""
from __future__ import annotations

import calendar as _cal
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import HTTPException

from . import json_store
from .auth import SessionUser
from .config import Settings

_RECUR = ("none", "daily", "weekly", "monthly", "yearly")


def _events_path(user: SessionUser, settings: Settings) -> Path:
    base = settings.user_root(user.username) / "calendar"
    base.mkdir(parents=True, exist_ok=True)
    return base / "events.json"


def _load(user: SessionUser, settings: Settings) -> list[dict]:
    data = json_store.read_json(_events_path(user, settings), [])
    return data if isinstance(data, list) else []


def _save(events: list[dict], user: SessionUser, settings: Settings) -> None:
    json_store.write_atomic(_events_path(user, settings), events)


def _normalize(payload: dict, existing: dict | None = None) -> dict:
    base = dict(existing or {})
    for k in ("title", "description", "start", "end", "allDay", "color"):
        if k in payload and payload[k] is not None:
            base[k] = payload[k]
    rec = payload.get("recurrence")
    if rec is not None:
        base["recurrence"] = rec if rec in _RECUR else "none"
    if payload.get("interval") is not None:
        base["interval"] = max(1, int(payload["interval"]))
    if payload.get("recur_until") is not None:
        base["recur_until"] = str(payload["recur_until"])[:10]
    if payload.get("remind_minutes") is not None:
        base["remind_minutes"] = max(0, int(payload["remind_minutes"]))
    return base


def _parse_dt(s: str) -> datetime:
    s = s.strip()
    try:
        if "T" in s:
            return datetime.fromisoformat(s)
        return datetime.combine(date.fromisoformat(s[:10]), datetime.min.time())
    except ValueError:
        return datetime.min


def _fmt_dt(dt: datetime, all_day: bool) -> str:
    return dt.strftime("%Y-%m-%d") if all_day else dt.strftime("%Y-%m-%dT%H:%M:%S")


def _add_months(dt: datetime, months: int) -> datetime:
    m = dt.month - 1 + months
    year = dt.year + m // 12
    month = m % 12 + 1
    day = min(dt.day, _cal.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _step(dt: datetime, rule: str, interval: int) -> datetime:
    if rule == "daily":
        return dt + timedelta(days=interval)
    if rule == "weekly":
        return dt + timedelta(weeks=interval)
    if rule == "monthly":
        return _add_months(dt, interval)
    if rule == "yearly":
        return _add_months(dt, 12 * interval)
    return dt + timedelta(days=1)


def _occurrences(ev: dict, win_start: datetime, win_end: datetime) -> list[dict]:
    """이벤트를 [win_start, win_end] 범위의 인스턴스로 확장."""
    rule = ev.get("recurrence", "none")
    all_day = bool(ev.get("allDay"))
    start = _parse_dt(ev["start"])
    end = _parse_dt(ev.get("end") or ev["start"])
    if end < start:
        end = start
    dur = end - start

    if rule not in _RECUR or rule == "none":
        if start <= win_end and end >= win_start:
            return [dict(ev)]
        return []

    interval = max(1, int(ev.get("interval", 1)))
    exdates = set(ev.get("exdates", []))
    until = None
    if ev.get("recur_until"):
        try:
            until = datetime.combine(date.fromisoformat(ev["recur_until"]), datetime.max.time())
        except ValueError:
            until = None

    out: list[dict] = []
    cur = start
    guard = 0
    while cur <= win_end and guard < 2000:
        guard += 1
        if until and cur > until:
            break
        occ_end = cur + dur
        day_iso = cur.strftime("%Y-%m-%d")
        if occ_end >= win_start and day_iso not in exdates:
            inst = dict(ev)
            inst["id"] = f"{ev['id']}@{day_iso}"
            inst["start"] = _fmt_dt(cur, all_day)
            inst["end"] = _fmt_dt(occ_end, all_day)
            inst["series_id"] = ev["id"]
            inst["is_recurring"] = True
            out.append(inst)
        cur = _step(cur, rule, interval)
    return out


def list_events(
    user: SessionUser, settings: Settings, frm: str | None = None, to: str | None = None
) -> list[dict]:
    events = _load(user, settings)
    if not (frm or to):
        return events
    win_start = _parse_dt(frm) if frm else datetime.min
    win_end = _parse_dt(to) if to else datetime.max
    result: list[dict] = []
    for ev in events:
        result.extend(_occurrences(ev, win_start, win_end))
    result.sort(key=lambda e: e.get("start", ""))
    return result


def create_event(user: SessionUser, settings: Settings, payload: dict) -> dict:
    with json_store.lock_for(_events_path(user, settings)):
        events = _load(user, settings)
        event = _normalize(
            payload,
            {
                "id": uuid.uuid4().hex,
                "title": str(payload.get("title", "")).strip() or "(제목 없음)",
                "description": "",
                "start": payload["start"],
                "end": payload.get("end", payload["start"]),
                "allDay": False,
                "color": "2",
                "recurrence": "none",
                "interval": 1,
                "recur_until": "",
                "exdates": [],
                "remind_minutes": 0,
            },
        )
        event["title"] = str(event.get("title", "")).strip() or "(제목 없음)"
        events.append(event)
        _save(events, user, settings)
        return event


def _base_id(eid: str) -> str:
    return eid.split("@", 1)[0]


def update_event(user: SessionUser, settings: Settings, eid: str, payload: dict) -> dict:
    bid = _base_id(eid)
    with json_store.lock_for(_events_path(user, settings)):
        events = _load(user, settings)
        for i, e in enumerate(events):
            if e["id"] == bid:
                events[i] = _normalize(payload, e)
                _save(events, user, settings)
                return events[i]
    raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다.")


def delete_event(user: SessionUser, settings: Settings, eid: str) -> None:
    """단일 발생(id@date)이면 예외 추가, 아니면 시리즈 전체 삭제."""
    with json_store.lock_for(_events_path(user, settings)):
        events = _load(user, settings)
        if "@" in eid:
            bid, day = eid.split("@", 1)
            for e in events:
                if e["id"] == bid:
                    ex = set(e.get("exdates", []))
                    ex.add(day[:10])
                    e["exdates"] = sorted(ex)
                    _save(events, user, settings)
                    return
            raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다.")
        new = [e for e in events if e["id"] != eid]
        if len(new) == len(events):
            raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다.")
        _save(new, user, settings)


def due_reminders(
    user: SessionUser, settings: Settings, now_iso: str, within_minutes: int = 1440
) -> list[dict]:
    """지금부터 within_minutes 이내에 시작하며 remind_minutes가 설정된 인스턴스.

    각 항목에 remind_at(알림 시각 ISO)을 포함.
    """
    now = _parse_dt(now_iso)
    win_end = now + timedelta(minutes=within_minutes)
    result = []
    for ev in list_events(user, settings, now_iso, _fmt_dt(win_end, False)):
        rm = int(ev.get("remind_minutes", 0) or 0)
        if rm <= 0:
            continue
        start = _parse_dt(ev["start"])
        remind_at = start - timedelta(minutes=rm)
        result.append({**ev, "remind_at": _fmt_dt(remind_at, False)})
    return result
