"""캘린더 관련 스킬 (스케줄링·수정·삭제·빈 시간 찾기)."""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from ... import calendar_service, user_settings
from ...calendar_colors import COLOR_NAMES, resolve_color
from ...calendar_ids import base_id as calendar_base_id
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


#: 한 번에 모델에게 보여줄 일정 수 상한
_MAX_LIST = 200


def _base_id(eid: str) -> str:
    """반복 인스턴스 id에서 시리즈 id만. 규칙은 calendar_ids에 한 벌만 둔다."""
    return calendar_base_id(eid)


def _matches(ev: dict, color_id: str | None, needle: str | None) -> bool:
    """색·제목 조건. 둘 다 없으면 통과(기간만으로 고른 경우)."""
    if color_id and str(ev.get("color", "")) != color_id:
        return False
    if needle and needle not in str(ev.get("title", "")).lower():
        return False
    return True


class _BadColor(Exception):
    """색 이름을 못 알아들었다."""


def _strict_color(value) -> str:
    """색 이름 → colorId. 못 알아들으면 **예외**를 던진다.

    resolve_color는 모르는 값에 기본값을 돌려주는데, 필터에 그대로 쓰면
    빈 문자열이 되어 색 조건이 조용히 사라진다. 그러면 "민트색 일정 이름 바꿔줘"가
    기간 내 **전체 일정**을 대상으로 삼는다 — 일괄 수정에서는 사고다.
    """
    cid = resolve_color(value, "")
    if not cid:
        names = ", ".join(sorted({n for n in COLOR_NAMES.values()}))
        raise _BadColor(f"'{value}'가 어떤 색인지 모르겠습니다. 쓸 수 있는 색: {names}")
    return cid


def _wide_window(ctx) -> tuple[str, str]:
    """id를 직접 준 경우의 조회창 — 앞뒤 3년.

    기본창(오늘-30일~+120일)을 쓰면 "작년 12월 일정"의 id를 그대로 넘겨도
    창 밖이라 0건이 되어, 조회가 준 식별자가 후속 스킬에서 안 먹는다.
    """
    base = (ctx.today or "")[:10]
    try:
        today = datetime.fromisoformat(base) if base else datetime.now()
    except ValueError:
        today = datetime.now()
    return (
        (today - timedelta(days=1095)).strftime("%Y-%m-%dT00:00:00"),
        (today + timedelta(days=1095)).strftime("%Y-%m-%dT23:59:59"),
    )


def _select(args, ctx) -> tuple[list[dict], str, str]:
    """기간·색·제목으로 일정을 고른다. (고른 목록, 시작, 끝)"""
    frm = args.get("from_date")
    to = args.get("to_date")
    if not frm and not to:
        # id를 직접 줬으면 기간으로 다시 좁히지 않는다(파라미터 설명이 "기간보다 우선"이다)
        frm, to = _wide_window(ctx) if args.get("event_ids") else _default_window(ctx)
    color_id = _strict_color(args["color"]) if args.get("color") else None
    needle = str(args["title_contains"]).strip().lower() if args.get("title_contains") else None
    events = calendar_service.list_events(ctx.user, ctx.settings, frm, to)
    return [e for e in events if _matches(e, color_id, needle)], frm or "", to or ""


