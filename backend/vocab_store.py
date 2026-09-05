"""단어장 저장소 — 사용자별 vocab/vocab.json.

영어 학습 화면과 논문 화면이 같은 단어장을 본다. 단어는 **어디서 가져왔는지**를
태그로 구분한다(논문 제목, "일상 대화", "TOEIC" 같은 자유 문자열). 태그 목록은
따로 저장하지 않고 단어에서 모은다 — 두 곳에 두면 서로 어긋난다.

모델:
  단어 {id, word, kind, pos, pronunciation, meanings[], english_def, synonyms[],
        antonyms[], examples[{en, ko, grammar}], forms, notes, tags[],
        context, source,
        level, next_review, review_ok, review_ng, last_reviewed,
        created_at, updated_at}
    - kind 는 갈래(word/phrase/sentence/grammar/term). **영어 단어만 담는 곳이 아니다** —
      논문 화면에서는 전문 용어(term)가, 영어 학습에서는 문장·문법 항목이 함께 들어온다.
      비어 있으면 표제어 모양으로 짐작한다(guess_kind).
    - word 는 표제어(원형). 같은 표제어를 다시 넣으면 새로 만들지 않고 **합친다**
      (태그·문맥은 더하고, 설명은 더 긴 쪽을 남긴다). 논문 두 편에서 같은 단어를
      만나면 태그가 둘 다 붙어 "어디서 봤는지"가 남는다.
    - level/next_review 는 간격 반복(복습) 상태. 0 = 아직 안 봄.

파일 하나에 {words: [...]} 로 담는다. 할 일 저장소와 같은 이유로 한 번의
원자적 쓰기로 갱신한다.
"""
from __future__ import annotations

import time
import uuid
from datetime import date, timedelta
from pathlib import Path

from fastapi import HTTPException

from . import json_store
from .auth import SessionUser
from .config import Settings

#: 한 사용자의 단어 수 상한. 화면이 전부 내려받으므로 무한히 두면 느려진다.
MAX_WORDS = 20000
#: 단어 하나에 붙는 태그 수 상한
MAX_TAGS_PER_WORD = 20
#: 문자열 필드 길이 상한(모델이 장문을 쏟아 넣어도 파일이 폭주하지 않게)
MAX_TEXT = 4000
MAX_SHORT = 200
#: 표제어. 문장·문법 항목도 표제어로 들어오므로 다른 짧은 필드보다 넉넉하다.
MAX_WORD = 600
MAX_LIST = 30
MAX_EXAMPLES = 12

#: 항목의 갈래. 단어장이 영어 단어 전용이 아니라서 갈래를 함께 적는다.
KINDS = ("word", "phrase", "sentence", "grammar", "term")

#: 복습 간격(일). level n 을 맞히면 level n+1 로 올라가고 그 간격 뒤에 다시 나온다.
REVIEW_INTERVALS = [0, 1, 3, 7, 14, 30, 60, 120]
MAX_LEVEL = len(REVIEW_INTERVALS) - 1


def _path(user: SessionUser, settings: Settings) -> Path:
    base = settings.user_root(user.username) / "vocab"
    base.mkdir(parents=True, exist_ok=True)
    return base / "vocab.json"


def _load(user: SessionUser, settings: Settings) -> dict:
    data = json_store.read_json_strict(_path(user, settings), None)
    if not isinstance(data, dict):
        return {"words": []}
    words = data.get("words")
    return {"words": [w for w in words if isinstance(w, dict)] if isinstance(words, list) else []}


def _save(data: dict, user: SessionUser, settings: Settings) -> None:
    json_store.write_atomic(_path(user, settings), data)


def _now() -> float:
    return time.time()


# ── 값 정리 ──────────────────────────────────────────────────────────

def _s(value, limit: int = MAX_TEXT) -> str:
    return str(value or "").strip()[:limit]


def _strs(value, limit: int = MAX_SHORT, count: int = MAX_LIST) -> list[str]:
    """문자열 목록. 문자열 하나가 오면 줄·쉼표로 나눈다(모델이 종종 그렇게 준다)."""
    if value is None:
        return []
    if isinstance(value, str):
        parts = [p.strip() for p in value.replace("\n", ",").split(",")]
    elif isinstance(value, (list, tuple)):
        parts = [str(p).strip() for p in value]
    else:
        return []
    out: list[str] = []
    for p in parts:
        if p and p[:limit] not in out:
            out.append(p[:limit])
        if len(out) >= count:
            break
    return out


