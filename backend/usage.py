"""사용량 집계 — **수치만** 모은다.

users/<u>/usage/<YYYY-MM>.json
  {
    "tokens": {"total": int, "prompt": int, "output": int, "calls": int,
               "by_model": {"<model>": {...}}},
    "pages":  {"<route>": {"seconds": float, "views": int}},
    "moves":  {"<from>><to>": int},
    "days":   {"YYYY-MM-DD": {"seconds": float, "tokens": int, "calls": int}}
  }

**여기에는 사용자가 쓴 내용이 한 글자도 들어가지 않는다.** 화면 이름은 아래
`ROUTES` 에 적힌 것만 받고, 그 밖의 주소는 전부 "기타"로 접는다 — 논문 id 나
문서 경로가 주소에 섞여 들어와 통계라는 이름으로 새는 것을 구조로 막는다.

주인이 다른 사용자의 사용량을 보는 화면이 이 파일을 읽는다. 그 화면이 실수로
본문을 비추지 못하게, 애초에 본문을 모으지 않는 것이 유일하게 확실한 방법이다.
"""
from __future__ import annotations

import re
import time
from datetime import date, datetime

from . import json_store
from .auth import SessionUser
from .config import Settings

#: 통계에 남길 수 있는 화면. 앱의 라우트 목록이지 사용자 자료가 아니다.
ROUTES = (
    "/", "/notes", "/graph", "/calendar", "/todo", "/assistant", "/english",
    "/papers", "/meetings", "/context", "/trash", "/settings", "/profile",
    "/terminal", "/analytics",
)
OTHER = "기타"

#: 한 번에 받을 수 있는 체류 시간의 상한(초). 탭을 켜 두고 잔 것을 '사용'으로
#: 세면 하루가 24시간을 넘고, 그 뒤로는 어떤 비교도 뜻이 없어진다.
MAX_DWELL = 30 * 60

_YM = re.compile(r"^\d{4}-\d{2}$")


def norm_route(path: str) -> str:
    """주소 → 통계에 쓸 화면 이름. 모르는 것은 전부 '기타'."""
    p = str(path or "").split("?")[0].split("#")[0].rstrip("/") or "/"
    return p if p in ROUTES else OTHER


def this_month() -> str:
    return date.today().strftime("%Y-%m")


def check_month(ym: str) -> str:
    s = str(ym or "").strip()
    return s if _YM.match(s) else this_month()


def _path(user: SessionUser | str, settings: Settings, ym: str):
    name = user if isinstance(user, str) else user.username
    base = settings.user_root(name) / "usage"
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{check_month(ym)}.json"


def _blank() -> dict:
    return {"tokens": {"total": 0, "prompt": 0, "output": 0, "calls": 0, "by_model": {}},
            "pages": {}, "moves": {}, "days": {}}


def _read(user, settings: Settings, ym: str) -> dict:
    data = json_store.read_json(_path(user, settings, ym), None)
    if not isinstance(data, dict):
        return _blank()
    out = _blank()
    for key in ("tokens", "pages", "moves", "days"):
        if isinstance(data.get(key), dict):
            out[key] = data[key]
    t = out["tokens"]
    for k in ("total", "prompt", "output", "calls"):
        t[k] = int(t.get(k) or 0)
    if not isinstance(t.get("by_model"), dict):
        t["by_model"] = {}
    return out


def _today() -> str:
    return date.today().isoformat()


def _day_bucket(data: dict, day: str) -> dict:
    row = data["days"].get(day)
    if not isinstance(row, dict):
        row = {"seconds": 0.0, "tokens": 0, "calls": 0}
        data["days"][day] = row
    return row


def add_tokens(user, settings: Settings, *, model: str,
               prompt: int, output: int, total: int = 0) -> None:
    """모델 호출 한 번의 토큰을 더한다. 실패해도 조용히 넘어간다.

    집계 때문에 대화가 끊기면 안 된다 — 사용량은 곁다리고 답이 본체다.
    """
    prompt, output = max(0, int(prompt or 0)), max(0, int(output or 0))
    total = max(0, int(total or 0)) or (prompt + output)
    if not total:
        return
    p = _path(user, settings, this_month())
    try:
        with json_store.lock_for(p):
            data = _read(user, settings, this_month())
            t = data["tokens"]
            t["total"] += total
            t["prompt"] += prompt
            t["output"] += output
            t["calls"] += 1
            m = str(model or "?")[:64]
            row = t["by_model"].setdefault(m, {"total": 0, "prompt": 0, "output": 0, "calls": 0})
            row["total"] += total
            row["prompt"] += prompt
            row["output"] += output
            row["calls"] += 1
            day = _day_bucket(data, _today())
            day["tokens"] = int(day.get("tokens") or 0) + total
            day["calls"] = int(day.get("calls") or 0) + 1
            json_store.write_atomic(p, data)
    except Exception:  # noqa: BLE001 - 집계 실패가 대화를 막지 않는다
        pass


def add_page(user, settings: Settings, *, route: str, seconds: float, came_from: str = "") -> None:
    """화면 한 곳에 머문 시간을 더한다. 화면 이름은 ROUTES 로 접어서 받는다."""
    r = norm_route(route)
    secs = min(max(float(seconds or 0), 0.0), MAX_DWELL)
    p = _path(user, settings, this_month())
    try:
        with json_store.lock_for(p):
            data = _read(user, settings, this_month())
            row = data["pages"].setdefault(r, {"seconds": 0.0, "views": 0})
            row["seconds"] = round(float(row.get("seconds") or 0) + secs, 1)
            row["views"] = int(row.get("views") or 0) + 1
            if came_from:
                key = f"{norm_route(came_from)}>{r}"
                data["moves"][key] = int(data["moves"].get(key) or 0) + 1
            day = _day_bucket(data, _today())
            day["seconds"] = round(float(day.get("seconds") or 0) + secs, 1)
            json_store.write_atomic(p, data)
    except Exception:  # noqa: BLE001
        pass


