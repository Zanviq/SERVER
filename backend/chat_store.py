"""화면별로 이어지는 AI 대화 기록.

비서 화면의 대화는 브라우저에만 있다(새로고침하면 사라진다). 영어 학습과 논문
화면은 다르다 — "지난주에 물어본 단어", "저 논문에서 했던 질문"이 다음 대화의
맥락이어야 하므로 서버에 남긴다.

한 공간(space) = 파일 하나, 그 안에 **대화 세션이 여러 개**:
  {sessions: [{id, title, created_at, updated_at,
               messages: [{id, role, text, ts, meta, parent}], head: "<id>",
               links: [{from_id, to_id}], vocab_done: ["<키>", …]}],
   active: "<세션 id>"}
  - 영어 학습:  users/<u>/chats/english.json
  - 논문:       users/<u>/papers/<id>/chat.json  (논문 폴더에 두어 휴지통과 함께 움직인다)

**세션과 가지는 다른 것이다.** 가지는 한 이야기 안에서 갈라지는 것이고(맥락을
나눠 쓴다), 세션은 아예 **다른 이야기**다(맥락을 전혀 안 쓴다). 지난주의 논문
질문과 오늘의 논문 질문이 한 줄로 이어지면 안 되는 것이 후자다.

옛 파일은 세션 층이 없다(`{messages, head, …}`). 읽을 때 세션 하나로 감싼다 —
파일을 미리 고쳐 쓰지 않는다.

**대화는 한 줄이 아니라 나무다.** 메시지마다 parent 가 있고, head 는 지금 보고
있는 끝자락이다. 다음 말은 head 에 붙는다. 과거의 어느 메시지에서든 새 가지를
낼 수 있어서, "1번에 대해 더 묻다가 2번으로 돌아가는" 일이 가능해진다.

  - 활성 줄기(thread) = head 에서 parent 를 타고 뿌리까지 올라간 뒤 뒤집은 것.
    화면에 보이는 것도, 모델에 들어가는 것도 이 줄기뿐이다. 다른 가지는 안 보이고
    맥락에도 안 들어간다 — 그게 가지를 나누는 이유다.
  - 옛 파일은 parent 가 없다. 읽을 때 **목록 순서대로 한 줄로 이어 준다**(_migrate).
    한 줄 대화는 가지가 하나뿐인 나무이므로 모양을 바꾸지 않아도 된다.
  - links 는 가지 사이의 **기억 연결**이다. 다른 가지의 맥락을 지금 가지로 끌어온다
    (from_id 가 있는 줄기를 to_id 차례의 맥락으로 넣는다).

메시지 수는 MAX_MESSAGES 로 자른다 — **세션마다가 아니라 공간 전체로** 센다.
세션을 몇 개 만들어도 파일 크기가 예전과 같아야 한다(한 번에 원자적으로 쓴다).
오래된 것부터 버리고, 비어 버린 세션은 접는다(지금 보고 있는 세션은 남긴다).
잘려 나간 부모를 가리키던 메시지는 뿌리가 된다 — 나무가 여럿이 될 수 있고(숲),
화면도 그렇게 그린다.
모델에 넣는 것은 그중 최근 일부뿐이고, 나머지는 검색(search)으로 찾는다.

vocab_done 은 **이미 처리한 단어 후보 목록**이다. 사용자가 체크 목록을 닫았거나
넣기를 눌렀으면 그 목록은 다시 뜨면 안 된다. 예전에는 이 상태가 브라우저 안에만
있어서, 새로고침하면 처리한 목록이 그대로 되살아났다 — 되살아난 목록은 체크도
풀려 있어서 **이미 넣은 단어를 한 번 더 넣게 만들었다**. 대화가 서버에 있으니
처리 여부도 서버에 있어야 한다.
"""
from __future__ import annotations

import time
import uuid
from pathlib import Path

from . import json_store
from .auth import SessionUser
from .config import Settings

