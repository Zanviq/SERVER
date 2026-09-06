"""여러 화면에 흩어진 AI 대화를 한 자리에서 보는 층.

화면 하나 = 공간(space) 하나이고, 공간마다 파일이 따로 있다(chat_store 가 관리).
여기서는 그것들을 **가로질러** 훑는다 — 어떤 공간이 있는지, 그 안에 세션이 몇
개인지, 언제 무슨 이야기를 했는지.

  assistant        chats/assistant.json      비서 화면
  calendar         chats/calendar.json       캘린더 오른쪽 패널
  english          chats/english.json        영어 학습
  paper:<id>       papers/<id>/chat.json     논문마다
  meeting:<id>     meetings/<id>/chat.json   회의마다

세션은 저장할 때 정하지 않고 **읽을 때 시간 간격으로 나눈다**(SESSION_GAP_SEC).
저장해 두면 서버 재시작·탭 여러 개에서 경계가 어긋나는데, 간격으로 나누면 언제
계산해도 같은 답이 나오고 예전 기록에도 소급된다. 설계 배경은
`.claude/docs/context-design.md`.
"""
from __future__ import annotations

import re
import time

from fastapi import HTTPException

from . import chat_store, meeting_store, paper_store
from .auth import SessionUser
from .config import Settings

#: 이 시간 이상 말이 없으면 다음 메시지부터 새 세션으로 본다
SESSION_GAP_SEC = 30 * 60
#: 모델에 늘 들어가는 '최근' 의 기본 길이. 사용자가 정한 값(1일).
RECENT_WINDOW_SEC = 24 * 60 * 60
#: 검색이 한 번에 돌려주는 최대 건수
MAX_HITS = 50
#: 검색 결과에 붙이는 앞뒤 글자 수
SNIPPET_WINDOW = 160

#: 파일 하나뿐인(=화면 하나뿐인) 공간
FIXED_SPACES = {
    "assistant": "비서",
    "calendar": "캘린더",
    "english": "영어 학습",
}


def _fixed_path(user: SessionUser, settings: Settings, name: str):
    base = settings.user_root(user.username) / "chats"
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{name}.json"


def resolve_space(user: SessionUser, settings: Settings, space: str) -> str:
    """사람이 부른 이름을 공간 id 로 바꾼다.

    모델은 화면을 한국어 이름("영어 학습")이나 논문 제목으로 부른다. 그때마다
    404 로 튕기면 모델은 "그런 대화가 없다"고 단정해 버린다(실측). 알아들을 수
    있는 형태는 여기서 다 받아 준다 — 못 알아들을 때만 실패하고, 그때는 무엇을
    쓸 수 있는지 함께 알려 준다.
    """
    s = str(space or "").strip()
    if not s:
        raise HTTPException(status_code=404, detail="대화 공간을 지정하세요.")
    if s in FIXED_SPACES:
        return s
    # 접두사가 붙었으면 **여기서 실재를 확인한다.** 지금은 뒤의 paper_dir 가 id 모양을
    # 다시 보므로 안전하지만, 이 함수가 검증 없이 문자열을 돌려주면 앞으로 이 값을
    # 그대로 믿고 경로를 만드는 코드가 생겼을 때 뚫린다("paper:../../alice").
    if s.startswith("paper:"):
        paper_store.get_paper(user, settings, s[len("paper:"):])  # 없거나 모양이 틀리면 404
        return s
    if s.startswith("meeting:"):
        meeting_store.get_meeting(user, settings, s[len("meeting:"):])
        return s
    low = s.lower()
    # 한국어 이름 — "영어 학습", "영어학습", "비서" 모두 받는다
    flat = low.replace(" ", "")
    for key, label in FIXED_SPACES.items():
        if low == key or flat == label.replace(" ", "").lower():
            return key
    # 논문·회의는 제목으로도 부른다
    try:
        for p in paper_store.list_papers(user, settings):
            title = str(p.get("title") or "")
            if title and (low == title.lower() or low in title.lower()):
                return f"paper:{p['id']}"
    except Exception:  # noqa: BLE001
        pass
    try:
        for m in meeting_store.list_meetings(user, settings):
            title = str(m.get("title") or "")
            if title and (low == title.lower() or low in title.lower()):
                return f"meeting:{m['id']}"
    except Exception:  # noqa: BLE001
        pass
    known = ", ".join(f"{k}({v})" for k, v in FIXED_SPACES.items())
    raise HTTPException(
        status_code=404,
        detail=f"'{s}' 는 없는 대화 공간입니다. 쓸 수 있는 것: {known}, "
               "paper:<논문id>, meeting:<회의id>. list_context_spaces 로 확인하세요.",
    )