def _empty_hint(args, ctx, frm: str, to: str) -> dict:
    """조건에 맞는 게 하나도 없을 때, 다음 수를 알려 줄 정보를 모은다.

    "없습니다"로 끝나면 사용자는 왜 없는지 모른다(기간을 잘못 잡았는지, 색을
    잘못 짚었는지). 그 기간에 어떤 색이 있는지와, 찾는 색이 언제 있는지를 준다.
    """
    hint: dict = {}
    try:
        in_window = calendar_service.list_events(ctx.user, ctx.settings, frm, to)
    except Exception:  # noqa: BLE001
        return hint
    counts: dict[str, int] = {}
    for e in in_window:
        cid = str(e.get("color", ""))
        counts[cid] = counts.get(cid, 0) + 1
    hint["colors_in_window"] = {COLOR_NAMES.get(c, c): n for c, n in sorted(counts.items())}

    if args.get("color"):
        try:
            want = _strict_color(args["color"])
        except _BadColor:
            return hint
        # 찾는 색이 이 기간 밖 어디에 있는지 — 앞뒤 6개월만 본다
        base = (frm or "")[:10] or (ctx.today or "")[:10]
        try:
            anchor = datetime.fromisoformat(base) if base else datetime.now()
        except ValueError:
            anchor = datetime.now()
        wide_from = (anchor - timedelta(days=185)).strftime("%Y-%m-%dT00:00:00")
        wide_to = (anchor + timedelta(days=185)).strftime("%Y-%m-%dT23:59:59")
        try:
            wide = calendar_service.list_events(ctx.user, ctx.settings, wide_from, wide_to)
        except Exception:  # noqa: BLE001
            return hint
        by_month: dict[str, int] = {}
        for e in wide:
            if str(e.get("color", "")) != want:
                continue
            m = str(e.get("start", ""))[:7]
            if m:
                by_month[m] = by_month.get(m, 0) + 1
        if by_month:
            hint["same_color_other_months"] = dict(sorted(by_month.items()))
    return hint


class ListCalendarEvents(SkillBase):
    name = "list_calendar_events"
    description = (
        "일정을 조회한다(반복 일정은 인스턴스로 확장). 충돌·삭제 대상 확인 등에 사용. "
        "색(color)·제목(title_contains)으로 걸러낼 수 있다 — 예: '3~8월 보라색 일정'. "
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
            "color": {"type": "string", "description": "이 색만 (colorId 또는 '보라'·'빨강' 같은 이름)."},
            "title_contains": {"type": "string", "description": "제목에 이 말이 들어간 것만(대소문자 무시)."},
        },
    }

    def run(self, args, ctx):
        try:
            events, frm, to = _select(args, ctx)
        except _BadColor as e:
            return SkillResult(ok=False, message=str(e), error_code="invalid")
        except Exception as e:  # noqa: BLE001 - Google API 오류 등
            return SkillResult(ok=False, message=f"일정 조회 실패: {getattr(e, 'detail', e)}", error_code="error")
        cond = []
        if args.get("color"):
            cond.append(f"색={COLOR_NAMES.get(_strict_color(args['color']), args['color'])}")
        if args.get("title_contains"):
            cond.append(f"제목~'{args['title_contains']}'")
        suffix = (" " + ", ".join(cond)) if cond else ""
        # 색 이름을 같이 준다 — id(1~11)만 주면 모델이 "자주"를 달라 해놓고
        # 보라 결과를 받아도 알아채지 못한다.
        # 모델에 넘기는 양을 제한한다. 수백 건을 통째로 실으면 컨텍스트를 다 쓰고
        # 정작 추론할 자리가 없어진다. 넘치면 그 사실을 알려 기간을 좁히게 한다.
        shown = events[:_MAX_LIST]
        data: dict = {"events": [
            {**e, "color_name": COLOR_NAMES.get(str(e.get("color", "")), "")} for e in shown
        ]}
        if len(events) > _MAX_LIST:
            data["truncated"] = True
            data["total"] = len(events)
            suffix += f" — {len(events)}건 중 {_MAX_LIST}건만 표시(기간을 좁히세요)"
        if not events:
            # 그냥 "없습니다"로 끝내면 사용자가 다음에 뭘 해야 할지 모른다.
            hint = _empty_hint(args, ctx, frm, to)
            if hint:
                data["hint"] = hint
                other = hint.get("same_color_other_months")
                if other:
                    months = ", ".join(f"{m}({n}건)" for m, n in other.items())
                    suffix += f" — 이 기간엔 없고 {months}에 있습니다"
        return SkillResult(
            ok=True,
            message=f"{len(events)}개 일정 ({frm[:10]}~{to[:10]}){suffix}",
            data=data,
        )


