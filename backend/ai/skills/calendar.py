"""캘린더 관련 스킬 (스케줄링·수정·삭제·빈 시간 찾기)."""
from __future__ import annotations

from datetime import datetime, timedelta

from ... import calendar_service
from ..skill_base import SkillBase, SkillResult


class ListCalendarEvents(SkillBase):
    name = "list_calendar_events"
    description = "기간 내 일정을 조회한다(반복 일정은 인스턴스로 확장). 충돌 확인 등."
    parameters = {
        "type": "object",
        "properties": {
            "from_date": {"type": "string", "description": "ISO 날짜/시간 (예: 2026-07-01)"},
            "to_date": {"type": "string"},
        },
    }

    def run(self, args, ctx):
        events = calendar_service.list_events(ctx.user, ctx.settings, args.get("from_date"), args.get("to_date"))
        return SkillResult(ok=True, message=f"{len(events)}개 일정", data={"events": events})


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
            "color": {"type": "string", "description": "Google colorId 1~11"},
            "recurrence": {"type": "string", "enum": ["none", "daily", "weekly", "monthly", "yearly"]},
            "interval": {"type": "integer", "description": "반복 간격(기본 1)"},
            "recur_until": {"type": "string", "description": "반복 종료일 YYYY-MM-DD"},
            "remind_minutes": {"type": "integer", "description": "시작 N분 전 알림 (0=없음)"},
        },
        "required": ["title", "start"],
    }

    def run(self, args, ctx):
        ev = calendar_service.create_event(
            ctx.user,
            ctx.settings,
            {
                "title": args["title"],
                "start": args["start"],
                "end": args.get("end", args["start"]),
                "allDay": bool(args.get("all_day", False)),
                "description": args.get("description", ""),
                "color": args.get("color", "2"),
                "recurrence": args.get("recurrence", "none"),
                "interval": args.get("interval", 1),
                "recur_until": args.get("recur_until", ""),
                "remind_minutes": args.get("remind_minutes", 0),
            },
        )
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
        for k in ("title", "start", "end", "description", "color", "recurrence"):
            if args.get(k) is not None:
                payload[k] = args[k]
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
        ws = datetime.fromisoformat(f"{day}T{args.get('work_start', '09:00')}:00")
        we = datetime.fromisoformat(f"{day}T{args.get('work_end', '18:00')}:00")

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
        for s, en in busy:
            if s > cursor and s - cursor >= dur:
                slots.append({"start": cursor.strftime("%Y-%m-%dT%H:%M:%S"), "end": s.strftime("%Y-%m-%dT%H:%M:%S")})
            cursor = max(cursor, en)
        if we - cursor >= dur:
            slots.append({"start": cursor.strftime("%Y-%m-%dT%H:%M:%S"), "end": we.strftime("%Y-%m-%dT%H:%M:%S")})

        return SkillResult(ok=True, message=f"{len(slots)}개 빈 시간대", data={"free_slots": slots})