def month_tokens(user, settings: Settings, ym: str = "") -> int:
    """그 달에 쓴 토큰 합계. 계정 관리 목록이 이름 옆에 이것만 보여 준다."""
    return int(_read(user, settings, check_month(ym or this_month()))["tokens"]["total"])


def months(user, settings: Settings) -> list[str]:
    """자료가 있는 달(최근 순)."""
    name = user if isinstance(user, str) else user.username
    base = settings.user_root(name) / "usage"
    if not base.exists():
        return []
    out = [f.stem for f in base.glob("*.json") if _YM.match(f.stem)]
    return sorted(out, reverse=True)


def _counts(user, settings: Settings) -> dict:
    """가지고 있는 것의 **개수**. 제목도 경로도 세지 않는다.

    저장소마다 읽는 법이 달라 한 곳에서 모아 둔다. 한 갈래가 깨져도 나머지는
    나와야 하므로 각각 따로 감싼다.
    """
    name = user if isinstance(user, str) else user.username
    root = settings.user_root(name)
    out: dict[str, int] = {}

    def safe(key: str, fn) -> None:
        try:
            out[key] = int(fn())
        except Exception:  # noqa: BLE001
            out[key] = 0

    def count_json(rel: str, field: str) -> int:
        data = json_store.read_json(root / rel, None)
        if isinstance(data, dict):
            v = data.get(field)
            return len(v) if isinstance(v, (list, dict)) else 0
        return len(data) if isinstance(data, list) else 0

    # 문서: data/ 아래 파일 수(폴더 제외). 이름은 세지 않는다.
    safe("documents", lambda: sum(1 for f in (root / "data").rglob("*") if f.is_file()))
    safe("papers", lambda: count_json("papers/index.json", "papers"))
    safe("meetings", lambda: count_json("meetings/index.json", "meetings"))
    safe("events", lambda: count_json("calendar/events.json", "events"))
    safe("todos", lambda: count_json("todo/todo.json", "todos"))
    safe("todo_categories", lambda: count_json("todo/todo.json", "categories"))
    safe("vocab", lambda: count_json("vocab/vocab.json", "words"))
    safe("diary_days", lambda: count_json("diary/diary.json", "days"))
    safe("trash", lambda: count_json(".trash/index.json", ""))
    return out


def _context(user, settings: Settings) -> dict:
    """대화 공간의 크기 — 세션 수, 턴 수, 글자 수. **내용은 읽지 않는다.**"""
    name = user if isinstance(user, str) else user.username
    root = settings.user_root(name)
    spaces = turns = chars = 0
    try:
        from . import context_store

        for space in context_store.space_rows(name if isinstance(user, str) else user, settings):
            msgs = context_store.load_space(
                name if isinstance(user, str) else user, settings, space["space"])
            if not msgs:
                continue
            spaces += 1
            turns += len(msgs)
            chars += sum(len(str(m.get("text") or "")) for m in msgs)
    except Exception:  # noqa: BLE001
        # 공간 목록을 못 읽으면 파일 크기로라도 규모는 낸다(내용은 안 연다)
        for f in list(root.glob("ai/*.json")) + list(root.glob("chats/*.json")):
            try:
                chars += f.stat().st_size
                spaces += 1
            except OSError:
                pass
    return {"spaces": spaces, "turns": turns, "chars": chars}


def summary(user, settings: Settings, ym: str = "") -> dict:
    """한 사용자의 **수치만** 담은 요약. 화면이 그리는 것이 이게 전부다."""
    month = check_month(ym or this_month())
    data = _read(user, settings, month)
    pages = {
        r: {"seconds": round(float(v.get("seconds") or 0), 1), "views": int(v.get("views") or 0)}
        for r, v in data["pages"].items() if isinstance(v, dict)
    }
    moves = sorted(
        ({"from": k.split(">")[0], "to": k.split(">")[-1], "count": int(n)}
         for k, n in data["moves"].items() if ">" in str(k)),
        key=lambda m: -m["count"],
    )[:20]
    days = {
        d: {"seconds": round(float(v.get("seconds") or 0), 1),
            "tokens": int(v.get("tokens") or 0), "calls": int(v.get("calls") or 0)}
        for d, v in sorted(data["days"].items()) if isinstance(v, dict)
    }
    total_secs = round(sum(p["seconds"] for p in pages.values()), 1)
    return {
        "username": user if isinstance(user, str) else user.username,
        "month": month,
        "months": months(user, settings),
        "tokens": data["tokens"],
        "pages": pages,
        "moves": moves,
        "days": days,
        "total_seconds": total_secs,
        "total_views": sum(p["views"] for p in pages.values()),
        "counts": _counts(user, settings),
        "context": _context(user, settings),
        "generated_at": time.time(),
    }


def last_seen(user, settings: Settings) -> float:
    """마지막으로 화면을 본 시각(epoch). 자료가 없으면 0."""
    ms = months(user, settings)
    if not ms:
        return 0.0
    data = _read(user, settings, ms[0])
    days = [d for d in data["days"] if isinstance(d, str)]
    if not days:
        return 0.0
    try:
        return datetime.fromisoformat(max(days)).timestamp()
    except ValueError:
        return 0.0
