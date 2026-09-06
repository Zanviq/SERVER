"""단어장 채우기 — 사전 내용을 백그라운드에서 만들어 넣는다.

두 갈래가 있다.

  fill     사용자가 **고른 항목만** 채워 넣는다(후보 체크 목록의 '넣기').
           모델이 준 결과에서 요청한 표제어가 아닌 것은 버린다 — 채팅으로
           "넣어줘"를 되돌려 보내던 예전 방식은 모델이 직전 대화(후보 전체)를
           보고 고르지 않은 단어까지 넣는 일이 있었다. 여기서는 넣을 목록을
           서버가 쥐고 있으므로 그럴 수 없다.
  collect  사용자가 단어·문장·문법을 **뒤섞어 나열한 글**을 모델이 갈래로
           나눠 정리해 넣는다(영어 학습 화면의 '+').

둘 다 스레드에서 돌고, 화면은 /api/vocab/jobs 로 진행 상황을 본다. 대화를
막지 않는 것이 목적이다 — 단어 열 개를 채우는 데 20초씩 걸려도 그동안 계속
질문할 수 있어야 한다.

작업 기록은 메모리에만 둔다. 서버가 재시작되면 사라지지만, 이미 들어간 단어는
단어장에 남는다(작업 기록은 진행 표시용일 뿐이다).
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid

from . import vocab_store
from .ai import errors as ai_errors
from .auth import SessionUser
from .config import Settings

logger = logging.getLogger("server.vocab")

#: 모델 **한 번 호출**에 넣는 항목 수. 프롬프트가 너무 길어지지 않게 하는 값이지
#: 사용자가 고를 수 있는 개수가 아니다. 예전에는 이 값으로 고른 목록을 잘랐고,
#: 60개를 골라도 40개만 저장되면서 **아무 말도 하지 않았다**(실측).
BATCH_ITEMS = 40
#: 한 작업이 받는 항목 수의 상한. 여기를 넘으면 조용히 자르지 않고 거절한다 —
#: 고른 목록은 사용자에게 남아 있어야 나눠서 다시 넣을 수 있다.
MAX_ITEMS = 200
#: collect 에 붙여 넣을 수 있는 글 길이
MAX_COLLECT_CHARS = 6000
#: 사용자당 남겨 두는 작업 기록 수
MAX_JOBS = 20

STATUS_PENDING = "pending"
STATUS_DONE = "done"
STATUS_FAILED = "failed"

_jobs: dict[str, list[dict]] = {}
_guard = threading.Lock()

_ENTRY_SHAPE = """{
  "word": "표제어(원형). 문장이면 문장 그대로, 문법 항목이면 그 이름",
  "kind": "word | phrase | sentence | grammar | term",
  "pos": "품사(동사/형용사/명사/부사/숙어). 문장·문법이면 빈 문자열",
  "pronunciation": "/IPA/ 와 강세. 영어가 아니면 빈 문자열",
  "meanings": ["한국어 뜻. 자주 쓰는 순서로 1~4개"],
  "english_def": "영어 해설 한두 문장. 영어가 아니면 빈 문자열",
  "synonyms": ["비슷한 단어(뜻)"],
  "antonyms": ["반대말(뜻)"],
  "examples": [{"en": "예문", "ko": "해석", "grammar": "그 문장의 문법 포인트 한 줄"}],
  "forms": "변화형. 동사면 'run - ran - run - running', 그 밖엔 품사 변화",
  "notes": "뉘앙스·헷갈리는 점·불규칙. 짧게",
  "context": "이 항목을 만난 원문 문장(주어진 것이 있으면)"
}"""

_KIND_RULES = """갈래(kind) 기준:
- word: 낱말 하나
- phrase: 숙어·연어·짧은 표현
- sentence: 문장 통째. 이때 meanings 에 전체 해석을 넣고 examples 첫 줄에 그 문장과 해석을 넣는다.
- grammar: 문법 항목(예: "현재완료진행", "관계대명사 which"). meanings 에 무엇인지 한 줄,
  notes 에 언제 어떻게 쓰는지, examples 에 예문 2~3개.
- term: 전문 용어·고유명사(예: "self-attention", "베이즈 정리"). **영어 단어가 아니어도 된다.**
  meanings 에 한국어 정의, english_def 에 영어 정의(있으면), notes 에 어디에 쓰이는지."""

_COMMON_TAIL = f"""{_KIND_RULES}