MAX_MESSAGES = 600
MAX_TEXT = 20000
#: 처리한 후보 키를 남겨 두는 개수. 메시지보다 훨씬 적게 나오므로 넉넉하다.
MAX_DONE = 400
#: 가지 사이 기억 연결의 개수 상한
MAX_LINKS = 200
#: 한 공간에 둘 수 있는 대화 세션 수
MAX_SESSIONS = 30
#: 손으로 옮겨 둔 노드 자리의 개수 상한(지도에서 끌어다 놓은 것)
MAX_LAYOUT = 400
#: 자리 좌표의 허용 범위. 화면 밖 아주 먼 곳으로 밀어 두면 다시 찾을 수 없다.
LAYOUT_LIMIT = 100_000
#: 세션 이름 길이
MAX_TITLE = 60


def english_path(user: SessionUser, settings: Settings) -> Path:
    base = settings.user_root(user.username) / "chats"
    base.mkdir(parents=True, exist_ok=True)
    return base / "english.json"


def _migrate(msgs: list[dict]) -> None:
    """옛 파일(한 줄 대화)을 나무로 본다.

    parent 가 없는 메시지는 **목록에서 바로 앞의 것**을 부모로 삼는다. 한 줄
    대화는 가지가 하나뿐인 나무이므로 이것만으로 모양이 맞는다. 파일을 미리
    고쳐 쓰지 않는다 — 다음에 저장될 때 자연히 새 모양으로 남는다.
    """
    prev: str | None = None
    for m in msgs:
        if "parent" not in m:
            m["parent"] = prev
        prev = m.get("id")


def _clean_session(raw: dict, idx: int = 0) -> dict:
    """세션 하나를 읽을 수 있는 모양으로 맞춘다(나무 모양도 여기서 바로잡는다).

    id 가 없는 옛 세션에는 **자리 번호**로 이름을 준다. 여기서 uuid 를 새로 만들면
    읽을 때마다 id 가 달라져서, 화면이 방금 받은 id 로 "이 대화로 옮겨 줘"를 보내면
    404 가 난다(실측).
    """
    msgs = [m for m in raw.get("messages") or [] if isinstance(m, dict)]
    _migrate(msgs)
    ids = {m.get("id") for m in msgs}
    # 잘려 나간 부모를 가리키는 것은 뿌리로 만든다(미아를 남기지 않는다)
    for m in msgs:
        if m.get("parent") not in ids:
            m["parent"] = None
    head = str(raw.get("head") or "")
    links = raw.get("links")
    done = raw.get("vocab_done")
    return {
        "id": str(raw.get("id") or "") or f"s{idx}",
        "title": str(raw.get("title") or "")[:MAX_TITLE],
        "created_at": float(raw.get("created_at") or 0) or _first_ts(msgs),
        "updated_at": float(raw.get("updated_at") or 0) or _last_ts(msgs),
        "messages": msgs,
        # head 가 없거나 가리키는 것이 사라졌으면 마지막 메시지를 본다(옛 파일)
        "head": head if head in ids else (msgs[-1].get("id", "") if msgs else ""),
        "links": [
            {"from_id": str(l.get("from_id") or ""), "to_id": str(l.get("to_id") or "")}
            for l in links if isinstance(l, dict)
            and l.get("from_id") in ids and l.get("to_id") in ids
        ] if isinstance(links, list) else [],
        "vocab_done": [str(k) for k in done if k] if isinstance(done, list) else [],
        # 지도에서 손으로 옮겨 둔 노드 자리. 없으면 나무 모양대로 자동 배치한다.
        "layout": clean_layout(raw.get("layout"), ids),
    }


def clean_layout(raw, ids: set) -> dict[str, list[float]]:
    """{메시지 id: [x, y]} 만 남긴다.

    사라진 메시지의 자리는 버린다(나무에 없는 점은 그릴 수도 없다). 수가 아닌 값·
    NaN·터무니없이 먼 좌표는 받지 않는다 — 한 번 들어가면 지도를 열 때마다 나무가
    화면 밖으로 날아간다.
    """
    if not isinstance(raw, dict):
        return {}
    out: dict[str, list[float]] = {}
    for key, val in raw.items():
        if not isinstance(val, (list, tuple)) or len(val) != 2 or str(key) not in ids:
            continue
        try:
            x, y = float(val[0]), float(val[1])
        except (TypeError, ValueError):
            continue
        if x != x or y != y or abs(x) > LAYOUT_LIMIT or abs(y) > LAYOUT_LIMIT:
            continue
        out[str(key)] = [round(x, 1), round(y, 1)]
        if len(out) >= MAX_LAYOUT:
            break
    return out