class CreateCalendarEvent(SkillBase):
    mutates = "calendar"
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
        msg = f"일정 '{ev['title']}' 생성됨"
        # 알림은 내부 캘린더 전용이다. 구글에 걸어놓고 "설정했습니다"라고 답하면 거짓말이 된다.
        if remind > 0 and calendar_service.backend_kind(ctx.user, ctx.settings) == "google":
            msg += " (Google 캘린더라 알림 설정은 적용되지 않습니다)"
        return SkillResult(ok=True, message=msg, data={"event": ev})


class UpdateCalendarEvent(SkillBase):
    mutates = "calendar"
    name = "update_calendar_event"
    description = (
        "기존 일정을 수정한다. event_id는 list_calendar_events로 얻는다. "
        "**반복 일정은 인스턴스 id를 줘도 시리즈 전체가 바뀐다** — 한 회차만 고치려면 "
        "delete_calendar_event로 그 회차를 지우고 create_calendar_event로 새로 만드세요."
    )
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
            # 일괄 스킬과 같은 규칙 — 모르는 색을 기본값으로 바꿔치기하면
            # 보라색 일정이 조용히 연두로 덮인다.
            try:
                payload["color"] = _strict_color(args["color"])
            except _BadColor as e:
                return SkillResult(ok=False, message=str(e), error_code="invalid")
        if args.get("all_day") is not None:
            payload["allDay"] = bool(args["all_day"])
        if args.get("remind_minutes") is not None:
            payload["remind_minutes"] = int(args["remind_minutes"])
        try:
            ev = calendar_service.update_event(ctx.user, ctx.settings, args["event_id"], payload)
        except Exception as e:  # HTTPException 등
            return SkillResult(ok=False, message=getattr(e, "detail", str(e)), error_code="error")
        return SkillResult(ok=True, message="일정 수정됨", data={"event": ev})