규칙:
- 답은 JSON 객체 하나. 산문도 코드펜스도 붙이지 않는다.
- 사용자는 한국어로 공부한다. meanings/notes 는 한국어로, 예문은 원어 + 한국어 해석.
- 모르는 항목은 지어내지 말고 meanings 에 "(뜻을 확인하지 못했습니다)" 라고 적는다.
- 값은 간결하게. examples 는 2~3개면 충분하다."""

_PROMPT_FILL = f"""You are filling in a personal study notebook (한국어 사용자).
아래 목록의 항목을 사전 형식으로 채워라.

**목록에 있는 항목만, 목록에 있는 표제어 그대로** 돌려준다. 더하지도 빼지도 않는다.

형식:
{{"words": [{_ENTRY_SHAPE}]}}

{_COMMON_TAIL}"""

_PROMPT_COLLECT = f"""You are organising a personal study notebook (한국어 사용자).
사용자가 단어·문장·문법·전문 용어를 형식 없이 뒤섞어 적어 놓았다. 이를 항목으로 나누고
갈래를 정해 사전 형식으로 채워라.

형식:
{{"words": [{_ENTRY_SHAPE}]}}

나누는 규칙:
- 줄바꿈·쉼표·번호로 나뉘어 있으면 그대로 항목으로 본다. 한 줄에 여러 낱말이 쉼표로 있으면 각각 항목이다.
- 문장은 쪼개지 말고 통째로 한 항목(kind=sentence)으로 둔다.
- "현재완료", "가정법 과거" 처럼 문법 이름만 적힌 것은 kind=grammar 로 만든다.
- 사용자가 "이거 뜻 뭐야" 같은 말을 섞어 적었으면 그 말은 항목이 아니다. 버린다.
- 같은 항목이 두 번 나오면 하나로 합친다.