def _first_ts(msgs: list[dict]) -> float:
    return float(next((m.get("ts") or 0 for m in msgs), 0)) or time.time()


def _last_ts(msgs: list[dict]) -> float:
    return float(next((m.get("ts") or 0 for m in reversed(msgs)), 0)) or time.time()


def new_session(title: str = "") -> dict:
    now = time.time()
    return {"id": uuid.uuid4().hex, "title": str(title or "")[:MAX_TITLE],
            "created_at": now, "updated_at": now,
            "messages": [], "head": "", "links": [], "vocab_done": [], "layout": {}}


#: 아직 아무것도 저장되지 않은 공간의 첫 세션 id. uuid 로 지으면 **읽을 때마다** 달라져서,
#: 요청을 받을 때 본 세션과 답을 붙일 때 찾는 세션이 서로 다른 것이 된다 — 차례를 물어본
#: 세션에 붙이게 하자(append 의 session_id) 새 공간의 첫 차례가 버려질 뻔했다(12차, 시험이
#: 잡았다). 옛 세션에 자리 번호로 id 를 주는 것(_clean_session)과 같은 교훈이다.
_FIRST_ID = "first"


def _placeholder() -> dict:
    """아직 저장되지 않은 빈 세션 — 몇 번을 읽어도 같은 id."""
    return {**new_session(), "id": _FIRST_ID}


def load_space(path: Path) -> dict:
    """공간 전체 — 세션 목록과 지금 보고 있는 세션.

    옛 파일은 세션 층이 없다(`{messages, head, …}`). 그것을 세션 하나로 감싼다.
    """
    data = json_store.read_json_strict(path, None)
    if not isinstance(data, dict):
        data = {}
    raw = data.get("sessions")
    if isinstance(raw, list) and raw:
        sessions = [_clean_session(s, i) for i, s in enumerate(raw) if isinstance(s, dict)]
    elif data.get("messages"):
        # 옛 파일 — 세션 하나로 감싼다. 파일을 미리 고쳐 쓰지 않는다.
        sessions = [_clean_session(data, 0)]
    else:
        sessions = []
    if not sessions:
        sessions = [_placeholder()]
    ids = {s["id"] for s in sessions}
    active = str(data.get("active") or "")
    return {
        "sessions": sessions,
        "active": active if active in ids else sessions[-1]["id"],
    }


def current(path: Path) -> dict:
    """지금 보고 있는 세션."""
    space = load_space(path)
    return next(s for s in space["sessions"] if s["id"] == space["active"])


#: 예전 이름 — 지금 세션의 나무를 돌려준다(부르는 곳이 많아 남겨 둔다)
def load_all(path: Path) -> dict:
    return current(path)


def load(path: Path) -> list[dict]:
    """지금 세션의 메시지."""
    return current(path)["messages"]


def load_every(path: Path) -> list[dict]:
    """**모든 세션**의 메시지를 시각순으로.

    검색과 '지난 대화 읽기'가 쓴다. 지금 세션만 보면 다른 세션에서 한 이야기를
    영영 못 찾는다 — 세션을 나눈 것이 기록을 잃는 일이 되면 안 된다.
    """
    out = [m for s in load_space(path)["sessions"] for m in s["messages"]]
    out.sort(key=lambda m: float(m.get("ts") or 0))
    return out


def vocab_done(path: Path) -> set[str]:
    """사용자가 이미 닫았거나 넣은 후보 목록의 키."""
    return set(current(path)["vocab_done"])


