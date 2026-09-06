"""기록(일기·상태) 저장소 — 캘린더의 '기록' 모드가 쓴다.

users/<u>/diary/diary.json
  {days: {"YYYY-MM-DD": {body, heart, mind, text, updated_at}}}

body/heart/mind(육체/마음/정신)는 도형 이름 하나이거나 빈 문자열:
  star(매우 좋음) · circle(좋음) · triangle(보통) · square(힘듦) · pentagon(매우 힘듦)
비어 있으면 "표시하지 않음" — 캘린더 칸에서 '-' 로 나온다.
세 축과 일기가 모두 비면 그 날짜는 통째로 지운다(칸에 아무것도 안 보여야 한다).
"""
from __future__ import annotations

import re
import time
from datetime import date

from fastapi import HTTPException
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from . import json_store
from .accounts import hash_password, verify_password
from .auth import SessionUser
from .config import Settings

SHAPES = ("star", "circle", "triangle", "square", "pentagon")
AXES = ("body", "heart", "mind")
MAX_TEXT = 20000
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _path(user: SessionUser, settings: Settings):
    base = settings.user_root(user.username) / "diary"
    base.mkdir(parents=True, exist_ok=True)
    return base / "diary.json"


def _load(user: SessionUser, settings: Settings) -> dict[str, dict]:
    data = json_store.read_json_strict(_path(user, settings), None)
    if not isinstance(data, dict):
        return {}
    days = data.get("days")
    if not isinstance(days, dict):
        return {}
    return {k: v for k, v in days.items() if isinstance(k, str) and isinstance(v, dict)}


def _save(days: dict[str, dict], user: SessionUser, settings: Settings) -> None:
    json_store.write_atomic(_path(user, settings), {"days": days})


def check_date(s: str) -> str:
    s = str(s or "").strip()
    if not _DATE.match(s):
        raise HTTPException(status_code=400, detail="날짜는 YYYY-MM-DD 형식이어야 합니다.")
    try:
        date.fromisoformat(s)
    except ValueError:
        raise HTTPException(status_code=400, detail="없는 날짜입니다.")
    return s


def _shape(v) -> str:
    s = str(v or "").strip().lower()
    if s and s not in SHAPES:
        raise HTTPException(status_code=400, detail="도형은 star/circle/triangle/square/pentagon 중 하나입니다.")
    return s


def _entry(day: str, raw: dict) -> dict:
    text = str(raw.get("text") or "")[:MAX_TEXT]
    return {
        "date": day,
        "body": raw.get("body") if raw.get("body") in SHAPES else "",
        "heart": raw.get("heart") if raw.get("heart") in SHAPES else "",
        "mind": raw.get("mind") if raw.get("mind") in SHAPES else "",
        "text": text,
        # 잠겨 있을 때는 text 를 지우고 이것만 보낸다 — 달력은 "일기가 있다"만
        # 알면 되고(체크 표시), 글은 비밀번호를 넣기 전에는 브라우저에 오지 않는다.
        "has_text": bool(text.strip()),
        "updated_at": float(raw.get("updated_at") or 0),
    }


def hide_text(entry: dict) -> dict:
    """잠긴 상태로 내보낼 모양. 도형·날짜는 그대로, 글만 뺀다."""
    return {**entry, "text": "", "locked": entry["has_text"]}


def empty(day: str) -> dict:
    return {"date": day, "body": "", "heart": "", "mind": "", "text": "",
            "has_text": False, "updated_at": 0.0}


def get_day(user: SessionUser, settings: Settings, day: str) -> dict:
    day = check_date(day)
    raw = _load(user, settings).get(day)
    return _entry(day, raw) if raw else empty(day)


def list_range(user: SessionUser, settings: Settings, start: str, end: str) -> list[dict]:
    """[start, end] 안의 기록. 캘린더 한 화면(6주)치를 한 번에 받는다."""
    start, end = check_date(start), check_date(end)
    if end < start:
        start, end = end, start
    days = _load(user, settings)
    out = [_entry(d, v) for d, v in days.items() if start <= d <= end]
    out.sort(key=lambda e: e["date"])
    return out


def save_day(user: SessionUser, settings: Settings, day: str, patch: dict) -> dict:
    """부분 수정. 준 필드만 바꾸고, 결과가 전부 비면 그 날짜를 지운다."""
    day = check_date(day)
    p = _path(user, settings)
    with json_store.lock_for(p):
        days = _load(user, settings)
        cur = _entry(day, days.get(day) or {})
        for axis in AXES:
            if axis in patch and patch[axis] is not None:
                cur[axis] = _shape(patch[axis])
        if "text" in patch and patch["text"] is not None:
            cur["text"] = str(patch["text"])[:MAX_TEXT]
        if not any(cur[a] for a in AXES) and not cur["text"].strip():
            days.pop(day, None)
            _save(days, user, settings)
            return empty(day)
        cur["updated_at"] = time.time()
        cur["has_text"] = bool(cur["text"].strip())
        days[day] = {k: cur[k] for k in ("body", "heart", "mind", "text", "updated_at")}
        _save(days, user, settings)
    return cur


