"""화면별로 이어지는 AI 대화 기록.

비서 화면의 대화는 브라우저에만 있다(새로고침하면 사라진다). 영어 학습과 논문
화면은 다르다 — "지난주에 물어본 단어", "저 논문에서 했던 질문"이 다음 대화의
맥락이어야 하므로 서버에 남긴다.

한 공간(space) = 파일 하나:
  {messages: [{id, role, text, ts, meta, parent}], head: "<id>",
   links: [{from_id, to_id}], vocab_done: ["<키>", …]}
  - 영어 학습:  users/<u>/chats/english.json
  - 논문:       users/<u>/papers/<id>/chat.json  (논문 폴더에 두어 휴지통과 함께 움직인다)

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

메시지 수는 MAX_MESSAGES 로 자른다(오래된 것부터). 잘려 나간 부모를 가리키던
메시지는 뿌리가 된다 — 나무가 여럿이 될 수 있고(숲), 화면도 그렇게 그린다.
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


def load_all(path: Path) -> dict:
    """파일 전체(메시지 나무 + 지금 끝자락 + 기억 연결 + 처리한 후보 키)."""
    data = json_store.read_json_strict(path, None)
    if not isinstance(data, dict):
        data = {}
    raw = data.get("messages")
    msgs = [m for m in raw if isinstance(m, dict)] if isinstance(raw, list) else []
    _migrate(msgs)
    ids = {m.get("id") for m in msgs}
    # 잘려 나간 부모를 가리키는 것은 뿌리로 만든다(미아를 남기지 않는다)
    for m in msgs:
        if m.get("parent") not in ids:
            m["parent"] = None
    done = data.get("vocab_done")
    links = data.get("links")
    head = str(data.get("head") or "")
    return {
        "messages": msgs,
        # head 가 없거나 가리키는 것이 사라졌으면 마지막 메시지를 본다(옛 파일)
        "head": head if head in ids else (msgs[-1].get("id", "") if msgs else ""),
        "links": [
            {"from_id": str(l.get("from_id") or ""), "to_id": str(l.get("to_id") or "")}
            for l in links if isinstance(l, dict)
            and l.get("from_id") in ids and l.get("to_id") in ids
        ] if isinstance(links, list) else [],
        "vocab_done": [str(k) for k in done if k] if isinstance(done, list) else [],
    }


def load(path: Path) -> list[dict]:
    return load_all(path)["messages"]


def vocab_done(path: Path) -> set[str]:
    """사용자가 이미 닫았거나 넣은 후보 목록의 키."""
    return set(load_all(path)["vocab_done"])


def _save(path: Path, data: dict) -> None:
    # **폴더를 만들지 않는다.** 논문·회의 대화는 그 항목 폴더 안에 있어서, 폴더를
    # 만드는 것이 곧 지워진 항목을 되살리는 것이다(목록에도 휴지통에도 없는 미아가
    # 된다). 고정 공간(영어 학습 등)의 chats/ 는 위 경로 함수들이 미리 만든다.
    msgs = data["messages"][-MAX_MESSAGES:]
    ids = {m.get("id") for m in msgs}
    for m in msgs:
        if m.get("parent") not in ids:
            m["parent"] = None
    head = data.get("head") or ""
    json_store.write_atomic(
        path,
        {
            "messages": msgs,
            "head": head if head in ids else (msgs[-1].get("id", "") if msgs else ""),
            "links": [l for l in data.get("links") or []
                      if l.get("from_id") in ids and l.get("to_id") in ids][-MAX_LINKS:],
            "vocab_done": (data.get("vocab_done") or [])[-MAX_DONE:],
        },
        create_parents=False,
    )


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


def append(path: Path, *msgs: dict) -> list[dict]:
    """메시지를 덧붙이고 전체를 돌려준다. 끝자락(head)은 마지막 것으로 옮긴다."""
    with json_store.lock_for(path):
        data = load_all(path)
        added = [m for m in msgs if m]
        data["messages"].extend(added)
        if added:
            data["head"] = added[-1].get("id", "")
        _save(path, data)
        return data["messages"]


def set_head(path: Path, mid: str) -> bool:
    """보고 있는 가지를 옮긴다. 없는 메시지면 False."""
    with json_store.lock_for(path):
        data = load_all(path)
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
        data = load_all(path)
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
        data = load_all(path)
        n = 0
        for m in data["messages"]:
            name = names.get(str(m.get("id") or ""))
            if name:
                m.setdefault("meta", {})["branch_name"] = str(name)[:40]
                n += 1
        if n:
            _save(path, data)
        return n


def clear(path: Path) -> None:
    # 대화를 비우면 후보 처리 기록·기억 연결도 함께 비운다 — 가리킬 것이 사라졌다.
    with json_store.lock_for(path):
        _save(path, {"messages": [], "head": "", "links": [], "vocab_done": []})


def delete_message(path: Path, mid: str) -> bool:
    """이 메시지와 **그 아래 가지 전체**를 지운다.

    한 줄 대화에서는 한 줄만 지우는 것이었다. 나무에서는 밑에 달린 것을 남기면
    뿌리 없는 가지가 뜬다 — 지우려던 맥락이 사라진 채로 남는 셈이다.
    """
    with json_store.lock_for(path):
        data = load_all(path)
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
        data = load_all(path)
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
