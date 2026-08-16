"""캘린더 관련 스킬 (스케줄링·수정·삭제·빈 시간 찾기)."""
from __future__ import annotations

from datetime import datetime, timedelta

from ... import calendar_service, user_settings
from ...calendar_colors import resolve_color
from ..skill_base import SkillBase, SkillResult


def _cal_prefs(ctx) -> dict:
    """사용자의 캘린더 기본값(기본 색·기본 알림)."""
    try:
        return user_settings.load(ctx.user, ctx.settings).get("calendar", {})
    except Exception:  # noqa: BLE001
        return {}


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _hhmmss(raw, default: str) -> str:
    """모델이 주는 시각 표기를 HH:MM:SS로 정규화.

    '9:00'·'09:00'·'09:00:00'을 모두 받는다. Python의 fromisoformat은
    자리수가 안 맞으면 그대로 실패하는데, 모델은 한 자리 시각을 흔히 준다.
    """
    s = str(raw if raw not in (None, "") else default).strip()
    parts = s.split(":")
    if len(parts) == 2:
        parts.append("00")
    if len(parts) != 3:
        raise ValueError(f"시각 형식이 아님: {s}")
    h, m, sec = (int(p) for p in parts)  # 숫자가 아니면 ValueError
    if not (0 <= h <= 23 and 0 <= m <= 59 and 0 <= sec <= 59):
        raise ValueError(f"시각 범위를 벗어남: {s}")
    return f"{h:02d}:{m:02d}:{sec:02d}"


def _default_window(ctx) -> tuple[str, str]:
    """기간 미지정 시 기본 조회창: 오늘-30일 ~ 오늘+120일.

    기간 없이 조회하면 아주 오래된 반복 일정까지 딸려와 현재 일정을 못 찾으므로,
    합리적인 최근~향후 범위로 한정한다.
    """
    base = ctx.today or ""
    try:
        today = datetime.fromisoformat(base[:10]) if base else datetime.now()
    except ValueError:
        today = datetime.now()
    frm = (today - timedelta(days=30)).strftime("%Y-%m-%dT00:00:00")
    to = (today + timedelta(days=120)).strftime("%Y-%m-%dT23:59:59")
    return frm, to


class ListCalendarEvents(SkillBase):
    name = "list_calendar_events"
    description = (
        "일정을 조회한다(반복 일정은 인스턴스로 확장). 충돌·삭제 대상 확인 등에 사용. "
        "기간을 지정하지 않으면 최근 1달 전 ~ 향후 4달만 조회한다(오래된 반복일정 방지)."
    )
    parameters = {
        "type": "object",
        "properties": {
            "from_date": {"type": "string", "description": "ISO 날짜/시간 (예: 2026-07-01). 미지정 시 오늘-30일."},
            "to_date": {
                "type": "string",
                "description": (
                    "ISO 날짜/시간. 끝을 포함한다 — 날짜만 주면(예: 2026-07-01) 그날 하루 전체가 포함되므로, "
                    "하루만 조회하려면 from_date와 to_date에 같은 날짜를 주면 된다. 미지정 시 오늘+120일."
                ),
            },
        },
    }

    def run(self, args, ctx):
        frm = args.get("from_date")
        to = args.get("to_date")
        if not frm and not to:
            frm, to = _default_window(ctx)  # 기간 미지정 → 현재 근처로 한정
        try:
            events = calendar_service.list_events(ctx.user, ctx.settings, frm, to)
        except Exception as e:  # noqa: BLE001 - Google API 오류 등
            return SkillResult(ok=False, message=f"일정 조회 실패: {getattr(e, 'detail', e)}", error_code="error")
        return SkillResult(
            ok=True,
            message=f"{len(events)}개 일정 ({(frm or '')[:10]}~{(to or '')[:10]})",
            data={"events": events},
        )


class CreateCalendarEvent(SkillBase):
    name = "create_calendar_event"
    description = "새 일정을 만든다. 반복(recurrence)·알림(remind_minutes)도 지정 가능."
    parameters = {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "start": {"type": "string", "description": "ISO 시작 (예: 2026-07-02T14:00:00)"},
            "end": {"type": "string"},
            "all_day": {"type": "boolean"},
            "description": {"type": "string"},
            "color": {"type": "string", "description": "색 이름(예: 보라, 하늘, 노랑) 또는 colorId 1~11"},
            "recurrence": {"type": "string", "enum": ["none", "daily", "weekly", "monthly", "yearly"]},
            "interval": {"type": "integer", "description": "반복 간격(기본 1)"},
            "recur_until": {"type": "string", "description": "반복 종료일 YYYY-MM-DD"},
            "remind_minutes": {"type": "integer", "description": "시작 N분 전 알림. 사용자가 명시 요청할 때만."},
        },
        "required": ["title", "start"],
    }

    def run(self, args, ctx):
        cal = _cal_prefs(ctx)
        default_color = str(cal.get("default_color", "2"))
        color = resolve_color(args.get("color"), default=default_color)
        # 알림: 명시하지 않으면 사용자 기본값(default_remind, 0=없음)
        remind = args.get("remind_minutes")
        remind = int(remind) if remind is not None else int(cal.get("default_remind", 0))
        try:
            ev = calendar_service.create_event(
                ctx.user,
                ctx.settings,
                {
                    "title": args["title"],
                    "start": args["start"],
                    "end": args.get("end", args["start"]),
                    "allDay": bool(args.get("all_day", False)),
                    "description": args.get("description", ""),
                    "color": color,
                    "recurrence": args.get("recurrence", "none"),
                    "interval": args.get("interval", 1),
                    "recur_until": args.get("recur_until", ""),
                    "remind_minutes": remind,
                },
            )
        except Exception as e:  # noqa: BLE001
            return SkillResult(ok=False, message=f"일정 생성 실패: {getattr(e, 'detail', e)}", error_code="error")
        return SkillResult(ok=True, message=f"일정 '{ev['title']}' 생성됨", data={"event": ev})


