"""일정 시각 문자열의 단일 해석 규칙.

여기가 생긴 이유: 시각을 받아들이는 곳이 여럿(AI 스킬, HTTP 라우터, 저장소)인데
어디에도 검증이 없었고, 저장소의 파서는 실패를 조용히 삼켜 `datetime.min`을
돌려줬다. 그래서 실제로 이런 일이 났다.

- 모델이 `2026-9-3T16:00:00`(자리수 부족)을 주면 "일정 수정됨"이라고 답한 뒤
  그 일정이 **모든 조회에서 사라졌다**. 어떤 창에도 안 걸리기 때문이다.
- 모델이 `2026-09-02T10:00:00+09:00`(타임존 포함)을 주면 그 일정이 저장된 뒤로
  그 사용자의 **캘린더 전체**가 조회 불가가 됐다
  (`can't compare offset-naive and offset-aware datetimes`).
- 조회 기간에 `다음주` 같은 말을 주면 전 기간이 조용히 대상이 됐다.

규칙은 하나다. **받아들일 수 있으면 정규화하고, 못 알아들으면 거절한다.**
조용히 넘어가지 않는다.
"""
from __future__ import annotations

import re
from datetime import date, datetime

#: 'YYYY-M-D' 처럼 자리수가 덜 맞는 표기도 받는다 — 모델이 흔히 그렇게 준다.
_LOOSE = re.compile(
    r"^(?P<y>\d{4})-(?P<mo>\d{1,2})-(?P<d>\d{1,2})"
    r"(?:[T ](?P<h>\d{1,2}):(?P<mi>\d{2})(?::(?P<s>\d{2})(?:\.\d+)?)?)?"
    r"\s*(?P<tz>Z|[+-]\d{2}:?\d{2})?$"
)

#: 반복 간격 상한. `interval=100000`짜리 연간 반복 하나가 들어오면
#: 다음 회차 계산이 `year 102026 is out of range`로 터져 조회가 통째로 죽었다.
MAX_INTERVAL = 1000


class BadDateTime(ValueError):
    """시각 문자열을 알아들을 수 없다."""


def parse(value, *, field: str = "시각") -> datetime:
    """느슨한 표기를 datetime으로. 타임존은 떼어낸다(저장은 로컬 기준 naive)."""
    s = str(value or "").strip()
    if not s:
        raise BadDateTime(f"{field}이(가) 비어 있습니다.")
    m = _LOOSE.match(s)
    if not m:
        raise BadDateTime(
            f"{field} '{s}'을(를) 알아들을 수 없습니다. "
            "YYYY-MM-DD 또는 YYYY-MM-DDTHH:MM:SS 형식으로 주세요."
        )
    try:
        return datetime(
            int(m.group("y")), int(m.group("mo")), int(m.group("d")),
            int(m.group("h") or 0), int(m.group("mi") or 0), int(m.group("s") or 0),
        )
    except ValueError as e:  # 2026-02-30 같은 없는 날짜
        raise BadDateTime(f"{field} '{s}': {e}") from e


def to_iso(value, *, field: str = "시각", date_only: bool = False) -> str:
    """정규화된 문자열로. 못 알아들으면 BadDateTime."""
    dt = parse(value, field=field)
    return dt.strftime("%Y-%m-%d" if date_only else "%Y-%m-%dT%H:%M:%S")


def has_time(value) -> bool:
    """시각까지 준 표기인가('2026-09-01'이 아니라 '2026-09-01T10:00')."""
    m = _LOOSE.match(str(value or "").strip())
    return bool(m and m.group("h") is not None)


def naive(dt: datetime) -> datetime:
    """이미 저장된 값이 타임존을 달고 있어도 비교가 터지지 않게.

    새로 들어오는 값은 parse가 막지만, 이 방어가 있어야 예전에 들어간
    한 건 때문에 캘린더 전체가 죽는 일이 다시 없다.
    """
    return dt.replace(tzinfo=None) if dt.tzinfo is not None else dt


def clamp_interval(value) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 1
    return max(1, min(MAX_INTERVAL, n))


def parse_date_only(value, *, field: str = "날짜") -> date:
    return parse(value, field=field).date()
