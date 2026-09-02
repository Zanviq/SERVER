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
from .datetimes import BadDateTime, clamp_interval
from .datetimes import naive as dt_naive
from .datetimes import parse as dt_parse
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


def _shift_end(base: dict, existing: dict) -> None:
    """시작만 옮겼을 때 원래 길이를 유지하도록 끝도 같이 민다.

    end를 안 주면 예전 값이 그대로 남아, 뒤로 옮기면 끝이 시작보다 앞서게 된다
    ("3시로 옮겨줘"처럼 start만 바꾸는 요청에서 항상 발생). 캘린더 앱에서
    일정을 드래그하면 길이가 유지되는 것과 같은 동작으로 맞춘다.
    """
    old_start, old_end = existing.get("start"), existing.get("end")
    if not (old_start and old_end):
        return
    delta = _parse_dt(base["start"]) - _parse_dt(old_start)
    if not delta:
        return
    base["end"] = _fmt_dt(_parse_dt(old_end) + delta, bool(base.get("allDay")))


def _normalize(payload: dict, existing: dict | None = None) -> dict:
    base = dict(existing or {})
    # start만 바뀌는 경우를 알아야 하므로 값을 덮기 전에 판단한다.
    shift = (
        existing is not None
        and payload.get("start") is not None
        and payload.get("end") is None
    )
    for k in ("title", "description", "start", "end", "allDay", "color"):
        if k in payload and payload[k] is not None:
            base[k] = payload[k]
    if shift:
        _shift_end(base, existing)
    rec = payload.get("recurrence")
    if rec is not None:
        base["recurrence"] = rec if rec in _RECUR else "none"
    if payload.get("interval") is not None:
        base["interval"] = clamp_interval(payload["interval"])
    if payload.get("recur_until") is not None:
        base["recur_until"] = str(payload["recur_until"])[:10]
    if payload.get("remind_minutes") is not None:
        base["remind_minutes"] = max(0, int(payload["remind_minutes"]))
    return base


def merge_event(payload: dict, existing: dict) -> dict:
    """부분 payload를 기존 일정 위에 병합(시작만 옮기면 길이 유지).

    내부 저장소와 Google 어댑터가 같은 규칙을 쓰도록 공개한다.
    """
    return _normalize(payload, existing)


def _parse_dt(s: str) -> datetime:
    """저장된 값을 읽는다. **여기서 검증하지 않는다** — 입력 검증은
    datetimes.to_iso가 경계에서 한다. 여기서는 예전에 들어간 이상한 값 때문에
    조회 전체가 죽지 않도록 방어만 한다.

    특히 타임존이 붙은 값 하나가 남아 있으면 naive와 비교하다 TypeError가 나
    그 사용자의 캘린더가 통째로 조회 불가가 됐다.
    """
    s = str(s).strip()
    try:
        if "T" in s:
            return dt_naive(datetime.fromisoformat(s))
        return datetime.combine(date.fromisoformat(s[:10]), datetime.min.time())
    except ValueError:
        try:  # 'YYYY-M-D' 같은 느슨한 표기까지는 살려 준다
            return dt_parse(s)
        except BadDateTime:
            return datetime.min


def _parse_dt_end(s: str) -> datetime:
    """조회 창의 '종료' 경계를 파싱한다 (끝을 포함).

    날짜만(YYYY-MM-DD) 주어지면 그날 23:59:59.999999로 해석한다. 자정으로 두면
    `to=2026-08-20` 조회가 그날 00:00에서 끝나 당일 일정이 통째로 빠진다.
    시각까지 준 경우(2026-08-20T12:00:00)는 그 시각 그대로 쓴다.
    """
    if "T" in str(s).strip():
        return _parse_dt(s)
    try:
        return datetime.combine(date.fromisoformat(str(s).strip()[:10]), datetime.max.time())
    except ValueError:
        return datetime.max


def _fmt_dt(dt: datetime, all_day: bool) -> str:
    return dt.strftime("%Y-%m-%d") if all_day else dt.strftime("%Y-%m-%dT%H:%M:%S")