def _trim(space: dict) -> None:
    """공간 전체에서 오래된 메시지를 버린다.

    **세션마다 세지 않고 공간 전체로 센다.** 세션을 서른 개 만들어도 파일 크기가
    예전과 같아야 한다 — 한 번에 원자적으로 쓰는 파일이라 크기가 곧 위험이다.
    """
    if len(space["sessions"]) > MAX_SESSIONS:
        del space["sessions"][:-MAX_SESSIONS]
    sessions = space["sessions"]
    total = sum(len(s["messages"]) for s in sessions)
    over = total - MAX_MESSAGES
    if over > 0:
        # 오래된 세션부터 앞에서 깎는다
        for s in sorted(sessions, key=lambda x: x["updated_at"]):
            if over <= 0:
                break
            cut = min(over, len(s["messages"]))
            del s["messages"][:cut]
            over -= cut
    # 비어 버린 세션은 접는다. 지금 보고 있는 것과 아직 아무 말도 안 한 새 세션은 남긴다
    keep = [s for s in sessions
            if s["messages"] or s["id"] == space["active"] or not s["updated_at"]]
    space["sessions"] = keep or [_placeholder()]
    if space["active"] not in {s["id"] for s in space["sessions"]}:
        space["active"] = space["sessions"][-1]["id"]
    # 메시지가 깎여 나갔으면 나무·연결·끝자락을 다시 맞춘다
    for s in space["sessions"]:
        ids = {m.get("id") for m in s["messages"]}
        for m in s["messages"]:
            if m.get("parent") not in ids:
                m["parent"] = None
        if s["head"] not in ids:
            s["head"] = s["messages"][-1].get("id", "") if s["messages"] else ""
        s["links"] = [l for l in s["links"]
                      if l["from_id"] in ids and l["to_id"] in ids][-MAX_LINKS:]
        s["vocab_done"] = s["vocab_done"][-MAX_DONE:]
        s["layout"] = clean_layout(s.get("layout"), ids)


def _save_space(path: Path, space: dict) -> None:
    # **폴더를 만들지 않는다.** 논문·회의 대화는 그 항목 폴더 안에 있어서, 폴더를
    # 만드는 것이 곧 지워진 항목을 되살리는 것이다(목록에도 휴지통에도 없는 미아가
    # 된다). 고정 공간(영어 학습 등)의 chats/ 는 위 경로 함수들이 미리 만든다.
    _trim(space)
    json_store.write_atomic(path, space, create_parents=False)


def _save(path: Path, session: dict) -> None:
    """지금 세션 하나를 제자리에 써 넣는다(나머지 세션은 그대로)."""
    space = load_space(path)
    for i, s in enumerate(space["sessions"]):
        if s["id"] == session["id"]:
            space["sessions"][i] = session
            break
    else:
        space["sessions"].append(session)
    space["active"] = session["id"]
    _save_space(path, space)


def message(role: str, text: str, meta: dict | None = None, parent: str | None = None) -> dict:
    return {
        "id": uuid.uuid4().hex,
        "role": "assistant" if role == "assistant" else "user",
        "text": str(text or "")[:MAX_TEXT],
        "ts": time.time(),
        "meta": dict(meta or {}),
        "parent": parent or None,
    }


def thread(msgs: list[dict], head: str) -> list[dict]:
    """지금 보고 있는 줄기 — head 에서 뿌리까지 거슬러 올라간 뒤 시간순으로.

    화면에 보이는 것도 모델에 들어가는 것도 이것뿐이다. 다른 가지는 보이지도
    들어가지도 않는다 — 그게 가지를 나누는 이유다.
    """
    by_id = {m.get("id"): m for m in msgs if m.get("id")}
    if head not in by_id:
        head = msgs[-1].get("id", "") if msgs else ""
    out: list[dict] = []
    seen: set[str] = set()
    cur = head
    while cur and cur not in seen:
        seen.add(cur)
        m = by_id.get(cur)
        if not m:
            break
        out.append(m)
        cur = m.get("parent")
    out.reverse()
    return out


def session_by_id(path: Path, sid: str) -> dict | None:
    """그 세션(없으면 None — 그 사이 지웠을 수 있다)."""
    return next((s for s in load_space(path)["sessions"] if s["id"] == sid), None)