class BulkUpdateCalendarEvents(SkillBase):
    """여러 일정을 한 번에 고친다.

    개별 update_calendar_event를 반복 호출하게 두면 두 가지가 어긋난다.
    (1) 반복 일정은 조회 시 인스턴스로 펼쳐지지만 수정은 **시리즈 전체**에 걸린다.
        인스턴스마다 접두어를 붙이면 '멋사-멋사-멋사-…'가 된다.
    (2) 대상이 수십 개면 모델이 중간에 빠뜨리거나 같은 걸 두 번 고친다.
    그래서 고르기·중복 제거·적용을 한 번에 처리한다.
    """

    mutates = "calendar"
    name = "bulk_update_calendar_events"
    description = (
        "여러 일정을 한 번에 수정한다(제목 앞/뒤에 말 붙이기·치환, 색 변경). "
        "기간·색·제목으로 대상을 고른다. 예: '3월~8월 보라색 일정 제목 앞에 멋사- 붙이기'. "
        "반복 일정은 시리즈로 묶어 한 번만 고친다. 이미 그 접두어가 있으면 건너뛴다. "
        "무엇이 바뀌는지 먼저 보여주려면 dry_run=true로 부르고, 사용자가 확인하면 다시 부른다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "from_date": {"type": "string", "description": "ISO 날짜 (예: 2026-03-01). 미지정 시 오늘-30일."},
            "to_date": {"type": "string", "description": "ISO 날짜. 끝을 포함한다. 미지정 시 오늘+120일."},
            "color": {"type": "string", "description": "이 색만 고른다 (colorId 또는 '보라' 같은 이름)."},
            "title_contains": {"type": "string", "description": "제목에 이 말이 든 것만."},
            "event_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "직접 고른 id들(list_calendar_events가 준 값). 주면 기간·색 조건보다 우선.",
            },
            "title_prefix": {"type": "string", "description": "제목 앞에 붙일 말 (예: '멋사-')."},
            "title_suffix": {"type": "string", "description": "제목 뒤에 붙일 말."},
            "replace_from": {"type": "string", "description": "제목에서 바꿀 말."},
            "replace_to": {"type": "string", "description": "replace_from을 이 말로 바꾼다."},
            "set_color": {"type": "string", "description": "색을 이 값으로 바꾼다 (이름 또는 colorId)."},
            "dry_run": {"type": "boolean", "description": "true면 바꾸지 않고 바뀔 내용만 돌려준다."},
        },
    }

    # 한 번에 건드릴 수 있는 상한. 넘으면 조건을 좁히게 한다.
    MAX = 200

    def run(self, args, ctx):
        prefix = args.get("title_prefix") or ""
        suffix = args.get("title_suffix") or ""
        rep_from = args.get("replace_from") or ""
        rep_to = args.get("replace_to") if args.get("replace_to") is not None else ""
        new_color = resolve_color(args["set_color"], "") if args.get("set_color") else ""
        if not (prefix or suffix or rep_from or new_color):
            return SkillResult(
                ok=False,
                error_code="invalid",
                message="무엇을 바꿀지 없습니다. title_prefix·title_suffix·replace_from/replace_to·set_color 중 하나는 주세요.",
            )

        ids = [str(i) for i in (args.get("event_ids") or [])]
        has_filter = bool(ids or args.get("color") or args.get("title_contains")
                          or args.get("from_date") or args.get("to_date"))
        if not has_filter:
            return SkillResult(
                ok=False,
                error_code="invalid",
                message="대상이 너무 넓습니다. 기간·색·제목 중 하나로 좁혀 주세요.",
            )

        try:
            events, frm, to = _select(args, ctx)
        except _BadColor as e:
            # 모르는 색을 그냥 넘기면 색 조건이 사라져 기간 내 전체가 대상이 된다
            return SkillResult(ok=False, message=str(e), error_code="invalid")
        except Exception as e:  # noqa: BLE001
            return SkillResult(ok=False, message=f"일정 조회 실패: {getattr(e, 'detail', e)}", error_code="error")

        if ids:
            want = {_base_id(i) for i in ids}
            events = [e for e in events if _base_id(e.get("id", "")) in want]
            missing = want - {_base_id(e.get("id", "")) for e in events}
            if missing:
                return SkillResult(
                    ok=False, error_code="not_found",
                    message=("찾지 못한 일정이 있습니다: " + ", ".join(sorted(missing)) +
                             f". 조회 기간({frm[:10]}~{to[:10]}) 밖일 수 있으니 "
                             "from_date/to_date를 함께 주세요."),
                    data={"missing": sorted(missing)},
                )

        # 반복 일정은 인스턴스로 펼쳐져 있다 — 시리즈당 한 번만 고친다.
        by_series: dict[str, dict] = {}
        instances: dict[str, int] = {}
        for e in events:
            sid = _base_id(e.get("id", ""))
            by_series.setdefault(sid, e)
            instances[sid] = instances.get(sid, 0) + 1
        recurring = sum(1 for n in instances.values() if n > 1)

        planned = []
        for sid, ev in by_series.items():
            old = str(ev.get("title", ""))
            new = old.replace(rep_from, rep_to) if rep_from else old
            # 이미 붙어 있으면 다시 붙이지 않는다(같은 지시를 두 번 받아도 안전).
            if prefix and not new.startswith(prefix):
                new = prefix + new
            if suffix and not new.endswith(suffix):
                new = new + suffix
            color_changes = bool(new_color) and str(ev.get("color", "")) != new_color
            if new == old and not color_changes:
                continue  # 바뀔 게 없다
            planned.append({
                "id": sid,
                "old_title": old,
                "new_title": new,
                "start": ev.get("start", ""),
                "old_color": ev.get("color", ""),
                "new_color": new_color or ev.get("color", ""),
            })

        if not planned:
            data: dict = {"changed": [], "count": 0}
            msg = f"바꿀 일정이 없습니다 ({frm[:10]}~{to[:10]}). 이미 반영돼 있거나 조건에 맞는 일정이 없습니다."
            if not events:  # 애초에 고른 게 없다 — 왜 없는지 알려 준다
                hint = _empty_hint(args, ctx, frm, to)
                if hint:
                    data["hint"] = hint
                    other = hint.get("same_color_other_months")
                    if other:
                        months = ", ".join(f"{m}({n}건)" for m, n in other.items())
                        msg += f" 같은 색이 {months}에 있습니다 — 기간을 그쪽으로 잡을까요?"
            return SkillResult(ok=True, message=msg, data=data)
        if len(planned) > self.MAX:
            return SkillResult(
                ok=False,
                error_code="too_many",
                message=f"대상이 {len(planned)}개로 너무 많습니다(최대 {self.MAX}). 기간이나 조건을 좁혀 주세요.",
                data={"count": len(planned)},
            )

        # 반복 일정의 제목·색은 시리즈 속성이라, 고치면 기간 밖 회차까지 함께 바뀐다.
        # 조용히 넘어가면 사용자가 나중에 알게 되므로 결과에 적어 준다.
        note = f" (반복 일정 {recurring}건은 시리즈 전체가 바뀝니다)" if recurring else ""

        if args.get("dry_run"):
            return SkillResult(
                ok=True,
                message=f"{len(planned)}개가 바뀝니다(아직 적용 안 함){note}. 확인 후 dry_run 없이 다시 요청하세요.",
                data={"planned": planned, "count": len(planned), "recurring": recurring, "dry_run": True},
            )

        # 한 건씩 부르면 Google은 건마다 get+patch(왕복 2회)라 수십 건에서 응답이 끊긴다.
        # 바꿀 내용을 여기서 다 만들어 두고 한 번에 넘긴다(배치).
        items = []
        for p in planned:
            payload: dict = {"title": p["new_title"]}
            if new_color:
                payload["color"] = new_color
            items.append((p["id"], payload, by_series[p["id"]]))
        ok_ids, fail_pairs = calendar_service.update_many(ctx.user, ctx.settings, items)
        done = set(ok_ids)
        changed = [p for p in planned if p["id"] in done]
        err_by_id = dict(fail_pairs)
        failed = [{"id": p["id"], "title": p["old_title"], "error": err_by_id.get(p["id"], "")}
                  for p in planned if p["id"] not in done]

        msg = f"{len(changed)}개 일정을 수정했습니다 ({frm[:10]}~{to[:10]}){note}"
        if failed:
            msg += f" — {len(failed)}개 실패"
        return SkillResult(
            ok=not failed or bool(changed),
            message=msg,
            data={"changed": changed, "failed": failed, "count": len(changed)},
        )