class UpdateCalendarEvent(SkillBase):
    name = "update_calendar_event"
    description = "기존 일정을 수정한다. event_id는 list_calendar_events로 얻는다."
    parameters = {
        "type": "object",
        "properties": {
            "event_id": {"type": "string"},
            "title": {"type": "string"},
            "start": {"type": "string"},
            "end": {"type": "string"},
            "all_day": {"type": "boolean"},
            "description": {"type": "string"},
            "color": {"type": "string"},
            "recurrence": {"type": "string", "enum": ["none", "daily", "weekly", "monthly", "yearly"]},
            "remind_minutes": {"type": "integer"},
        },
        "required": ["event_id"],
    }

    def run(self, args, ctx):
        payload = {}
        for k in ("title", "start", "end", "description", "recurrence"):
            if args.get(k) is not None:
                payload[k] = args[k]
        if args.get("color") is not None:
            payload["color"] = resolve_color(args["color"])
        if args.get("all_day") is not None:
            payload["allDay"] = bool(args["all_day"])
        if args.get("remind_minutes") is not None:
            payload["remind_minutes"] = int(args["remind_minutes"])
        try:
            ev = calendar_service.update_event(ctx.user, ctx.settings, args["event_id"], payload)
        except Exception as e:  # HTTPException 등
            return SkillResult(ok=False, message=getattr(e, "detail", str(e)), error_code="error")
        return SkillResult(ok=True, message="일정 수정됨", data={"event": ev})


class DeleteCalendarEvent(SkillBase):
    name = "delete_calendar_event"
    description = "일정을 삭제한다. 반복 인스턴스 id(...@날짜)면 해당 회차만 삭제."
    parameters = {
        "type": "object",
        "properties": {"event_id": {"type": "string"}},
        "required": ["event_id"],
    }

    def run(self, args, ctx):
        try:
            calendar_service.delete_event(ctx.user, ctx.settings, args["event_id"])
        except Exception as e:
            return SkillResult(ok=False, message=getattr(e, "detail", str(e)), error_code="error")
        return SkillResult(ok=True, message="일정 삭제됨", data={})


class FindFreeSlots(SkillBase):
    name = "find_free_slots"
    description = "특정 날짜에 지정 길이의 빈 시간대를 찾는다(일정 잡기 전에 사용)."
    parameters = {
        "type": "object",
        "properties": {
            "date": {"type": "string", "description": "YYYY-MM-DD"},
            "duration_minutes": {"type": "integer"},
            "work_start": {"type": "string", "description": "HH:MM (기본 09:00)"},
            "work_end": {"type": "string", "description": "HH:MM (기본 18:00)"},
        },
        "required": ["date", "duration_minutes"],
    }

    def run(self, args, ctx):
        day = args["date"][:10]
        dur = timedelta(minutes=max(15, int(args["duration_minutes"])))
        try:
            ws = datetime.fromisoformat(f"{day}T{_hhmmss(args.get('work_start'), '09:00')}")
            we = datetime.fromisoformat(f"{day}T{_hhmmss(args.get('work_end'), '18:00')}")
        except ValueError:
            return SkillResult(
                ok=False, message="날짜/시각 형식을 이해하지 못했습니다(date=YYYY-MM-DD, 시각=HH:MM).",
                error_code="invalid",
            )
        if we <= ws:
            return SkillResult(
                ok=False, message="work_end가 work_start보다 늦어야 합니다.", error_code="invalid"
            )
        # 오늘이면 이미 지난 시간대는 제안하지 않는다(모델이 과거 시각을 잡는 것 방지).
        now = datetime.now()
        if day == now.strftime("%Y-%m-%d") and ws < now:
            ws = now.replace(second=0, microsecond=0)
        if we - ws < dur:
            return SkillResult(ok=True, message="0개 빈 시간대", data={"free_slots": []})

        events = calendar_service.list_events(
            ctx.user, ctx.settings, f"{day}T00:00:00", f"{day}T23:59:59"
        )
        busy = []
        for e in events:
            if e.get("allDay"):
                continue
            try:
                s = datetime.fromisoformat(e["start"]).replace(tzinfo=None)
                en = datetime.fromisoformat(e.get("end") or e["start"]).replace(tzinfo=None)
                busy.append((s, en))
            except (ValueError, TypeError):
                continue
        busy.sort()

        slots = []
        cursor = ws
        for s, en in busy:  # busy는 시작시각 오름차순
            if s >= we:
                break  # 근무시간 이후 일정 — 남은 구간을 잡아당기지 않게 여기서 끝
            if en <= ws:
                continue  # 근무시간 이전에 끝난 일정
            if s > cursor and s - cursor >= dur:
                slots.append({"start": _iso(cursor), "end": _iso(s)})
            cursor = max(cursor, en)
            if cursor >= we:
                break
        if we - cursor >= dur:
            slots.append({"start": _iso(cursor), "end": _iso(we)})

        return SkillResult(ok=True, message=f"{len(slots)}개 빈 시간대", data={"free_slots": slots})