def append(path: Path, *msgs: dict, session_id: str | None = None) -> list[dict]:
    """세션에 메시지를 덧붙인다. 끝자락(head)은 마지막 것으로 옮긴다.

    session_id 를 주면 **그 세션에** 붙이고, 지금 보고 있는 세션은 바꾸지 않는다. 답이
    오는 동안 사용자가 새 대화로 옮겨 가도 이 차례는 **물어본 세션**에 남아야 한다 —
    예전에는 답이 끝날 때의 지금 세션에 붙어서, A 에서 물은 것이 방금 연 B 에 들어갔다
    (12차 실측). 그 세션이 그 사이 지워졌으면 붙이지 않는다(지운 것을 되살리지 않는다).
    주지 않으면 지금 세션이다.
    """
    with json_store.lock_for(path):
        space = load_space(path)
        sid = session_id or space["active"]
        data = next((s for s in space["sessions"] if s["id"] == sid), None)
        if data is None:
            return []
        added = [m for m in msgs if m]
        data["messages"].extend(added)
        if added:
            data["head"] = added[-1].get("id", "")
            data["updated_at"] = time.time()
            # 이름이 없는 세션은 **첫 질문**으로 이름을 짓는다. 목록에서 골라야
            # 하는데 전부 "새 대화"라면 고를 수가 없다.
            if not data["title"]:
                first = next((m for m in data["messages"] if m.get("role") == "user"), None)
                if first:
                    data["title"] = title_from(first.get("text", ""))
        _save_space(path, space)
        return data["messages"]


def title_from(text: str) -> str:
    """첫 질문에서 세션 이름을 만든다(한 줄, 짧게)."""
    from . import links  # 늦게 — links 는 저장소들을 두루 가져온다

    one = " ".join(str(text or "").split())
    # 논문 화면은 선택한 글을 인용으로 앞에 붙여 보낸다 — 그건 이름이 아니다
    if "[질문]" in one:
        one = one.split("[질문]", 1)[1].strip()
    # `[note/서버/기록.md] 요약해` → `기록.md 요약해`(목록 폭에 경로가 다 먹는다)
    one = links.plain(one)
    return one[:MAX_TITLE] or "새 대화"


def set_head(path: Path, mid: str) -> bool:
    """보고 있는 가지를 옮긴다. 없는 메시지면 False."""
    with json_store.lock_for(path):
        data = current(path)
        if mid not in {m.get("id") for m in data["messages"]}:
            return False
        data["head"] = mid
        _save(path, data)
    return True


def connect(path: Path, from_id: str, to_id: str, on: bool) -> bool:
    """가지 사이의 기억 연결을 걸거나 푼다.

    from_id 가 있는 줄기의 **갈라진 뒤 부분**이 to_id 차례의 맥락으로 들어간다.
    같은 줄기끼리는 이을 수 없다 — 이미 맥락이므로 두 번 넣을 뿐이다.
    """
    if not from_id or not to_id or from_id == to_id:
        return False
    with json_store.lock_for(path):
        data = current(path)
        ids = {m.get("id") for m in data["messages"]}
        if from_id not in ids or to_id not in ids:
            return False
        links = [l for l in data["links"]
                 if not (l["from_id"] == from_id and l["to_id"] == to_id)]
        if on:
            if _is_ancestor(data["messages"], from_id, to_id) or \
               _is_ancestor(data["messages"], to_id, from_id):
                return False
            links.append({"from_id": from_id, "to_id": to_id})
        data["links"] = links
        _save(path, data)
    return True


def _is_ancestor(msgs: list[dict], a: str, b: str) -> bool:
    """a 가 b 의 조상인가(같은 줄기인가)."""
    by_id = {m.get("id"): m for m in msgs}
    cur, seen = b, set()
    while cur and cur not in seen:
        if cur == a:
            return True
        seen.add(cur)
        cur = (by_id.get(cur) or {}).get("parent")
    return False


def set_branch_names(path: Path, names: dict[str, str]) -> int:
    """가지 이름을 메시지에 적어 둔다. 몇 개를 적었는지 돌려준다."""
    if not names:
        return 0
    with json_store.lock_for(path):
        data = current(path)
        n = 0
        for m in data["messages"]:
            name = names.get(str(m.get("id") or ""))
            if name:
                m.setdefault("meta", {})["branch_name"] = str(name)[:40]
                n += 1
        if n:
            _save(path, data)
        return n


def move_nodes(path: Path, positions: dict) -> dict[str, list[float]]:
    """지도에서 손으로 옮겨 둔 노드 자리를 저장한다(준 것만 바꾼다).

    값이 None 인 id 는 자리를 **지운다** — 그 노드는 다시 나무 모양대로 자동
    배치된다('정렬'이 이걸로 전부 지운다). 브라우저에만 두면 지도를 닫았다 열
    때마다 옮겨 둔 것이 사라진다.
    """
    with json_store.lock_for(path):
        data = current(path)
        ids = {str(m.get("id")) for m in data["messages"]}
        merged = dict(data.get("layout") or {})
        for key, val in (positions or {}).items():
            if val is None:
                merged.pop(str(key), None)
            else:
                merged[str(key)] = val
        data["layout"] = clean_layout(merged, ids)
        _save(path, data)
    return data["layout"]


