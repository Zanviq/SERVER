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


def color_table_text() -> str:
    """시스템 프롬프트용 색상표 텍스트."""
    return "\n".join(f"  {cid} = {name}" for cid, name in COLOR_NAMES.items())
