"""날짜 셈은 서버가 한다.

모델은 "100일 뒤"가 무슨 뜻인지는 잘 알아듣는다. 그런데 **그 날짜를 세는 것은
자주 틀린다** — 실측(2026-09-07): "100일 뒤"에 2027-01-15 라고 답했다(한 달이
어긋난다). 9차·86차에 프롬프트로 두 번 다잡았는데 또 어긋났으니, 이제 구조로
옮긴다(이 저장소가 여러 번 확인한 규칙이다).

그래서 일은 이렇게 나눈다.
  - 말을 알아듣는 것(“다음 주 화요일”, “두 달 뒤”)은 **모델**이 한다 → days/weeks/
    months/weekday 로 옮긴다.
  - 셈은 **서버**가 한다. 윤년·월말·요일은 사람도 모델도 틀리는 자리다.

한국어 문장을 서버가 파싱하지 않는 것은 일부러다. 파싱은 새로운 방식으로
틀리고("다음 주"가 언제부터인지), 그 오해는 조용하다. 모델이 뜻을 정하고
서버가 숫자를 다루는 편이 어긋날 자리가 적다.
"""
from __future__ import annotations

from datetime import date, timedelta

from ..skill_base import SkillBase, SkillResult

#: 월요일=0 … 일요일=6
_WEEKDAYS = {"월": 0, "화": 1, "수": 2, "목": 3, "금": 4, "토": 5, "일": 6}
_NAMES = "월화수목금토일"
_MAX_STEP = 366 * 20   # 20년. 이보다 먼 날은 물어볼 일이 없고, 실수를 걸러 준다


def _add_months(d: date, months: int) -> date:
    """달을 더한다. 없는 날짜는 그 달의 마지막 날로 내린다(1/31 + 1달 = 2/28)."""
    total = (d.year * 12 + (d.month - 1)) + months
    year, month = divmod(total, 12)
    month += 1
    for day in range(d.day, 0, -1):
        try:
            return date(year, month, day)
        except ValueError:
            continue
    raise ValueError("날짜를 만들 수 없습니다")


class ShiftDate(SkillBase):
    name = "shift_date"
    description = (
        "날짜를 센다. **상대 날짜는 직접 계산하지 말고 반드시 이걸로 확인한다** — "
        "'100일 뒤', '3주 후', '다음 달 오늘', '지난주 금요일', '2월 마지막 날'. "
        "days/weeks/months/years 로 옮겨 주면 서버가 셈한다(윤년·월말도 맞춘다). "
        "weekday 를 주면 그 요일로 옮긴다('다음 주 화요일'은 weeks=1, weekday='화'). "
        "base 를 주면 그날 기준(생략하면 오늘)."
    )
    parameters = {
        "type": "object",
        "properties": {
            "days": {"type": "integer", "description": "더할 날수(음수면 과거)"},
            "weeks": {"type": "integer"},
            "months": {"type": "integer", "description": "달 단위. 없는 날짜는 그 달 말일로."},
            "years": {"type": "integer"},
            "weekday": {"type": "string",
                        "description": "월·화·수·목·금·토·일 중 하나. 그 주의 그 요일로 옮긴다."},
            # 이름이 `base` 인 것은 취향이 아니다. 처음에 `from` 으로 뒀더니 **모델이
            # 아무 답도 하지 않았다** — 오류도 없이 빈 응답(finish_reason=STOP)만 왔고,
            # 이 스킬을 쓰지 않는 물음까지 전부 그랬다. 도구 목록 하나가 망가지면
            # 그 대화 전체가 조용히 죽는다. 이름을 바꾸자 바로 정상이 됐다.
            # (그때 새로 넣은 파일 로그가 원인을 짚어 줬다.)
            "base": {"type": "string", "description": "기준일 YYYY-MM-DD(생략하면 오늘)"},
        },
    }

    def run(self, args, ctx):
        try:
            base = date.fromisoformat(str(args.get("base") or "").strip() or ctx.today)
        except ValueError:
            return SkillResult(ok=False, error_code="invalid",
                               message="base 는 YYYY-MM-DD 형식이어야 합니다.")
        try:
            days = int(args.get("days") or 0)
            weeks = int(args.get("weeks") or 0)
            months = int(args.get("months") or 0)
            years = int(args.get("years") or 0)
        except (TypeError, ValueError):
            return SkillResult(ok=False, error_code="invalid",
                               message="days·weeks·months·years 는 정수여야 합니다.")
        if abs(days) + abs(weeks) * 7 + abs(months) * 31 + abs(years) * 366 > _MAX_STEP:
            return SkillResult(ok=False, error_code="invalid",
                               message="너무 먼 날짜입니다(20년 이내로).")
        try:
            out = _add_months(base, months + years * 12) + timedelta(days=days + weeks * 7)
        except (ValueError, OverflowError):
            return SkillResult(ok=False, error_code="invalid", message="날짜를 만들 수 없습니다.")

        want = str(args.get("weekday") or "").strip()[:1]
        if want:
            if want not in _WEEKDAYS:
                return SkillResult(ok=False, error_code="invalid",
                                   message="weekday 는 월·화·수·목·금·토·일 중 하나여야 합니다.")
            # 그 날이 든 주(월요일 시작) 안에서 그 요일로 옮긴다. "다음 주 화요일"은
            # weeks=1 + weekday='화' 로 오는데, 오늘이 무슨 요일이든 같은 답이 나와야 한다.
            out += timedelta(days=_WEEKDAYS[want] - out.weekday())

        today = date.fromisoformat(ctx.today)
        return SkillResult(
            ok=True,
            message=f"{out.isoformat()} ({_NAMES[out.weekday()]}요일)",
            data={
                "date": out.isoformat(),
                "weekday": _NAMES[out.weekday()],
                "days_from_today": (out - today).days,
                "base": base.isoformat(),
            },
        )


DATE_SKILLS: list[SkillBase] = [ShiftDate()]