def _add_months(dt: datetime, months: int) -> datetime:
    """달 단위 이동. 표현 범위를 벗어나면 datetime.max로 끝낸다.

    예전에는 interval이 크면 `year 102026 is out of range`가 그대로 올라와,
    그런 일정 하나가 그 사용자의 모든 캘린더 조회를 500으로 만들었다.
    """
    m = dt.month - 1 + months
    year = dt.year + m // 12
    month = m % 12 + 1
    if not (datetime.min.year <= year <= datetime.max.year):
        return datetime.max
    day = min(dt.day, _cal.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _step(dt: datetime, rule: str, interval: int) -> datetime:
    try:
        return _step_raw(dt, rule, interval)
    except (OverflowError, ValueError):
        # 더 갈 수 없으면 창 밖으로 보내 루프를 끝낸다(예외로 조회를 죽이지 않는다)
        return datetime.max


def _step_raw(dt: datetime, rule: str, interval: int) -> datetime:
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

    interval = clamp_interval(ev.get("interval", 1))
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
        nxt = _step(cur, rule, interval)
        if nxt <= cur:  # 전진하지 않으면 무한루프다
            break
        cur = nxt
    return out


def list_events(
    user: SessionUser, settings: Settings, frm: str | None = None, to: str | None = None
) -> list[dict]:
    events = _load(user, settings)
    if not (frm or to):
        return events
    win_start = _parse_dt(frm) if frm else datetime.min
    win_end = _parse_dt_end(to) if to else datetime.max
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


def create_many(
    user: SessionUser, settings: Settings, payloads: list[dict]
) -> tuple[list[dict], list[tuple[str, str]]]:
    """여러 건을 한 번에 만든다 - 파일을 한 번만 읽고 한 번만 쓴다."""
    made: list[dict] = []
    fail: list[tuple[str, str]] = []
    with json_store.lock_for(_events_path(user, settings)):
        events = _load(user, settings)
        for idx, p in enumerate(payloads):
            try:
                ev = _normalize(p, {
                    "id": uuid.uuid4().hex,
                    "title": str(p.get("title", "")).strip() or "(제목 없음)",
                    "description": "",
                    "start": p["start"],
                    "end": p.get("end", p["start"]),
                    "allDay": False,
                    "color": "2",
                    "recurrence": "none",
                    "interval": 1,
                    "recur_until": "",
                    "exdates": [],
                    "remind_minutes": 0,
                })
                ev["title"] = str(ev.get("title", "")).strip() or "(제목 없음)"
                events.append(ev)
                made.append(ev)
            except Exception as e:  # noqa: BLE001
                # 제목이 아니라 요청 인덱스로 돌려준다 — 같은 제목이 여럿이면
                # 제목을 키로 쓰는 순간 건수가 뭉개진다.
                fail.append((idx, str(e)))
        _save(events, user, settings)
    return made, fail


def _base_id(eid: str) -> str:
    """규칙은 calendar_ids 한 곳에서만 정한다."""
    from .calendar_ids import is_instance, base_id

    return base_id(eid)


def _moves_this_occurrence(eid: str, payload: dict, series: dict) -> bool:
    """반복 일정의 **한 회차만** 시간이 바뀌는 수정인가."""
    from .calendar_ids import is_instance

    if not is_instance(eid) or str(series.get("recurrence", "none")) in ("", "none"):
        return False
    day = str(eid).split("@", 1)[1][:10]
    for key in ("start", "end"):
        want = payload.get(key)
        if not want:
            continue
        # 그 회차의 원래 값(같은 날짜에 시리즈의 시각을 얹은 것)과 다르면 이동이다
        base = str(series.get(key) or series.get("start") or "")
        cur = f"{day}{base[10:]}" if len(base) > 10 else day
        if str(want) != cur:
            return True
    return False


def update_event(user: SessionUser, settings: Settings, eid: str, payload: dict) -> dict:
    bid = _base_id(eid)
    with json_store.lock_for(_events_path(user, settings)):
        events = _load(user, settings)
        for i, e in enumerate(events):
            if e["id"] != bid:
                continue
            if _moves_this_occurrence(eid, payload, e):
                # **그 회차만 떼어낸다.** 예전에는 시리즈 자체의 start 를 고쳐서,
                # 한 회차를 옮기면 전 회차가 따라 옮겨지고 **시리즈 시작보다 앞선
                # 회차는 통째로 사라졌다**(8회차 → 7회차, 실측). 구글은 인스턴스를
                # 따로 수정할 수 있지만 내부 저장소는 규칙 하나로만 펼치므로,
                # 그 날짜를 예외로 빼고 단발 일정을 새로 만든다.
                day = str(eid).split("@", 1)[1][:10]
                e.setdefault("exdates", [])
                if day not in e["exdates"]:
                    e["exdates"].append(day)
                base = dict(e)
                base.pop("id", None)
                base["recurrence"] = "none"
                base.pop("recur_until", None)
                base.pop("exdates", None)
                start = str(e.get("start", ""))
                base["start"] = f"{day}{start[10:]}" if len(start) > 10 else day
                end = str(e.get("end") or start)
                base["end"] = f"{day}{end[10:]}" if len(end) > 10 else day
                single = _normalize(payload, base)
                single["id"] = uuid.uuid4().hex
                single["recurrence"] = "none"
                single["exdates"] = []
                events.append(single)
                _save(events, user, settings)
                return single
            events[i] = _normalize(payload, e)
            _save(events, user, settings)
            return events[i]
    raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다.")


def update_many(user: SessionUser, settings: Settings,
                items: list[tuple[str, dict]]) -> tuple[list[str], list[tuple[str, str]]]:
    """여러 건을 한 번에 수정 — 파일을 한 번만 읽고 한 번만 쓴다.

    낱개 update_event를 78번 부르면 파일 read/write도 78번이다(락도 78번).
    """
    ok: list[str] = []
    fail: list[tuple[str, str]] = []
    with json_store.lock_for(_events_path(user, settings)):
        events = _load(user, settings)
        by_id = {e["id"]: e for e in events}
        for eid, payload in items:
            base = _base_id(eid)
            cur = by_id.get(base)
            if cur is None:
                fail.append((eid, "이벤트를 찾을 수 없습니다."))
                continue
            try:
                cur.update(merge_event(payload, cur))
                ok.append(base)
            except Exception as e:  # noqa: BLE001
                fail.append((eid, str(e)))
        _save(events, user, settings)
    return ok, fail


def delete_many(user: SessionUser, settings: Settings,
                eids: list[str]) -> tuple[list[str], list[tuple[str, str]]]:
    """여러 건을 한 번에 삭제. 파일 접근 1회.

    인스턴스 id(`base@YYYY-MM-DD`)면 **그 회차만** 예외 처리한다 — 단건
    delete_event와 같은 규칙이다. 예전에는 전부 base로 접어 시리즈를 통째로
    지웠고, "9월 것만 지워줘"가 몇 년치를 날렸다.
    """
    ok: list[str] = []
    fail: list[tuple[str, str]] = []
    with json_store.lock_for(_events_path(user, settings)):
        events = _load(user, settings)
        by_id = {e["id"]: e for e in events}
        drop: set[str] = set()
        for eid in eids:
            base = _base_id(eid)
            target = by_id.get(base)
            if target is None:
                fail.append((eid, "이벤트를 찾을 수 없습니다."))
                continue
            if "@" in str(eid):
                ex = set(target.get("exdates", []))
                ex.add(str(eid).split("@", 1)[1][:10])
                target["exdates"] = sorted(ex)
            else:
                drop.add(base)
            ok.append(eid)
        _save([e for e in events if e["id"] not in drop], user, settings)
    return ok, fail


def find_event(user: SessionUser, settings: Settings, eid: str) -> dict | None:
    """id로 일정 하나(반복은 시리즈 원본). 삭제 전 휴지통에 담을 때 쓴다."""
    bid = _base_id(eid)
    return next((e for e in _load(user, settings) if e.get("id") == bid), None)


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
