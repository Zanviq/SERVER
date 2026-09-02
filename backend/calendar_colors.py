"""Google Calendar colorId ↔ 한국어 이름 매핑.

캘린더 색이 숫자(1~11)로만 되어 있어, 사용자·AI가 '보라색'처럼 이름으로 지정할 수 있게
이름표와 별칭 해석을 제공한다. (프론트 GCAL_COLORS와 동일한 팔레트)
"""
from __future__ import annotations

# colorId → 대표 이름(표시용)
COLOR_NAMES: dict[str, str] = {
    "1": "라벤더(연보라)",
    "2": "연두(연한 초록)",
    "3": "자주",
    "4": "연한 주황(살구)",
    "5": "노랑",
    "6": "주황",
    "7": "하늘(파랑)",
    "8": "회색(갈색)",
    "9": "보라",
    "10": "초록",
    "11": "빨강",
}

# 이름/별칭(공백·대소문자 무시) → colorId
_ALIASES: dict[str, str] = {
    "라벤더": "1", "연보라": "1", "연한보라": "1",
    "연두": "2", "연두색": "2", "연한초록": "2", "라임": "2",
    "자주": "3", "자주색": "3", "마젠타": "3",
    "살구": "4", "연주황": "4", "연한주황": "4",
    "노랑": "5", "노란색": "5", "옐로": "5", "yellow": "5",
    "주황": "6", "주황색": "6", "오렌지": "6", "orange": "6",
    "하늘": "7", "하늘색": "7", "파랑": "7", "파란색": "7", "블루": "7", "blue": "7",
    "회색": "8", "갈색": "8", "그레이": "8", "gray": "8", "grey": "8",
    "보라": "9", "보라색": "9", "퍼플": "9", "purple": "9",
    "초록": "10", "초록색": "10", "녹색": "10", "그린": "10", "green": "10",
    "빨강": "11", "빨간색": "11", "레드": "11", "red": "11",
}


def resolve_color(value, default: str = "2") -> str:
    """색 지정값(colorId 또는 이름/별칭)을 colorId('1'~'11')로 해석."""
    if value is None:
        return default
    s = str(value).strip()
    if s in COLOR_NAMES:  # 이미 id
        return s
    key = s.replace(" ", "").lower()
    if key in _ALIASES:
        return _ALIASES[key]
    # 부분 포함 매칭 (예: '동아리보라' → 보라)
    for name, cid in _ALIASES.items():
        if name in key:
            return cid
    return default


class BadColor(Exception):
    """색 이름을 못 알아들었다."""


def strict_color(value) -> str:
    """색 이름 → colorId. 못 알아들으면 **예외**를 던진다.

    resolve_color 는 모르는 값에 기본값을 돌려준다. 그걸 그대로 쓰면 "민트색으로
    만들어줘"가 조용히 연두가 되고, 사용자는 자기가 말한 색과 다른 것을 보게 된다.
    조회 조건에 쓰면 색 조건이 통째로 사라져 일괄 작업이 엉뚱한 대상을 고른다.

    **일정·할 일 양쪽이 이 함수를 쓴다.** 예전에는 캘린더 스킬 안에만 있어서
    할 일 쪽은 관대한 규칙을 계속 썼다.
    """
    cid = resolve_color(value, "")
    if not cid:
        names = ", ".join(sorted(set(COLOR_NAMES.values())))
        raise BadColor(f"'{value}'가 어떤 색인지 모르겠습니다. 쓸 수 있는 색: {names}")
    return cid


def color_table_text() -> str:
    """시스템 프롬프트용 색상표 텍스트."""
    return "\n".join(f"  {cid} = {name}" for cid, name in COLOR_NAMES.items())