def space_path(user: SessionUser, settings: Settings, space: str):
    """공간 이름 → 파일. 없는 공간이면 404."""
    s = resolve_space(user, settings, space)
    if s in FIXED_SPACES:
        return _fixed_path(user, settings, s)
    if s.startswith("paper:"):
        pid = s[len("paper:"):]
        paper_store.get_paper(user, settings, pid)  # 없으면 404
        return paper_store.chat_path(user, settings, pid)
    mid = s[len("meeting:"):]
    meeting_store.get_meeting(user, settings, mid)  # 없으면 404
    return meeting_store.chat_path(user, settings, mid)


def _space_file(user: SessionUser, settings: Settings, space: str):
    """공간 이름 → 파일 경로. **있는지 확인하지 않는다.**

    `space_path` 는 부를 때마다 논문·회의 색인을 통째로 다시 읽어 존재를 확인한다
    (없는 공간에 404 를 주려는 것이고, 화면이 이름 하나를 물어볼 때는 맞다).
    그런데 **공간을 전부 훑는 자리**에서 그 확인이 공간 수만큼 되풀이되면
    O(n²)가 된다 — 논문 300 + 회의 300 일 때 전역 검색이 7.1초였다(실측).

    여기서 다루는 이름은 `all_spaces` 가 색인에서 뽑아 준 것이라 존재가 이미
    보장된다. 확인을 한 번 더 하는 것은 값을 얻지 못하고 시간만 쓴다.
    """
    if space in FIXED_SPACES:
        return _fixed_path(user, settings, space)
    if space.startswith("paper:"):
        return paper_store.chat_path(user, settings, space[len("paper:"):])
    return meeting_store.chat_path(user, settings, space[len("meeting:"):])


def _labels(user: SessionUser, settings: Settings) -> dict[str, str]:
    """공간 이름 → 사람이 읽는 이름. 색인을 **한 번만** 읽어 표로 만든다.

    공간마다 `space_label` 을 부르면 그때마다 색인을 다시 읽는다(같은 O(n²)).
    """
    out = dict(FIXED_SPACES)
    try:
        for p in paper_store.list_papers(user, settings):
            if p.get("id"):
                out[f"paper:{p['id']}"] = str(p.get("title") or p.get("filename") or "논문")
    except Exception:  # noqa: BLE001
        pass
    try:
        for m in meeting_store.list_meetings(user, settings):
            if m.get("id"):
                out[f"meeting:{m['id']}"] = str(m.get("title") or m.get("filename") or "회의")
    except Exception:  # noqa: BLE001
        pass
    return out


def space_label(user: SessionUser, settings: Settings, space: str) -> str:
    """사람이 읽는 이름. 논문·회의는 그 제목을 쓴다."""
    if space in FIXED_SPACES:
        return FIXED_SPACES[space]
    try:
        if space.startswith("paper:"):
            p = paper_store.find_paper(user, settings, space[len("paper:"):]) or {}
            return str(p.get("title") or p.get("filename") or "논문")
        if space.startswith("meeting:"):
            m = meeting_store.find_meeting(user, settings, space[len("meeting:"):]) or {}
            return str(m.get("title") or m.get("filename") or "회의")
    except Exception:  # noqa: BLE001
        pass
    return space


def space_kind(space: str) -> str:
    if space.startswith("paper:"):
        return "paper"
    if space.startswith("meeting:"):
        return "meeting"
    return space


def all_spaces(user: SessionUser, settings: Settings) -> list[str]:
    """이 사용자에게 있는 공간 이름 전부(대화가 비어 있어도 고정 공간은 낸다)."""
    out = list(FIXED_SPACES)
    try:
        out += [f"paper:{p['id']}" for p in paper_store.list_papers(user, settings) if p.get("id")]
    except Exception:  # noqa: BLE001
        pass
    try:
        out += [f"meeting:{m['id']}" for m in meeting_store.list_meetings(user, settings) if m.get("id")]
    except Exception:  # noqa: BLE001
        pass
    return out


def load_space(user: SessionUser, settings: Settings, space: str) -> list[dict]:
    try:
        return chat_store.load(space_path(user, settings, space))
    except HTTPException:
        return []


# ── 세션 ─────────────────────────────────────────────────────────────

def split_sessions(msgs: list[dict]) -> list[list[dict]]:
    """시간 간격으로 세션을 나눈다. 시각이 없는 옛 메시지는 앞 세션에 붙인다."""
    out: list[list[dict]] = []
    prev = 0.0
    for m in msgs:
        ts = float(m.get("ts") or 0)
        if not out or (ts and prev and ts - prev > SESSION_GAP_SEC):
            out.append([])
        out[-1].append(m)
        if ts:
            prev = ts
    return out