def normalize_tag(tag) -> str:
    """태그는 앞뒤 공백을 걷고 앞의 #을 뗀다. 대소문자는 보존한다(논문 제목)."""
    t = str(tag or "").strip().lstrip("#").strip()
    return t[:MAX_SHORT]


def _tags(value) -> list[str]:
    out: list[str] = []
    for t in _strs(value, MAX_SHORT, MAX_TAGS_PER_WORD):
        nt = normalize_tag(t)
        if nt and nt.lower() not in {o.lower() for o in out}:
            out.append(nt)
    return out


def _examples(value) -> list[dict]:
    if not isinstance(value, (list, tuple)):
        return []
    out = []
    for ex in value:
        if isinstance(ex, str):
            ex = {"en": ex}
        if not isinstance(ex, dict):
            continue
        en = _s(ex.get("en") or ex.get("sentence") or ex.get("english"), MAX_SHORT * 3)
        if not en:
            continue
        out.append({
            "en": en,
            "ko": _s(ex.get("ko") or ex.get("translation") or ex.get("korean"), MAX_SHORT * 3),
            "grammar": _s(ex.get("grammar") or ex.get("note"), MAX_SHORT * 3),
        })
        if len(out) >= MAX_EXAMPLES:
            break
    return out


def headword(word) -> str:
    """표제어 비교용 — 소문자, 앞뒤 공백 제거."""
    return _s(word, MAX_WORD).lower()


def _kind(value) -> str:
    k = str(value or "").strip().lower()
    return k if k in KINDS else ""


def guess_kind(word: str) -> str:
    """갈래를 안 줬을 때 표제어 모양으로 짐작한다.

    문장을 통째로 담는 일이 흔해서(영어 학습) 단어와 섞이면 목록이 읽기 어렵다.
    틀려도 사용자가 수정 화면에서 바꿀 수 있으므로 대충이라도 나눠 둔다.
    """
    s = str(word or "").strip()
    if not s:
        return ""
    n = len(s.split())
    if n >= 5 or s.endswith((".", "?", "!")):
        return "sentence"
    return "phrase" if n >= 2 else "word"


def _norm(payload: dict, existing: dict | None = None) -> dict:
    """입력을 저장 형태로 맞춘다. existing 이 있으면 그 위에 덮는다(부분 수정)."""
    base = dict(existing or {})
    if "word" in payload and payload["word"] is not None:
        w = _s(payload["word"], MAX_WORD)
        if not w:
            raise HTTPException(status_code=400, detail="단어가 비어 있습니다.")
        base["word"] = w
    if "kind" in payload and payload["kind"] is not None:
        base["kind"] = _kind(payload["kind"])
    for k in ("pos", "pronunciation"):
        if k in payload and payload[k] is not None:
            base[k] = _s(payload[k], MAX_SHORT)
    for k in ("english_def", "forms", "notes", "context", "source"):
        if k in payload and payload[k] is not None:
            base[k] = _s(payload[k])
    for k in ("meanings", "synonyms", "antonyms"):
        if k in payload and payload[k] is not None:
            base[k] = _strs(payload[k])
    if "examples" in payload and payload["examples"] is not None:
        base["examples"] = _examples(payload["examples"])
    if "tags" in payload and payload["tags"] is not None:
        base["tags"] = _tags(payload["tags"])
    if not base.get("word"):
        raise HTTPException(status_code=400, detail="단어가 필요합니다.")
    if not base.get("kind"):
        base["kind"] = guess_kind(base["word"])
    for k, dflt in (("pos", ""), ("pronunciation", ""), ("english_def", ""), ("forms", ""),
                    ("notes", ""), ("context", ""), ("source", ""), ("meanings", []),
                    ("synonyms", []), ("antonyms", []), ("examples", []), ("tags", []),
                    ("level", 0), ("next_review", ""), ("review_ok", 0), ("review_ng", 0),
                    ("last_reviewed", 0.0)):
        base.setdefault(k, dflt if not isinstance(dflt, list) else list(dflt))
    base["updated_at"] = _now()
    return base