class BulkCreateCalendarEvents(SkillBase):
    """여러 일정을 한 번에 만든다."""

    mutates = "calendar"
    name = "bulk_create_calendar_events"
    description = (
        "여러 일정을 한 번에 만든다(예: '다음 주 월~금 09시 스탠드업 잡아줘', "
        "'9/1, 9/8, 9/15에 스터디'). 각 항목은 create_calendar_event와 같은 형식이며, "
        "color·remind_minutes를 빼면 events 바깥의 기본값(default_color 등)을 쓴다. "
        "반복 규칙으로 표현되는 일정이라면 이 스킬 대신 create_calendar_event의 recurrence를 쓰세요."
    )
    parameters = {
        "type": "object",
        "properties": {
            "events": {
                "type": "array",
                "description": "만들 일정들",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "start": {"type": "string", "description": "ISO 시작 (예: 2026-09-01T09:00:00)"},
                        "end": {"type": "string"},
                        "all_day": {"type": "boolean"},
                        "description": {"type": "string"},
                        "color": {"type": "string"},
                        "remind_minutes": {"type": "integer"},
                    },
                    "required": ["title", "start"],
                },
            },
            "color": {"type": "string", "description": "항목에 색이 없을 때 쓸 공통 색."},
            "remind_minutes": {"type": "integer", "description": "항목에 없을 때 쓸 공통 알림(분)."},
            "dry_run": {"type": "boolean", "description": "true면 만들지 않고 목록만 돌려준다."},
        },
        "required": ["events"],
    }

    MAX = 100

    def run(self, args, ctx):
        items = args.get("events") or []
        if not items:
            return SkillResult(ok=False, error_code="invalid", message="만들 일정이 없습니다.")
        if len(items) > self.MAX:
            return SkillResult(
                ok=False, error_code="too_many",
                message=f"한 번에 {self.MAX}개까지만 만들 수 있습니다({len(items)}개 요청).",
            )
        cal = _cal_prefs(ctx)
        default_color = str(cal.get("default_color", "2"))
        try:
            common_color = _strict_color(args["color"]) if args.get("color") else None
        except _BadColor as e:
            return SkillResult(ok=False, error_code="invalid", message=str(e))
        common_remind = args.get("remind_minutes")

        planned = []
        for it in items:
            if not it.get("title") or not it.get("start"):
                return SkillResult(ok=False, error_code="invalid",
                                   message="각 일정에 title과 start가 있어야 합니다.")
            try:
                color = _strict_color(it["color"]) if it.get("color") else (common_color or default_color)
            except _BadColor as e:
                return SkillResult(ok=False, error_code="invalid", message=str(e))
            remind = it.get("remind_minutes", common_remind)
            planned.append({
                "title": it["title"],
                "start": it["start"],
                "end": it.get("end", it["start"]),
                "allDay": bool(it.get("all_day", False)),
                "description": it.get("description", ""),
                "color": color,
                "recurrence": "none",
                "remind_minutes": int(remind) if remind is not None else int(cal.get("default_remind", 0)),
            })

        if args.get("dry_run"):
            return SkillResult(
                ok=True,
                message=f"{len(planned)}개를 만들 예정입니다(아직 만들지 않음).",
                data={"planned": planned, "count": len(planned), "dry_run": True},
            )

        # 낱개 create_event를 반복하면 구글에서 건당 왕복 1회, 내부 저장소에서는
        # 건당 파일 read/write다. 한 번에 넘긴다.
        made, fail_pairs = calendar_service.create_many(ctx.user, ctx.settings, planned)
        created = made
        err_by_title = dict(fail_pairs)
        failed = [
            {"title": t, "error": err}
            for t, err in err_by_title.items()
        ]
        msg = f"{len(created)}개 일정을 만들었습니다"
        if failed:
            msg += f" — {len(failed)}개 실패"
        return SkillResult(ok=bool(created) or not failed, message=msg,
                           data={"created": created, "failed": failed, "count": len(created)})