{_COMMON_TAIL}"""


# ── 작업 기록 ─────────────────────────────────────────────────────────

def _new_job(user: SessionUser, kind: str, words: list[str], tags: list[str]) -> dict:
    job = {
        "id": uuid.uuid4().hex[:12],
        "kind": kind,
        "status": STATUS_PENDING,
        # 고른 것을 전부 담는다. 상한 검사는 라우터가 미리 하고 거절한다.
        "words": list(words),
        "tags": list(tags),
        "added": [],
        "merged": [],
        "failed": [],
        "error": "",
        "created_at": time.time(),
        "done_at": 0.0,
    }
    with _guard:
        rows = _jobs.setdefault(user.username, [])
        rows.append(job)
        del rows[:-MAX_JOBS]
    return job


def _finish(user: SessionUser, job_id: str, patch: dict) -> None:
    with _guard:
        for j in _jobs.get(user.username, []):
            if j["id"] == job_id:
                j.update(patch)
                j["done_at"] = time.time()
                return


def jobs_for(user: SessionUser) -> list[dict]:
    """최근 작업 기록. 화면이 진행 중 표시와 완료 알림에 쓴다."""
    with _guard:
        return [dict(j) for j in _jobs.get(user.username, [])]


# ── 모델 호출 ─────────────────────────────────────────────────────────

def _parse_json(text: str) -> dict:
    s = (text or "").strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s, flags=re.I)
    try:
        obj = json.loads(s)
        return obj if isinstance(obj, dict) else {}
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", s, flags=re.S)
    if m:
        try:
            obj = json.loads(m.group(0))
            return obj if isinstance(obj, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _model_of(user: SessionUser, settings: Settings) -> str:
    try:
        from . import user_settings

        return str(user_settings.load(user, settings).get("ai", {}).get("model") or "")
    except Exception:  # noqa: BLE001
        return ""


def _ask_gemini(settings: Settings, prompt: str, payload: str, model: str = "") -> dict:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=settings.gemini_api_key)
    resp = client.models.generate_content(
        model=model or settings.gemini_model,
        contents=[types.Content(role="user", parts=[
            types.Part.from_text(text=prompt),
            types.Part.from_text(text=payload),
        ])],
        config=types.GenerateContentConfig(response_mime_type="application/json"),
    )
    return _parse_json(getattr(resp, "text", "") or "")


def _entries(raw: dict) -> list[dict]:
    words = raw.get("words") if isinstance(raw, dict) else None
    if not isinstance(words, list):
        return []
    out = []
    for w in words:
        if isinstance(w, dict) and str(w.get("word") or "").strip():
            out.append(w)
    return out


# ── 실행 ─────────────────────────────────────────────────────────────

def run_fill(user: SessionUser, settings: Settings, job_id: str, items: list[dict],
             tags: list[str], context: str, *, asker=None) -> dict:
    """고른 항목만 채워 넣는다. 모델이 다른 표제어를 얹어도 버린다."""
    wanted = {vocab_store.headword(i.get("word")): i for i in items if str(i.get("word") or "").strip()}
    if not wanted:
        _finish(user, job_id, {"status": STATUS_FAILED, "error": "넣을 항목이 없습니다."})
        return {"added": [], "merged": [], "failed": []}

    def payload_for(batch: list[dict]) -> str:
        lines = []
        for i in batch:
            w = str(i.get("word") or "").strip()
            if not w:
                continue
            hint = str(i.get("meaning") or "").strip()
            kind = str(i.get("kind") or "").strip()
            bits = [b for b in (kind, hint) if b]
            lines.append(f"- {w}" + (f"  ({' / '.join(bits)})" if bits else ""))
        out = "항목:\n" + "\n".join(lines)
        if context.strip():
            out += f"\n\n이 항목들이 나온 원문:\n{context.strip()[:2000]}"
        if tags:
            out += f"\n\n출처(참고용, 태그로 붙는다): {', '.join(tags)}"
        return out

    # 고른 것이 많으면 **나눠서 부른다.** 예전에는 앞 40개만 남기고 나머지를 조용히
    # 버렸다 — 사용자는 60개를 골랐는데 40개만 들어가고 아무 말도 없었다.
    # 이 파일이 이미 "사용자가 고른 것은 무슨 일이 있어도 단어장에 있어야 한다"는
    # 규칙을 세워 두고 있는데, 그 앞에서 목록을 자르고 있었던 셈이다.
    batches = [items[i:i + BATCH_ITEMS] for i in range(0, len(items), BATCH_ITEMS)]
    filled: dict[str, dict] = {}
    failures = 0
    last_error = ""
    for batch in batches:
        try:
            raw = (asker or _ask_gemini)(settings, _PROMPT_FILL, payload_for(batch),
                                         _model_of(user, settings))
            for e in _entries(raw):
                hw = vocab_store.headword(e.get("word"))
                # 모델이 표제어를 살짝 바꿔 오는 일이 있다(대소문자·원형화) — 요청한 것에만 맞춘다
                if hw in wanted and hw not in filled:
                    filled[hw] = e
        except Exception as e:  # noqa: BLE001
            # 한 묶음이 실패해도 나머지는 채운다. 아래에서 못 채운 것도 결국
            # 단어장에는 들어가므로(뜻만 빈 채로) 고른 것이 사라지지는 않는다.
            logger.exception("단어장 채우기 실패(모델) — 묶음 %d/%d", failures + 1, len(batches))
            failures += 1
            last_error = str(e)
    if failures == len(batches):
        _finish(user, job_id, {
            "status": STATUS_FAILED,
            # 왜 실패했는지 구분해 말한다(대화 화면과 같은 표)
            "error": ai_errors.message(last_error, settings.debug)[:200],
        })
        return {"added": [], "merged": [], "failed": []}

    # 모델이 빠뜨린 항목도 넣는다 — 사용자가 고른 것은 무슨 일이 있어도 단어장에 있어야 한다
    payloads = []
    for hw, src in wanted.items():
        entry = dict(filled.get(hw) or {})
        entry["word"] = str(src.get("word") or "").strip()
        if not entry.get("meanings"):
            hint = str(src.get("meaning") or "").strip()
            entry["meanings"] = [hint] if hint else ["(뜻을 확인하지 못했습니다)"]
        if src.get("kind") and not entry.get("kind"):
            entry["kind"] = src["kind"]
        if context.strip() and not entry.get("context"):
            entry["context"] = context.strip()[:1000]
        payloads.append(entry)

    out = vocab_store.add_words(user, settings, payloads, extra_tags=tags)
    _finish(user, job_id, {
        "status": STATUS_DONE,
        "added": [w.get("word", "") for w in out["added"]],
        "merged": [w.get("word", "") for w in out["merged"]],
        "failed": out["failed"],
    })
    return out


def run_collect(user: SessionUser, settings: Settings, job_id: str, text: str,
                tags: list[str], *, asker=None) -> dict:
    """뒤섞인 글을 갈래별로 나눠 넣는다."""
    payload = f"사용자가 적어 둔 것:\n{text.strip()[:MAX_COLLECT_CHARS]}"
    if tags:
        payload += f"\n\n출처(참고용, 태그로 붙는다): {', '.join(tags)}"
    try:
        raw = (asker or _ask_gemini)(settings, _PROMPT_COLLECT, payload, _model_of(user, settings))
    except Exception as e:  # noqa: BLE001
        logger.exception("단어장 정리 실패(모델)")
        _finish(user, job_id, {
            "status": STATUS_FAILED,
            # 대화 화면과 같은 표(ai/errors.py) — 한도 초과와 붐빔은 할 일이 다르다.
            "error": ai_errors.message(str(e), settings.debug)[:200],
        })
        return {"added": [], "merged": [], "failed": []}

    found = _entries(raw)
    entries = found[:MAX_ITEMS]
    if not entries:
        _finish(user, job_id, {"status": STATUS_FAILED, "error": "정리할 항목을 찾지 못했습니다."})
        return {"added": [], "merged": [], "failed": []}

    out = vocab_store.add_words(user, settings, entries, extra_tags=tags)
    _finish(user, job_id, {
        "status": STATUS_DONE,
        # 넘쳐서 못 넣은 것이 있으면 **말한다.** 붙여 넣은 글에서 250개를 찾아
        # 200개만 넣고 아무 말도 안 하면, 빠진 50개를 사용자가 알 길이 없다.
        "error": ("" if len(found) <= MAX_ITEMS else
                  f"{len(found)}개를 찾았지만 한 번에 {MAX_ITEMS}개까지만 넣습니다 — "
                  f"{len(found) - MAX_ITEMS}개는 빠졌습니다. 나눠서 다시 넣어 주세요."),
        "words": [str(e.get("word") or "") for e in entries],
        "added": [w.get("word", "") for w in out["added"]],
        "merged": [w.get("word", "") for w in out["merged"]],
        "failed": out["failed"],
    })
    return out


def _spawn(fn, user: SessionUser, job_id: str) -> None:
    def worker():
        try:
            fn()
        except Exception:  # noqa: BLE001
            logger.exception("단어장 작업 스레드 실패")
            _finish(user, job_id, {"status": STATUS_FAILED, "error": "정리 중 오류가 났습니다."})

    threading.Thread(target=worker, name=f"vocab-{job_id}", daemon=True).start()


def start_fill(user: SessionUser, settings: Settings, items: list[dict],
               tags: list[str], context: str = "") -> dict:
    """고른 항목 채우기를 백그라운드로 시작한다."""
    # 라우터가 상한을 넘는 요청을 이미 거절한다. 여기서는 빈 항목만 걸러 낸다.
    items = [i for i in items if isinstance(i, dict) and str(i.get("word") or "").strip()]
    job = _new_job(user, "fill", [str(i["word"]).strip() for i in items], tags)
    if not settings.gemini_api_key:
        # 키가 없어도 고른 것은 넣는다(뜻만 있는 항목으로) — 학습 흐름이 끊기지 않게
        _spawn(lambda: _fill_without_model(user, settings, job["id"], items, tags, context), user, job["id"])
        return job
    _spawn(lambda: run_fill(user, settings, job["id"], items, tags, context), user, job["id"])
    return job


def _fill_without_model(user: SessionUser, settings: Settings, job_id: str,
                        items: list[dict], tags: list[str], context: str) -> None:
    payloads = []
    for i in items:
        hint = str(i.get("meaning") or "").strip()
        payloads.append({
            "word": str(i.get("word") or "").strip(),
            "kind": str(i.get("kind") or "").strip(),
            "meanings": [hint] if hint else [],
            "context": context.strip()[:1000],
        })
    out = vocab_store.add_words(user, settings, payloads, extra_tags=tags)
    _finish(user, job_id, {
        "status": STATUS_DONE,
        "added": [w.get("word", "") for w in out["added"]],
        "merged": [w.get("word", "") for w in out["merged"]],
        "failed": out["failed"],
        "error": "GEMINI_API_KEY 가 없어 뜻만 넣었습니다.",
    })


def start_collect(user: SessionUser, settings: Settings, text: str, tags: list[str]) -> dict:
    """뒤섞인 글 정리를 백그라운드로 시작한다."""
    job = _new_job(user, "collect", [], tags)
    if not settings.gemini_api_key:
        _finish(user, job["id"], {"status": STATUS_FAILED,
                                  "error": "GEMINI_API_KEY 가 없어 정리할 수 없습니다."})
        return job
    _spawn(lambda: run_collect(user, settings, job["id"], text, tags), user, job["id"])
    return job
