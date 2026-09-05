"""기록(상태·일기) 스킬 — 캘린더의 '기록' 보기가 쓰는 그 저장소를 AI 도 쓴다.

없을 때는 모델이 "오늘 힘들었다고 기록해 줘"를 **문서 만들기**로 처리했다(실측).
그러면 캘린더의 기록 화면에는 아무것도 안 남아 사용자가 쓴 줄 알았다가 잃는다.

상태는 세 축(육체/마음/정신)이고 값은 도형 하나다. 모델은 "힘들었어" 처럼 말로
주므로 여기서 도형으로 옮긴다 — 영어 이름(square)과 한국어(힘듦) 둘 다 받는다.
"""
from __future__ import annotations

from datetime import date, timedelta

from ... import diary_store
from ..skill_base import SkillBase, SkillResult
from .todo import _fail

#: 도형 ↔ 사람 말. 모델이 어느 쪽으로 주든 받는다.
SHAPE_WORDS = {
    "star": ("매우 좋음", "아주 좋음", "최고", "너무 좋음"),
    "circle": ("좋음", "괜찮음", "좋았음", "무난히 좋음"),
    "triangle": ("보통", "그저 그럼", "평범"),
    "square": ("힘듦", "나쁨", "안 좋음", "힘들었음", "지침"),
    "pentagon": ("매우 힘듦", "아주 힘듦", "최악", "너무 힘듦"),
}
_WORD_TO_SHAPE = {w: s for s, words in SHAPE_WORDS.items() for w in words}
_AXIS_LABEL = {"body": "육체", "heart": "마음", "mind": "정신"}
_LABEL_TO_AXIS = {v: k for k, v in _AXIS_LABEL.items()}


def _to_shape(v) -> str:
    """'square' 도 '힘듦' 도 받는다. 못 알아들으면 빈 문자열(=표시 안 함)."""
    s = str(v or "").strip().lower()
    if not s:
        return ""
    if s in diary_store.SHAPES:
        return s
    return _WORD_TO_SHAPE.get(str(v).strip(), "")


def _row(e: dict) -> dict:
    def word(axis: str) -> str:
        sh = e.get(axis) or ""
        return f"{SHAPE_WORDS[sh][0]}({sh})" if sh in SHAPE_WORDS else "(없음)"

    return {
        "date": e.get("date", ""),
        "육체": word("body"),
        "마음": word("heart"),
        "정신": word("mind"),
        "일기": str(e.get("text") or ""),
    }


class GetDiary(SkillBase):
    name = "get_diary"
    description = (
        "그날의 상태(육체·마음·정신)와 일기를 읽는다. 캘린더 '기록' 보기와 같은 자료다. "
        "date 하나만 주면 그날, days 를 주면 오늘부터 거슬러 그만큼. "
        "'요즘 컨디션 어때', '이번 주 어땠지' 같은 물음에 쓴다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "date": {"type": "string", "description": "YYYY-MM-DD. 비우면 오늘."},
            "days": {"type": "integer", "description": "오늘부터 거슬러 며칠치(최대 60). 주면 date 는 무시."},
        },
    }

    def run(self, args, ctx):
        try:
            days = int(args.get("days") or 0)
            if days > 0:
                days = min(days, 60)
                end = date.today()
                start = end - timedelta(days=days - 1)
                rows = diary_store.list_range(ctx.user, ctx.settings, start.isoformat(), end.isoformat())
                out = [_row(e) for e in rows]
                return SkillResult(ok=True, message=f"기록 {len(out)}일치", data={"days": out})
            day = str(args.get("date") or "").strip() or date.today().isoformat()
            e = diary_store.get_day(ctx.user, ctx.settings, day)
        except Exception as ex:  # noqa: BLE001
            return _fail(ex)
        return SkillResult(ok=True, message=f"{e['date']} 기록", data=_row(e))


class SetDiary(SkillBase):
    mutates = "diary"
    name = "set_diary"
    description = (
        "그날의 상태와 일기를 적는다(캘린더 '기록' 보기에 그대로 나타난다). "
        "'오늘 몸이 힘들었어', '일기 써 줘' 같은 말은 문서를 만들지 말고 **이 스킬로** 남긴다. "
        "축은 셋(육체·마음·정신)이고 값은 매우 좋음/좋음/보통/힘듦/매우 힘듦 중 하나다. "
        "사용자가 말하지 않은 축은 주지 마세요(빈 값으로 두면 화면에 '-' 로 나온다). "
        "일기는 append=true 면 뒤에 잇고, 아니면 통째로 바꾼다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "date": {"type": "string", "description": "YYYY-MM-DD. 비우면 오늘."},
            "body": {"type": "string", "description": "육체 상태. '매우 좋음|좋음|보통|힘듦|매우 힘듦'"},
            "heart": {"type": "string", "description": "마음 상태. 같은 값들"},
            "mind": {"type": "string", "description": "정신 상태. 같은 값들"},
            "text": {"type": "string", "description":
                     "일기 본문. **사용자가 자기 일기로 읽을 문장**으로 적는다 — "
                     "'하루 종일 코딩했다' 처럼. 지시를 옮겨 적지 마세요('…했다고'는 틀렸다)."},
            "append": {"type": "boolean", "description": "true 면 기존 일기 뒤에 잇는다."},
        },
    }

    def run(self, args, ctx):
        day = str(args.get("date") or "").strip() or date.today().isoformat()
        patch: dict = {}
        for axis in diary_store.AXES:
            if args.get(axis) is not None:
                patch[axis] = _to_shape(args.get(axis))
        text = args.get("text")
        try:
            if text is not None:
                new = str(text)
                if args.get("append"):
                    cur = str(diary_store.get_day(ctx.user, ctx.settings, day).get("text") or "")
                    new = (cur + "\n" + new).strip() if cur else new
                patch["text"] = new
            if not patch:
                return SkillResult(ok=False, message="적을 내용이 없습니다.", error_code="invalid")
            e = diary_store.save_day(ctx.user, ctx.settings, day, patch)
        except Exception as ex:  # noqa: BLE001
            return _fail(ex)
        bits = [f"{_AXIS_LABEL[a]} {SHAPE_WORDS[e[a]][0]}" for a in diary_store.AXES
                if e.get(a) in SHAPE_WORDS]
        if e.get("text"):
            bits.append(f"일기 {len(e['text'])}자")
        return SkillResult(ok=True, message=f"{day} 기록 — " + (", ".join(bits) or "비움"), data=_row(e))


DIARY_SKILLS: list[SkillBase] = [GetDiary(), SetDiary()]