def _merge_into(existing: dict, incoming: dict) -> dict:
    """같은 표제어를 다시 넣을 때: 목록은 합치고 설명은 비어 있거나 짧은 쪽을 채운다."""
    out = dict(existing)
    for k in ("meanings", "synonyms", "antonyms"):
        merged = list(out.get(k) or [])
        for v in incoming.get(k) or []:
            if v not in merged:
                merged.append(v)
        out[k] = merged[:MAX_LIST]
    ex = list(out.get("examples") or [])
    seen = {e.get("en", "").lower() for e in ex}
    for e in incoming.get("examples") or []:
        if e.get("en", "").lower() not in seen:
            ex.append(e)
            seen.add(e.get("en", "").lower())
    out["examples"] = ex[:MAX_EXAMPLES]
    out["tags"] = _tags(list(out.get("tags") or []) + list(incoming.get("tags") or []))
    for k in ("pos", "pronunciation", "english_def", "forms", "notes"):
        if len(str(incoming.get(k) or "")) > len(str(out.get(k) or "")):
            out[k] = incoming[k]
    # 갈래는 이미 정해진 쪽을 존중한다(사용자가 고쳐 둔 것을 모델이 되돌리지 않게)
    if not out.get("kind"):
        out["kind"] = incoming.get("kind") or guess_kind(str(out.get("word") or ""))
    # 문맥은 출처마다 다르므로 쌓는다(줄바꿈으로)
    for k in ("context", "source"):
        new = str(incoming.get(k) or "").strip()
        old = str(out.get(k) or "").strip()
        if new and new not in old:
            out[k] = (f"{old}\n{new}" if old else new)[:MAX_TEXT]
    out["updated_at"] = _now()
    return out


# ── 조회 ─────────────────────────────────────────────────────────────

def list_words(
    user: SessionUser, settings: Settings, *,
    tag: str = "", query: str = "", due_only: bool = False, kind: str = "", limit: int = 0,
) -> list[dict]:
    """단어 목록. tag 로 거르고 query 로 검색한다(표제어·뜻·유사어·문맥).

    최근 넣은 것이 위로 온다 — 방금 넣은 단어를 바로 보는 일이 가장 잦다.
    """
    words = _load(user, settings)["words"]
    return filter_words(words, tag=tag, query=query, due_only=due_only, kind=kind, limit=limit)


def filter_words(words: list[dict], *, tag: str = "", query: str = "",
                 due_only: bool = False, kind: str = "", limit: int = 0) -> list[dict]:
    tag_l = normalize_tag(tag).lower()
    q = _s(query, MAX_SHORT).lower()
    kind_l = _kind(kind)
    today = date.today().isoformat()
    out = []
    for w in words:
        if tag_l and tag_l not in {t.lower() for t in w.get("tags") or []}:
            continue
        if kind_l and (w.get("kind") or guess_kind(str(w.get("word") or ""))) != kind_l:
            continue
        if due_only and not _is_due(w, today):
            continue
        if q and not _matches(w, q):
            continue
        out.append(w)
    out.sort(key=lambda w: -float(w.get("created_at") or 0))
    return out[:limit] if limit > 0 else out


def _matches(w: dict, q: str) -> bool:
    hay = [w.get("word", ""), w.get("english_def", ""), w.get("context", ""), w.get("notes", ""),
           *(w.get("meanings") or []), *(w.get("synonyms") or []), *(w.get("antonyms") or []),
           *(t for t in (w.get("tags") or []))]
    return any(q in str(h).lower() for h in hay)


def _is_due(w: dict, today: str) -> bool:
    nr = str(w.get("next_review") or "")
    return not nr or nr <= today


def find_by_word(user: SessionUser, settings: Settings, word: str) -> dict | None:
    hw = headword(word)
    if not hw:
        return None
    return next((w for w in _load(user, settings)["words"] if headword(w.get("word")) == hw), None)


def get_word(user: SessionUser, settings: Settings, wid: str) -> dict | None:
    return next((w for w in _load(user, settings)["words"] if w.get("id") == wid), None)