class BulkDeleteCalendarEvents(SkillBase):
    """여러 일정을 한 번에 지운다(휴지통으로)."""

    mutates = "calendar"
    name = "bulk_delete_calendar_events"
    description = (
        "여러 일정을 한 번에 삭제한다. 기간·색·제목으로 고른다 "
        "(예: '9월 초록색 테스트 일정 전부 지워줘'). 지운 일정은 휴지통의 '일정'에 들어가 "
        "되돌릴 수 있다. 되돌릴 수 있다 해도 삭제는 되돌리기 번거로우니, "
        "반드시 먼저 dry_run=true로 목록을 보여주고 사용자 확인을 받은 뒤 실행하세요."
    )
    parameters = {
        "type": "object",
        "properties": {
            "from_date": {"type": "string"},
            "to_date": {"type": "string"},
            "color": {"type": "string", "description": "이 색만 (이름 또는 colorId)."},
            "title_contains": {"type": "string", "description": "제목에 이 말이 든 것만."},
            "event_ids": {"type": "array", "items": {"type": "string"},
                          "description": "직접 고른 id들. 주면 다른 조건보다 우선."},
            "dry_run": {"type": "boolean", "description": "true면 지우지 않고 대상만 돌려준다."},
        },
    }

    MAX = 100

    def run(self, args, ctx):
        ids = [str(i) for i in (args.get("event_ids") or [])]
        if not (ids or args.get("color") or args.get("title_contains")
                or args.get("from_date") or args.get("to_date")):
            return SkillResult(ok=False, error_code="invalid",
                               message="대상이 너무 넓습니다. 기간·색·제목 중 하나로 좁혀 주세요.")
        try:
            events, frm, to = _select(args, ctx)
        except _BadColor as e:
            return SkillResult(ok=False, error_code="invalid", message=str(e))
        except Exception as e:  # noqa: BLE001
            return SkillResult(ok=False, message=f"일정 조회 실패: {getattr(e, 'detail', e)}", error_code="error")

        if ids:
            want = {_base_id(i) for i in ids}
            events = [e for e in events if _base_id(e.get("id", "")) in want]
            missing = want - {_base_id(e.get("id", "")) for e in events}
            if missing:
                return SkillResult(
                    ok=False, error_code="not_found",
                    message=("찾지 못한 일정이 있습니다: " + ", ".join(sorted(missing)) +
                             f". 조회 기간({frm[:10]}~{to[:10]}) 밖일 수 있으니 "
                             "from_date/to_date를 함께 주세요."),
                    data={"missing": sorted(missing)},
                )

        # 반복은 시리즈당 한 번만 지운다(인스턴스마다 부르면 이미 없는 것을 계속 지운다)
        by_series: dict[str, dict] = {}
        for e in events:
            by_series.setdefault(_base_id(e.get("id", "")), e)
        targets = list(by_series.values())

        if not targets:
            data: dict = {"deleted": [], "count": 0}
            msg = f"지울 일정이 없습니다 ({frm[:10]}~{to[:10]})."
            hint = _empty_hint(args, ctx, frm, to)
            if hint:
                data["hint"] = hint
                other = hint.get("same_color_other_months")
                if other:
                    months = ", ".join(f"{m}({n}건)" for m, n in other.items())
                    msg += f" 같은 색이 {months}에 있습니다."
            return SkillResult(ok=True, message=msg, data=data)

        if len(targets) > self.MAX:
            return SkillResult(ok=False, error_code="too_many",
                               message=f"대상이 {len(targets)}개로 너무 많습니다(최대 {self.MAX}). 조건을 좁혀 주세요.",
                               data={"count": len(targets)})

        listing = [{"id": _base_id(e.get("id", "")), "title": e.get("title", ""),
                    "start": e.get("start", ""), "color": e.get("color", "")} for e in targets]
        if args.get("dry_run"):
            return SkillResult(
                ok=True,
                message=f"{len(listing)}개가 삭제됩니다(아직 지우지 않음). 확인 후 dry_run 없이 다시 요청하세요.",
                data={"planned": listing, "count": len(listing), "dry_run": True},
            )

        # 한 번에 넘긴다(휴지통 보관도 서비스 계층이 함께 처리한다)
        ok_ids, fail_pairs = calendar_service.delete_many(ctx.user, ctx.settings, targets)
        # 백엔드가 인스턴스 id를 돌려줘도 시리즈 id와 대조되도록 한 번 더 정규화한다
        done = {_base_id(i) for i in ok_ids}
        err_by_id = {_base_id(k): v for k, v in fail_pairs}
        deleted = [i for i in listing if i["id"] in done]
        failed = [{**i, "error": err_by_id.get(i["id"], "")} for i in listing if i["id"] not in done]
        msg = f"{len(deleted)}개 일정을 삭제했습니다 — 휴지통의 '일정'에서 되돌릴 수 있습니다"
        if failed:
            msg += f" ({len(failed)}개 실패)"
        return SkillResult(ok=bool(deleted) or not failed, message=msg,
                           data={"deleted": deleted, "failed": failed, "count": len(deleted)})


class DeleteCalendarEvent(SkillBase):
    mutates = "calendar"
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