def clear(path: Path) -> None:
    """지금 세션을 비운다(다른 세션은 그대로).

    후보 처리 기록·기억 연결도 함께 비운다 — 가리킬 것이 사라졌다.
    """
    with json_store.lock_for(path):
        data = current(path)
        _save(path, {**new_session(), "id": data["id"], "created_at": data["created_at"]})


# ── 세션 ─────────────────────────────────────────────────────────────

def session_title(s: dict) -> str:
    """목록에 보일 이름.

    이름이 없으면 **첫 질문**에서 만든다. 세션이 생기기 전부터 있던 대화에는
    이름이 없는데, 그것들이 전부 "새 대화"로 보이면 고를 수가 없다.
    """
    if s["title"]:
        return s["title"]
    first = next((m for m in s["messages"] if m.get("role") == "user"), None)
    return title_from(first.get("text", "")) if first else "새 대화"


def sessions_of(path: Path) -> dict:
    """세션 목록(가벼운 요약)과 지금 보고 있는 세션."""
    space = load_space(path)
    return {
        "active": space["active"],
        "sessions": [{
            "id": s["id"],
            "title": session_title(s),
            "turns": sum(1 for m in s["messages"] if m.get("role") == "user"),
            "created_at": s["created_at"],
            "updated_at": s["updated_at"],
        } for s in space["sessions"]],
    }


def start_session(path: Path, title: str = "") -> str:
    """새 대화를 시작하고 그리로 옮겨 간다. 새 세션의 id."""
    with json_store.lock_for(path):
        space = load_space(path)
        cur = next((s for s in space["sessions"] if s["id"] == space["active"]), None)
        # 아직 아무 말도 안 한 빈 세션이 있으면 그걸 쓴다 — "새 대화"를 여러 번
        # 눌렀다고 빈 껍데기가 쌓이면 목록이 못 쓰게 된다.
        if cur and not cur["messages"]:
            return cur["id"]
        fresh = new_session(title)
        space["sessions"].append(fresh)
        space["active"] = fresh["id"]
        _save_space(path, space)
        return fresh["id"]


def use_session(path: Path, sid: str) -> bool:
    """이 세션으로 옮겨 간다. 없으면 False."""
    with json_store.lock_for(path):
        space = load_space(path)
        if sid not in {s["id"] for s in space["sessions"]}:
            return False
        space["active"] = sid
        _save_space(path, space)
    return True


def rename_session(path: Path, sid: str, title: str) -> bool:
    with json_store.lock_for(path):
        space = load_space(path)
        for s in space["sessions"]:
            if s["id"] == sid:
                s["title"] = str(title or "").strip()[:MAX_TITLE]
                _save_space(path, space)
                return True
    return False


def drop_session(path: Path, sid: str) -> bool:
    """세션을 통째로 지운다. 마지막 하나는 비우기만 한다(고를 것이 없어지면 안 된다)."""
    with json_store.lock_for(path):
        space = load_space(path)
        keep = [s for s in space["sessions"] if s["id"] != sid]
        if len(keep) == len(space["sessions"]):
            return False
        if not keep:
            keep = [_placeholder()]
        space["sessions"] = keep
        if space["active"] == sid:
            space["active"] = keep[-1]["id"]
        _save_space(path, space)
    return True


def delete_message(path: Path, mid: str) -> bool:
    """이 메시지와 **그 아래 가지 전체**를 지운다.

    한 줄 대화에서는 한 줄만 지우는 것이었다. 나무에서는 밑에 달린 것을 남기면
    뿌리 없는 가지가 뜬다 — 지우려던 맥락이 사라진 채로 남는 셈이다.
    """
    with json_store.lock_for(path):
        data = current(path)
        cur = data["messages"]
        doomed = {mid}
        changed = True
        while changed:          # 자손을 모두 모은다
            changed = False
            for m in cur:
                if m.get("parent") in doomed and m.get("id") not in doomed:
                    doomed.add(m.get("id"))
                    changed = True
        nxt = [m for m in cur if m.get("id") not in doomed]
        if len(nxt) == len(cur):
            return False
        data["messages"] = nxt
        if data["head"] in doomed:
            data["head"] = ""   # _save 가 마지막 메시지로 되돌린다
        _save(path, data)
    return True