def list_tags(user: SessionUser, settings: Settings) -> list[dict]:
    """태그와 개수. 많이 쓴 태그가 위로."""
    return tags_of(_load(user, settings)["words"])


def tags_of(words: list[dict]) -> list[dict]:
    counts: dict[str, dict] = {}
    for w in words:
        for t in w.get("tags") or []:
            row = counts.setdefault(t.lower(), {"tag": t, "count": 0})
            row["count"] += 1
    return sorted(counts.values(), key=lambda r: (-r["count"], r["tag"].lower()))


def stats(user: SessionUser, settings: Settings) -> dict:
    words = _load(user, settings)["words"]
    today = date.today().isoformat()
    return {
        "total": len(words),
        "due": sum(1 for w in words if _is_due(w, today)),
        "learned": sum(1 for w in words if int(w.get("level") or 0) >= 4),
        "tags": len(tags_of(words)),
    }


def board(user: SessionUser, settings: Settings) -> dict:
    """단어·태그·통계를 파일 한 번 읽어 함께 돌려준다(화면 최초 로드용)."""
    words = _load(user, settings)["words"]
    today = date.today().isoformat()
    words_sorted = sorted(words, key=lambda w: -float(w.get("created_at") or 0))
    return {
        "words": words_sorted,
        "tags": tags_of(words),
        "stats": {
            "total": len(words),
            "due": sum(1 for w in words if _is_due(w, today)),
            "learned": sum(1 for w in words if int(w.get("level") or 0) >= 4),
            "tags": len(tags_of(words)),
        },
    }


# ── 변경 ─────────────────────────────────────────────────────────────