def session_id(session: list[dict]) -> str:
    """세션 첫 메시지 시각에서 만든다 — 다시 계산해도 같고 사람이 읽을 수 있다."""
    ts = next((float(m.get("ts") or 0) for m in session if m.get("ts")), 0.0)
    return f"s-{int(ts)}" if ts else "s-0"


def _preview(session: list[dict]) -> str:
    """세션 목록에 보일 한 줄 — 사용자가 먼저 한 말이 가장 알아보기 쉽다."""
    for m in session:
        if m.get("role") == "user" and str(m.get("text") or "").strip():
            return str(m["text"]).strip().replace("\n", " ")[:120]
    for m in session:
        if str(m.get("text") or "").strip():
            return str(m["text"]).strip().replace("\n", " ")[:120]
    return "(빈 대화)"


def session_rows(msgs: list[dict]) -> list[dict]:
    rows = []
    for s in split_sessions(msgs):
        times = [float(m.get("ts") or 0) for m in s if m.get("ts")]
        tools = sum(len((m.get("meta") or {}).get("tools") or []) for m in s)
        rows.append({
            "id": session_id(s),
            "started_at": min(times) if times else 0.0,
            "ended_at": max(times) if times else 0.0,
            "messages": len(s),
            "tools": tools,
            "preview": _preview(s),
        })
    rows.sort(key=lambda r: -r["started_at"])
    return rows


def space_rows(user: SessionUser, settings: Settings) -> list[dict]:
    """왼쪽 폴더 목록 + AI 의 list_context_spaces 가 함께 쓴다."""
    labels = _labels(user, settings)
    rows = []
    for space in all_spaces(user, settings):
        # 검색과 같은 이유로 색인을 다시 읽지 않는다(사용량 화면도 이 함수를 쓴다)
        msgs = chat_store.load(_space_file(user, settings, space))
        times = [float(m.get("ts") or 0) for m in msgs if m.get("ts")]
        rows.append({
            "space": space,
            "kind": space_kind(space),
            "label": labels.get(space, space),
            "messages": len(msgs),
            "sessions": len(split_sessions(msgs)) if msgs else 0,
            "last_at": max(times) if times else 0.0,
        })
    # 최근에 쓴 공간이 위로. 빈 공간은 아래로 밀린다.
    rows.sort(key=lambda r: (-r["last_at"], r["label"]))
    return rows


# ── 읽기 ─────────────────────────────────────────────────────────────

def _in_range(m: dict, since: float, until: float) -> bool:
    ts = float(m.get("ts") or 0)
    if since and ts and ts < since:
        return False
    if until and ts and ts > until:
        return False
    return True


def read(user: SessionUser, settings: Settings, space: str, *,
         since: float = 0, until: float = 0, session: str = "",
         limit: int = 0) -> list[dict]:
    """한 공간의 대화. 세션 id 를 주면 그 세션만, 시각을 주면 그 사이만."""
    msgs = load_space(user, settings, space)
    if session:
        for s in split_sessions(msgs):
            if session_id(s) == session:
                msgs = s
                break
        else:
            msgs = []
    else:
        msgs = [m for m in msgs if _in_range(m, since, until)]
    return msgs[-limit:] if limit > 0 else msgs


def recent_for_llm(msgs: list[dict], *, window_sec: float = RECENT_WINDOW_SEC,
                   max_turns: int = 80, max_chars: int = 24000,
                   now: float | None = None) -> list[dict]:
    """모델에 늘 들어가는 '최근'.

    시간·턴 수·글자 수 **셋 다**로 자른다. 하루 안에 장문 대화를 몰아서 하면
    시간만으로는 프롬프트가 터지고, 턴 수만으로는 어제 이야기가 통째로 사라진다.
    시각이 없는 옛 메시지는 창 안으로 본다(잘라 내면 기록이 통째로 없어진다).

    **자르는 일은 글자 수가 맡는다.** 턴 수 상한이 20 이던 때, 짧은 말 34개를
    주고받은 대화가 글자 예산의 1%(251/24000자)만 쓰고도 잘렸다. 밀려난 사실을
    물으면 모델은 꺼내 보지 않고 지어냈다("좋아하는 음식"에 말한 적 없는 '피자').
    턴 수는 이제 안전망일 뿐이고, 실제 한계는 글자 수다.
    """
    t0 = (now if now is not None else time.time()) - window_sec
    fresh = [m for m in msgs if not m.get("ts") or float(m["ts"]) >= t0]
    return chat_store.history_for_llm(fresh, max_turns=max_turns, max_chars=max_chars)