def mark_vocab_done(path: Path, key: str) -> None:
    """이 후보 목록은 사용자가 처리했다(닫았거나 넣었다) — 다시 띄우지 않는다.

    메시지가 아직 저장되기 전(스트리밍 중)에 눌러도 상관없게 **키**로 적어 둔다.
    메시지 id 로 적으면 답이 저장되기 전에 닫은 경우 가리킬 곳이 없다.
    """
    if not key:
        return
    with json_store.lock_for(path):
        data = current(path)
        if key in data["vocab_done"]:
            return
        data["vocab_done"].append(key)
        _save(path, data)


def linked_memories(msgs: list[dict], links: list[dict], head: str,
                    *, max_chars: int = 6000) -> list[dict]:
    """지금 줄기로 끌어올 **다른 가지의 기억**.

    to_id 가 지금 줄기 위에 있는 연결만 본다. 그 연결의 from_id 에서 **갈라진
    지점(공통 조상)까지**만 가져온다 — 공통 조상 위쪽은 이미 지금 줄기에 있어서
    다시 넣으면 같은 말이 두 번 들어간다.

    돌려주는 것은 [{title, turns:[{role, text}]}] 이다. 프롬프트 문장은 모델에
    넣는 쪽(라우터)이 만든다.
    """
    by_id = {m.get("id"): m for m in msgs if m.get("id")}
    on_thread = {m.get("id") for m in thread(msgs, head)}
    out: list[dict] = []
    budget = max_chars
    seen_sources: set[str] = set()
    for link in links:
        src, dst = link.get("from_id", ""), link.get("to_id", "")
        if dst not in on_thread or src in seen_sources or src not in by_id:
            continue
        seen_sources.add(src)
        # 갈라진 지점: src 의 조상 중 지금 줄기에 처음 닿는 곳
        fork, cur, guard = "", src, set()
        while cur and cur not in guard:
            guard.add(cur)
            if cur in on_thread:
                fork = cur
                break
            cur = (by_id.get(cur) or {}).get("parent")
        side: list[dict] = []
        cur, guard = src, set()
        while cur and cur != fork and cur not in guard:
            guard.add(cur)
            m = by_id.get(cur)
            if not m:
                break
            side.append(m)
            cur = m.get("parent")
        side.reverse()
        turns = []
        for m in side:
            text = str(m.get("text") or "")
            if not text.strip() or budget - len(text) < 0:
                continue
            budget -= len(text)
            turns.append({"role": m.get("role", "user"), "text": text})
        if turns:
            first = next((t["text"] for t in turns if t["role"] == "user"), turns[0]["text"])
            out.append({"title": first.strip().splitlines()[0][:40], "turns": turns})
    return out


def history_for_llm(msgs: list[dict], *, max_turns: int, max_chars: int) -> list[dict]:
    """모델에 넣을 최근 대화. 라우터의 history 제한과 같은 규칙(턴 수 + 총량)."""
    out: list[dict] = []
    budget = max_chars
    for m in reversed(msgs[-max_turns:]):
        text = str(m.get("text") or "")
        if not text.strip():
            continue
        if budget - len(text) < 0:
            break
        budget -= len(text)
        out.append({"role": m.get("role", "user"), "text": text})
    out.reverse()
    return out


def search(msgs: list[dict], query: str, *, limit: int = 20, window: int = 160) -> list[dict]:
    """대화에서 검색어가 든 메시지를 찾아 앞뒤 조금과 함께 돌려준다."""
    q = str(query or "").strip().lower()
    if not q:
        return []
    hits = []
    for m in msgs:
        text = str(m.get("text") or "")
        i = text.lower().find(q)
        if i < 0:
            continue
        start = max(0, i - window)
        end = min(len(text), i + len(q) + window)
        hits.append({
            "id": m.get("id", ""),
            "role": m.get("role", ""),
            "ts": m.get("ts", 0),
            "snippet": ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else ""),
        })
    return hits[-limit:]