# ── 일기 잠금 ────────────────────────────────────────────────────────
#
# 달력 칸의 도형은 그대로 두고 **글만** 가린다. 옆에서 화면을 보는 사람에게
# 그날의 기분은 보여도 일기 본문은 안 보이게 하는 것이 목적이다.
#
# 가리는 일을 화면에서만 하면 소용이 없다 — 글이 이미 브라우저에 와 있으면
# 개발자 도구로 그냥 읽힌다. 그래서 **서버가 안 보낸다**: 잠긴 동안 목록·단건
# 응답의 text 는 빈 문자열이고, 비밀번호를 맞힌 뒤 받은 표(token)를 헤더에
# 실어야 진짜 글이 온다.

DEFAULT_PIN = "0000"
_PIN = re.compile(r"^\d{4}$")
#: 잠금 표의 수명. 창을 오래 열어 둬도 언젠가는 다시 묻는다.
UNLOCK_TTL = 3600
_UNLOCK_SALT = "server.diary.unlock.v1"


def _lock_path(user: SessionUser, settings: Settings):
    base = settings.user_root(user.username) / "diary"
    base.mkdir(parents=True, exist_ok=True)
    #: 해시는 개인 설정(settings.json)에 두면 안 된다 — 설정은 통째로 화면에
    #: 내려가므로 4자리 해시가 함께 새고, 4자리는 손으로도 다 풀린다.
    return base / "lock.json"


def check_pin(value) -> str:
    s = str(value or "").strip()
    if not _PIN.match(s):
        raise HTTPException(status_code=400, detail="비밀번호는 숫자 4자리입니다.")
    return s


def _stored_pin(user: SessionUser, settings: Settings) -> str:
    row = json_store.read_json(_lock_path(user, settings), None)
    return str(row.get("pin") or "") if isinstance(row, dict) else ""


def pin_is_default(user: SessionUser, settings: Settings) -> bool:
    """아직 한 번도 안 바꿨는가(= 0000). 설정 화면이 표시에 쓴다."""
    return not _stored_pin(user, settings)


def verify_pin(user: SessionUser, settings: Settings, value) -> bool:
    stored = _stored_pin(user, settings)
    if not stored:
        # 한 번도 안 바꿨으면 초기 비밀번호. 해시를 미리 만들어 두지 않는 이유는
        # 그래야 "아직 기본값"인지 설정 화면에서 알 수 있기 때문이다.
        return str(value or "").strip() == DEFAULT_PIN
    return verify_password(str(value or "").strip(), stored)


def set_pin(user: SessionUser, settings: Settings, value) -> None:
    pin = check_pin(value)
    p = _lock_path(user, settings)
    with json_store.lock_for(p):
        json_store.write_atomic(p, {"pin": hash_password(pin), "updated_at": time.time()})


def _serializer(settings: Settings) -> URLSafeTimedSerializer:
    if not settings.session_secret:
        raise HTTPException(status_code=503, detail="SESSION_SECRET이 설정되지 않았습니다 (.env 확인).")
    return URLSafeTimedSerializer(settings.session_secret, salt=_UNLOCK_SALT)


def issue_unlock(user: SessionUser, settings: Settings, day: str) -> str:
    """**하루짜리** 표. 표에 날짜를 함께 서명한다.

    사람 것만 서명해 두면 한 번 맞힌 비밀번호가 그 뒤로 모든 날을 연다 —
    옆 사람에게 하루를 보여 주려고 푼 순간 달력 전체가 열리는 셈이라, 가리는
    뜻이 없어진다.
    """
    return _serializer(settings).dumps({"u": user.username, "d": check_date(day)})


def is_unlocked(token: str, user: SessionUser, settings: Settings, day: str) -> bool:
    """표가 이 사람의 **그 하루** 것이고 아직 살아 있는가.

    아니면 조용히 False(잠긴 채로 본다).
    """
    if not token or not settings.session_secret:
        return False
    try:
        data = _serializer(settings).loads(token, max_age=UNLOCK_TTL)
    except (BadSignature, SignatureExpired):
        return False
    except Exception:  # noqa: BLE001 - 망가진 표는 '잠김'이지 500 이 아니다
        return False
    if not isinstance(data, dict) or data.get("u") != user.username:
        return False
    return str(data.get("d") or "") == str(day or "")
