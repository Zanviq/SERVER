"""한 번에 모두 뒤지는 검색.

지금까지 검색은 화면마다 따로 있었다 — 노트에서는 노트만, 논문 화면에서는 논문만.
"저번에 그 회의에서 나온 그 용어"를 찾으려면 어느 화면에 있었는지를 먼저 떠올려야
했다. 기억하려고 쓰는 도구인데 기억을 요구한 셈이다.

여기서는 노트·논문·회의·단어·할 일·일정·대화를 한 번에 훑는다. 저장소가 전부 그
사용자 폴더 아래 JSON 이라 색인을 따로 두지 않아도 규모(수백~수천 건)에서 충분히
빠르다. 색인을 두면 저장 경로마다 갱신을 챙겨야 하고, 어긋나면 "분명히 있는데 안
나온다"가 된다 — 그 값이 이 규모에서는 비용을 넘지 못한다.
"""
from __future__ import annotations

from backend.auth import SessionUser
from backend.config import Settings

KINDS = ("note", "paper", "meeting", "vocab", "todo", "event", "chat")

# 한 갈래가 결과를 독차지하지 않게 갈래마다 상한을 둔다. 단어장은 수천 개가 되기
# 쉬워서 낮춘다(전부 보고 싶으면 영어 학습 화면에 제대로 된 목록이 있다).
PER_KIND = 8
SNIPPET = 120