def add_word(user: SessionUser, settings: Settings, payload: dict) -> tuple[dict, bool]:
    """단어를 넣는다. 같은 표제어가 있으면 합치고 (항목, merged=True) 를 돌려준다."""
    p = _path(user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        words = data["words"]
        incoming = _norm(payload)
        hw = headword(incoming["word"])
        idx = next((i for i, w in enumerate(words) if headword(w.get("word")) == hw), -1)
        if idx >= 0:
            words[idx] = _merge_into(words[idx], incoming)
            _save(data, user, settings)
            return words[idx], True
        if len(words) >= MAX_WORDS:
            raise HTTPException(status_code=409, detail=f"단어는 {MAX_WORDS}개까지입니다.")
        incoming["id"] = uuid.uuid4().hex
        incoming["created_at"] = _now()
        words.append(incoming)
        _save(data, user, settings)
    return incoming, False


def add_words(user: SessionUser, settings: Settings, payloads: list[dict],
              extra_tags: list[str] | None = None) -> dict:
    """여러 단어를 한 번에. 하나가 잘못돼도 나머지는 들어간다(무엇이 실패했는지 돌려준다)."""
    added, merged, failed = [], [], []
    for raw in payloads:
        if not isinstance(raw, dict):
            failed.append({"word": str(raw)[:MAX_SHORT], "reason": "형식이 잘못됨"})
            continue
        item = dict(raw)
        if extra_tags:
            item["tags"] = list(_tags(item.get("tags"))) + list(extra_tags)
        try:
            w, was_merged = add_word(user, settings, item)
        except HTTPException as e:
            failed.append({"word": str(raw.get("word", ""))[:MAX_SHORT], "reason": str(e.detail)})
            continue
        (merged if was_merged else added).append(w)
    return {"added": added, "merged": merged, "failed": failed}


def update_word(user: SessionUser, settings: Settings, wid: str, payload: dict) -> dict:
    p = _path(user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        words = data["words"]
        idx = next((i for i, w in enumerate(words) if w.get("id") == wid), -1)
        if idx < 0:
            raise HTTPException(status_code=404, detail="단어를 찾을 수 없습니다.")
        merged = _norm(payload, words[idx])
        # 표제어를 바꿔 다른 단어와 겹치면 두 항목이 같은 단어가 된다
        hw = headword(merged["word"])
        if any(i != idx and headword(w.get("word")) == hw for i, w in enumerate(words)):
            raise HTTPException(status_code=409, detail="같은 단어가 이미 있습니다.")
        merged["id"] = wid
        merged.setdefault("created_at", words[idx].get("created_at", _now()))
        words[idx] = merged
        _save(data, user, settings)
    return merged


def delete_word(user: SessionUser, settings: Settings, wid: str) -> dict:
    """삭제. 먼저 휴지통에 담고 지운다(할 일과 같은 순서·이유)."""
    from . import trash

    p = _path(user, settings)
    with json_store.lock_for(p):
        target = next((w for w in _load(user, settings)["words"] if w.get("id") == wid), None)
    if target is None:
        raise HTTPException(status_code=404, detail="단어를 찾을 수 없습니다.")
    trash.move_vocab_to_trash(target, user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        before = len(data["words"])
        data["words"] = [w for w in data["words"] if w.get("id") != wid]
        if len(data["words"]) != before:
            _save(data, user, settings)
    return {"ok": True, "id": wid, "word": target.get("word", "")}


def restore_word(user: SessionUser, settings: Settings, payload: dict) -> dict:
    """휴지통에서 되돌린다. 그 사이 같은 표제어가 생겼으면 합친다."""
    p = _path(user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        words = data["words"]
        item = _norm(dict(payload))
        hw = headword(item["word"])
        idx = next((i for i, w in enumerate(words) if headword(w.get("word")) == hw), -1)
        if idx >= 0:
            words[idx] = _merge_into(words[idx], item)
            _save(data, user, settings)
            return words[idx]
        wid = str(payload.get("id") or "")
        if not wid or any(w.get("id") == wid for w in words):
            wid = uuid.uuid4().hex
        item["id"] = wid
        item.setdefault("created_at", _now())
        words.append(item)
        _save(data, user, settings)
    return item


def rename_tag(user: SessionUser, settings: Settings, old: str, new: str) -> dict:
    """태그 이름을 바꾼다(모든 단어에서). new 가 비면 태그를 뗀다."""
    old_l = normalize_tag(old).lower()
    new_t = normalize_tag(new)
    if not old_l:
        raise HTTPException(status_code=400, detail="바꿀 태그가 비어 있습니다.")
    p = _path(user, settings)
    changed = 0
    with json_store.lock_for(p):
        data = _load(user, settings)
        for w in data["words"]:
            tags = list(w.get("tags") or [])
            if not any(t.lower() == old_l for t in tags):
                continue
            rest = [t for t in tags if t.lower() != old_l]
            w["tags"] = _tags(rest + ([new_t] if new_t else []))
            w["updated_at"] = _now()
            changed += 1
        if changed:
            _save(data, user, settings)
    return {"ok": True, "changed": changed}


# ── 복습(간격 반복) ────────────────────────────────────────────────────

def review_queue(user: SessionUser, settings: Settings, *, tag: str = "", limit: int = 20) -> list[dict]:
    """오늘 복습할 단어. 오래 기다린 것(레벨 낮은 것)부터."""
    words = list_words(user, settings, tag=tag, due_only=True)
    words.sort(key=lambda w: (int(w.get("level") or 0), str(w.get("next_review") or ""),
                              -float(w.get("created_at") or 0)))
    return words[:max(1, min(limit, 200))]


def record_review(user: SessionUser, settings: Settings, wid: str, ok: bool) -> dict:
    """맞히면 레벨을 올려 다음 복습을 멀리, 틀리면 레벨을 내려 내일 다시."""
    p = _path(user, settings)
    with json_store.lock_for(p):
        data = _load(user, settings)
        w = next((x for x in data["words"] if x.get("id") == wid), None)
        if w is None:
            raise HTTPException(status_code=404, detail="단어를 찾을 수 없습니다.")
        level = int(w.get("level") or 0)
        if ok:
            level = min(MAX_LEVEL, level + 1)
            w["review_ok"] = int(w.get("review_ok") or 0) + 1
        else:
            level = max(0, level - 2) if level > 1 else 0
            w["review_ng"] = int(w.get("review_ng") or 0) + 1
        w["level"] = level
        days = REVIEW_INTERVALS[level] if ok else 1
        w["next_review"] = (date.today() + timedelta(days=max(1, days))).isoformat()
        w["last_reviewed"] = _now()
        w["updated_at"] = _now()
        _save(data, user, settings)
    return w