def truncation_note(total: int, shown: int, space: str, label: str) -> str:
    """잘린 만큼을 모델에게 알리는 한 줄.

    모르면 모델은 보이는 앞부분을 "대화의 시작"으로 단정한다 — 34턴 중 20턴만
    보이는데 "맨 처음에 …라고 하셨습니다" 하고 엉뚱한 말을 골랐다(실측).
    어떻게 꺼내는지까지 적어야 실제로 꺼내 본다.
    """
    dropped = max(0, total - shown)
    if dropped <= 0:
        return ""
    return (
        f"[대화 기록 안내] 아래 대화는 이 화면('{label}')의 **최근 {shown}턴뿐**이고, "
        f"그 앞에 {dropped}턴이 더 있습니다. 아래 첫 줄은 **대화의 시작이 아닙니다.** "
        f"'처음에', '아까', '지난번에' 같은 물음에는 아래만 보고 답하지 말고 "
        f"read_context(space=\"{space}\") 로 앞부분을 꺼내 확인한 뒤 답하세요.\n"
        f"**앞에서 한 말을 묻는데 아래 창에 없으면 지어내지 마세요.** "
        f"'내가 …라고 했지?', '…가 뭐였지?', '내가 뭘 …한다고 했지?' 같은 물음은 "
        f"낱말이 '처음에·아까'가 아니어도 모두 지난 대화를 묻는 것입니다. "
        f"반드시 read_context(space=\"{space}\") 로 찾아본 뒤 답하고, 찾지 못하면 "
        f"그럴듯한 답을 만들지 말고 \"기록에서 찾지 못했습니다\"라고 말하세요. "
        f"(실제로 '좋아하는 음식'을 묻자 말한 적 없는 '피자'라고 답한 적이 있습니다.)"
    )


# ── 검색 ─────────────────────────────────────────────────────────────

def _tokens(q: str) -> list[str]:
    return [t for t in re.split(r"\s+", str(q or "").strip().lower()) if t]


def _score(text: str, toks: list[str], phrase: str) -> int:
    """든 낱말 수로 매긴다. 임베딩 대신 쓰는 값싼 순위.

    **모두 들어야 한다고 하면 안 된다.** 모델은 "아까 뭘 보여 달라고 했지" 처럼
    문장으로 검색어를 넘기는데, 그러면 한 낱말만 어긋나도 0건이 되고 모델은
    "그런 대화가 없다"고 단정한다(실측). 하나라도 걸리면 후보로 두고 순위로 가른다.
    """
    low = text.lower()
    hit = sum(1 for t in toks if t in low)
    if not hit:
        return 0
    # 문장 전체가 그대로 든 대화가 가장 정확하다 — 크게 올려 준다
    return hit * 2 + (5 if phrase and phrase in low else 0)


def search(user: SessionUser, settings: Settings, query: str, *,
           spaces: list[str] | None = None, since: float = 0, until: float = 0,
           limit: int = 20) -> list[dict]:
    """공간을 가로질러 대화를 찾는다.

    벡터 검색이 아니라 **낱말이 든 메시지**를 점수순으로 내는 방식이다. 사용자 한
    명의 대화는 수백~수천 건이라 이걸로 충분하고, 임베딩을 만들려면 메시지마다
    외부 호출이 한 번 더 붙는다(요금·지연). 배경은 `.claude/docs/context-design.md`.
    """
    toks = _tokens(query)
    if not toks:
        return []
    phrase = str(query or "").strip().lower()
    targets = spaces or all_spaces(user, settings)
    labels = _labels(user, settings)
    hits: list[dict] = []
    for space in targets:
        # 공간마다 색인을 다시 읽지 않는다 — 그것이 이 검색을 O(n²)로 만들었다.
        msgs = chat_store.load(_space_file(user, settings, space))
        sessions = split_sessions(msgs)
        for s in sessions:
            sid = session_id(s)
            for m in s:
                if not _in_range(m, since, until):
                    continue
                text = str(m.get("text") or "")
                sc = _score(text, toks, phrase)
                if not sc:
                    continue
                # 걸린 낱말 중 **처음 나오는 것** 주위를 보여 준다(0번이 없을 수도 있다)
                low = text.lower()
                found = next((t for t in toks if t in low), toks[0])
                i = max(0, low.find(found))
                start = max(0, i - SNIPPET_WINDOW)
                end = min(len(text), i + len(found) + SNIPPET_WINDOW)
                hits.append({
                    "space": space,
                    "label": labels.get(space, space),
                    "session": sid,
                    "id": m.get("id", ""),
                    "role": m.get("role", ""),
                    "ts": float(m.get("ts") or 0),
                    "score": sc,
                    "snippet": ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else ""),
                })
    hits.sort(key=lambda h: (-h["score"], -h["ts"]))
    return hits[:max(1, min(limit, MAX_HITS))]