def _snippet(text: str, q: str, width: int = SNIPPET) -> str:
    """찾은 낱말 언저리를 잘라 준다. 없으면 앞부분."""
    text = " ".join((text or "").split())
    if not text:
        return ""
    i = text.lower().find(q.lower())
    if i < 0:
        return text[:width] + ("…" if len(text) > width else "")
    start = max(0, i - width // 3)
    end = min(len(text), start + width)
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")


def _flat(item: dict, keys: tuple[str, ...]) -> str:
    """검색 대상 글을 한 줄로 모은다. 목록 항목(저자·키워드)도 낱말로 편다."""
    parts: list[str] = []
    for k in keys:
        v = item.get(k)
        if isinstance(v, (list, tuple)):
            parts.extend(str(x) for x in v if x)
        elif isinstance(v, dict):
            parts.extend(str(x) for x in v.values() if x)
        elif v:
            parts.append(str(v))
    return " ".join(parts)


def _hit(kind: str, ident: str, title: str, snippet: str = "", when: str = "",
         where: str = "", score: float = 0.0) -> dict:
    return {"kind": kind, "id": ident, "title": title, "snippet": snippet,
            "when": when, "where": where, "score": score}


def _score(q: str, title: str, body: str = "") -> float:
    """제목에 있으면 크게, 앞쪽일수록 조금 더. 없으면 본문 일치로 낮게."""
    ql, tl = q.lower(), (title or "").lower()
    if tl == ql:
        return 100.0
    if tl.startswith(ql):
        return 80.0
    if ql in tl:
        return 60.0 - min(20.0, tl.index(ql) * 0.5)
    if ql in (body or "").lower():
        return 20.0
    return 0.0


def _notes(user: SessionUser, settings: Settings, q: str) -> list[dict]:
    from backend import doc_cache
    from backend.file_kinds import is_editable
    from backend.storage import user_data_root, walk_files

    root = user_data_root(user, settings)
    ql = q.lower()
    out: list[dict] = []
    for f in walk_files(root):
        name = f.name
        title = name[:-3] if name.endswith(".md") else name
        if ql in title.lower():
            out.append(_hit("note", f.rel, title, "", "", "노트", _score(q, title)))
        elif is_editable(name):
            text = doc_cache.text_of(f.path, f.stat)
            if text and ql in text.lower():
                out.append(_hit("note", f.rel, title,
                                _snippet(text, q), "", "노트", _score(q, title, text)))
        if len(out) >= PER_KIND * 3:   # 뒤에서 점수로 자른다
            break
    return out


#: 본문까지 뒤질 때 한 번에 읽을 총량. 논문 본문은 편당 수십~수백 KB 라
#: 제한이 없으면 검색 한 번이 수십 MB 를 읽는다.
_PAPER_TEXT_BUDGET = 4_000_000


def _papers(user: SessionUser, settings: Settings, q: str) -> list[dict]:
    """제목·요약에 없으면 **본문까지** 뒤진다.

    논문을 찾는 사람은 대개 "그 논문에서 읽은 그 말"을 기억한다. 제목과 요약만
    보면 정작 본문에 있는 낱말로는 못 찾아서, 어느 논문이었는지 아는 경우에만
    쓸모가 있었다. 쪽 표식([[page n]])이 있으면 몇 쪽인지도 함께 준다.
    """
    from backend import paper_store

    ql = q.lower()
    out = []
    unmatched = []
    for p in paper_store.list_papers(user, settings):
        title = str(p.get("title") or "")
        body = _flat(p, ("summary", "abstract", "authors", "keywords", "venue",
                         "category", "methods", "key_findings", "filename"))
        if ql in title.lower() or ql in body.lower():
            out.append(_hit("paper", str(p.get("id") or ""), title,
                            _snippet(str(p.get("summary") or ""), q),
                            str(p.get("year") or ""), str(p.get("category") or "논문"),
                            _score(q, title, body)))
        else:
            unmatched.append(p)

    budget = _PAPER_TEXT_BUDGET
    for p in unmatched:
        if budget <= 0:
            break
        text = paper_store.read_text(user, settings, str(p.get("id") or ""))
        budget -= len(text)
        i = text.lower().find(ql)
        if i < 0:
            continue
        page = _page_at(text, i)
        out.append(_hit(
            "paper", str(p.get("id") or ""), str(p.get("title") or ""),
            _snippet(text[max(0, i - 200): i + 200], q),
            str(p.get("year") or ""),
            f"본문 {page}쪽" if page else "본문",
            15.0,   # 본문 일치는 제목·요약 일치보다 아래
        ))
    return out


def _page_at(text: str, index: int) -> int:
    """추출 본문의 `[[page n]]` 표식으로 그 위치의 쪽수를 찾는다. 없으면 0."""
    import re

    last = 0
    for m in re.finditer(r"\[\[page (\d+)\]\]", text[:index]):
        last = int(m.group(1))
    return last


def _meetings(user: SessionUser, settings: Settings, q: str) -> list[dict]:
    """제목·요약에 없으면 **받아쓴 원본까지** 뒤진다.

    이 검색을 만든 이유가 "저번에 그 회의에서 나온 그 용어"였는데, 정작 그 말이
    들어 있는 곳은 받아쓰기 본문이다. 몇 분쯤인지도 함께 준다.
    """
    from backend import meeting_store

    ql = q.lower()
    out, unmatched = [], []
    for m in meeting_store.list_meetings(user, settings):
        title = str(m.get("title") or "")
        body = _flat(m, ("summary", "category", "speakers", "filename"))
        if ql in title.lower() or ql in body.lower():
            out.append(_hit("meeting", str(m.get("id") or ""), title,
                            _snippet(str(m.get("summary") or ""), q),
                            str(m.get("date") or ""), str(m.get("category") or "회의"),
                            _score(q, title, body)))
        elif m.get("status") == "ready":
            unmatched.append(m)

    budget = _PAPER_TEXT_BUDGET
    for m in unmatched:
        if budget <= 0:
            break
        mid = str(m.get("id") or "")
        t = meeting_store.read_transcript(user, settings, mid)
        seg = next((s for s in t.get("segments") or []
                    if ql in str(s.get("text") or "").lower()), None)
        budget -= len(t.get("text") or "")
        if seg is None:
            if ql not in str(t.get("text") or "").lower():
                continue
            where, snippet = "받아쓰기", _snippet(str(t.get("text") or ""), q)
        else:
            stamp = str(seg.get("start") or "")
            where = f"받아쓰기 {stamp}" if stamp else "받아쓰기"
            snippet = _snippet(str(seg.get("text") or ""), q)
        out.append(_hit("meeting", mid, str(m.get("title") or ""), snippet,
                        str(m.get("date") or ""), where, 15.0))
    return out


def _vocab(user: SessionUser, settings: Settings, q: str) -> list[dict]:
    from backend import vocab_store

    out = []
    for w in vocab_store.list_words(user, settings, query=q, limit=PER_KIND * 2):
        word = str(w.get("word") or "")
        # 뜻은 목록이다(`meanings`). 단수 `meaning` 을 보면 늘 비어 보인다.
        meanings = ", ".join(str(m) for m in (w.get("meanings") or []) if m)
        body = _flat(w, ("meanings", "english_def", "synonyms", "context", "notes"))
        tags = w.get("tags") or []
        out.append(_hit("vocab", str(w.get("id") or word), word,
                        meanings or _snippet(body, q), "",
                        (tags[0] if tags else "단어장"), _score(q, word, body)))
    return out


def _todos(user: SessionUser, settings: Settings, q: str) -> list[dict]:
    from backend import todo_store

    ql = q.lower()
    out = []
    for t in todo_store.list_todos(user, settings):
        title = str(t.get("title") or "")
        body = str(t.get("description") or "")
        if ql in title.lower() or ql in body.lower():
            out.append(_hit("todo", str(t.get("id") or ""), title, _snippet(body, q),
                            str(t.get("due") or ""), "할 일" + (" · 완료" if t.get("done") else ""),
                            _score(q, title, body)))
    return out


_EVENT_CACHE: dict[str, tuple[float, list[dict]]] = {}
_EVENT_TTL = 30.0     # 초. 타자 한 번에 구글을 한 번씩 두드리지 않기 위한 것뿐이다.
_EVENT_WINDOW = 365   # 일. 앞뒤로 이만큼만 본다(반복 일정이 무한히 펼쳐진다).


def _events(user: SessionUser, settings: Settings, q: str) -> list[dict]:
    """일정은 저장소가 둘이다 — 내부 JSON 이거나 구글이다.

    `calendar_store` 만 보면 구글을 쓰는 사용자에게는 검색이 늘 0건이 된다(실제로
    그렇게 짰다가 걸렸다). 그래서 서비스 계층을 거치되, 구글이면 호출이 요금·지연을
    부르므로 30초만 재사용한다. 검색은 타자마다 불리기 때문이다.
    """
    import datetime
    import time

    from backend import calendar_service

    now = time.time()
    cached = _EVENT_CACHE.get(user.username)
    if cached and now - cached[0] < _EVENT_TTL:
        events = cached[1]
    else:
        today = datetime.date.today()
        span = datetime.timedelta(days=_EVENT_WINDOW)
        events = calendar_service.list_events(
            user, settings, (today - span).isoformat(), (today + span).isoformat())
        _EVENT_CACHE[user.username] = (now, events)

    ql = q.lower()
    today_s = datetime.date.today().isoformat()
    # 반복 일정은 창 안에서 여러 번 펼쳐진다. "생일"을 찾으면 같은 줄이 스무 개
    # 나오는 셈이라, 한 일정당 **오늘에 가장 가까운 회차** 하나만 남긴다.
    best: dict[str, tuple[str, dict]] = {}
    for e in events:
        title = str(e.get("title") or "")
        body = str(e.get("description") or "")
        if ql not in title.lower() and ql not in body.lower():
            continue
        eid = str(e.get("id") or "")
        key = _series_key(eid)
        when = str(e.get("start") or "")[:10]
        hit = _hit("event", eid, title, _snippet(body, q), when, "일정",
                   _score(q, title, body))
        prev = best.get(key)
        if prev is None or abs(_daygap(when, today_s)) < abs(_daygap(prev[0], today_s)):
            best[key] = (when, hit)
    return [h for _, h in best.values()]


def _series_key(eid: str) -> str:
    """반복 일정의 한 회차 id 에서 **원본 일정**을 가려낸다.

    저장소마다 표기가 다르다 — 내부는 `<id>@2026-11-12`, 구글은 `<id>_20261112`.
    한쪽만 알면 다른 쪽에서 같은 일정이 회차 수만큼 결과를 채운다.
    """
    head, sep, tail = eid.rpartition("@")
    if sep and len(tail) == 10 and tail[4] == "-" and tail.replace("-", "").isdigit():
        return head
    head, sep, tail = eid.rpartition("_")
    if sep and len(tail) == 8 and tail.isdigit():
        return head
    return eid


def _daygap(a: str, b: str) -> int:
    """YYYY-MM-DD 두 개의 날짜 차이. 못 읽으면 아주 먼 값(뒤로 밀린다)."""
    import datetime

    try:
        return (datetime.date.fromisoformat(a) - datetime.date.fromisoformat(b)).days
    except ValueError:
        return 10**6


def _chats(user: SessionUser, settings: Settings, q: str) -> list[dict]:
    from backend import context_store

    import datetime

    out = []
    for h in context_store.search(user, settings, q, limit=PER_KIND * 2):
        ts = float(h.get("ts") or 0)
        when = datetime.date.fromtimestamp(ts).isoformat() if ts else ""
        # 대화 점수는 낱말 수 기준이라 자릿수가 다르다. 제목 일치(60~100)와
        # 나란히 세우면 대화가 늘 아래로 밀린다 — 본문 일치(20)쯤으로 맞춘다.
        out.append(_hit("chat", f"{h.get('space')}|{h.get('session')}",
                        str(h.get("label") or h.get("space") or "대화"),
                        str(h.get("snippet") or ""), when, "대화",
                        20.0 + min(15.0, float(h.get("score") or 0))))
    return out


_SOURCES = {
    "note": _notes, "paper": _papers, "meeting": _meetings, "vocab": _vocab,
    "todo": _todos, "event": _events, "chat": _chats,
}


def search(user: SessionUser, settings: Settings, query: str,
           kinds: tuple[str, ...] = KINDS, limit: int = 40) -> list[dict]:
    """모든 갈래를 훑어 점수순으로 돌려준다.

    한 갈래가 통째로 실패해도(파일이 깨졌거나 아직 없거나) 나머지는 내놓는다 —
    검색이 전부 아니면 아무것도가 되면 쓸 수 없다.
    """
    q = (query or "").strip()
    if not q:
        return []

    def one(kind: str) -> list[dict]:
        fn = _SOURCES.get(kind)
        if fn is None:
            return []
        try:
            found = fn(user, settings, q)
        except Exception:  # noqa: BLE001 - 한 갈래의 사고가 검색 전체를 막지 않는다
            import logging

            logging.getLogger("server.search").exception("검색 실패: %s", kind)
            return []
        found.sort(key=lambda h: -h["score"])
        return found[:PER_KIND]

    # 갈래를 나란히 훑는다. 대부분은 JSON 한 덩이라 수십 ms 인데 문서만 벌트 전체를
    # 읽어서 훨씬 오래 걸린다(1.8MB·800건에 490ms). 차례로 하면 그 시간이 그대로
    # 더해진다 — 나란히 하면 가장 느린 하나만큼만 걸린다. 파일 읽기는 GIL 을 놓아서
    # 스레드로도 실제로 겹쳐진다.
    picked = [k for k in kinds if k in _SOURCES]
    hits: list[dict] = []
    if len(picked) > 1:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=len(picked)) as pool:
            for found in pool.map(one, picked):
                hits.extend(found)
    else:
        for kind in picked:
            hits.extend(one(kind))
    hits.sort(key=lambda h: -h["score"])
    return hits[:limit]
