"""단어장 스킬 — 영어 학습·논문 화면에서 AI 가 단어를 넣고 찾고 고친다.

사용자가 "adequate 단어장에 넣어줘" 하면 모델이 **사전 내용까지 채워서**
add_vocab_words 를 부른다(뜻·유사어·영어 해설·예문·변화형·포인트). 서버는
사전을 갖고 있지 않으므로 채우는 쪽은 모델이다 — 그래서 파라미터 설명이 길다.

propose_vocab_words 는 **저장하지 않는다.** 논문을 읽다 사용자가 영어 질문을
하면 모델이 "이 단어들 단어장에 넣을까요?" 하고 후보를 내미는 용도다. 프런트가
이 호출을 보고 체크박스 목록을 띄운다. 후보를 모델이 바로 저장해 버리면 논문
한 편에 단어가 수십 개씩 쌓인다.

고른 뒤에는 **모델을 다시 거치지 않는다.** 프런트가 /api/vocab/fill 로 고른
목록을 직접 보내고 vocab_fill 이 백그라운드에서 채운다 — 예전처럼 "넣어줘"를
채팅으로 되돌려 보내면 모델이 직전 대화(후보 전체)를 보고 고르지 않은 것까지
넣었다.

단어장은 **영어 단어 전용이 아니다.** 논문 화면에서는 전문 용어(kind=term)가,
영어 학습에서는 문장·문법 항목이 함께 들어온다.

계약:
- list_vocab 이 준 id 를 update/delete 에 그대로 넘긴다.
- 같은 표제어를 다시 넣으면 새로 생기지 않고 합쳐진다(태그가 더해진다).
  결과의 merged 로 알 수 있다.
"""
from __future__ import annotations

from ... import vocab_store
from ..skill_base import SkillBase, SkillResult
from .todo import _fail

_MAX_ROWS = 200

#: 사전 항목 스키마(add 와 update 가 공유). 모델이 채우는 내용이므로 어떤 말로
#: 어떻게 쓰는지 설명에 적는다 — 예시 문서(영어학습예시)의 형식 그대로.
_WORD_PROPS = {
    "word": {"type": "string", "description": "표제어(원형). 과거형·복수형은 원형으로 바꿔 넣는다. "
                                              "문장이면 문장 그대로, 문법 항목이면 그 이름."},
    "kind": {
        "type": "string", "enum": list(vocab_store.KINDS),
        "description": "갈래. word=낱말, phrase=숙어·표현, sentence=문장 통째, "
                       "grammar=문법 항목, term=전문 용어·고유명사(영어가 아니어도 된다). "
                       "안 주면 표제어 모양으로 짐작한다.",
    },
    "pos": {"type": "string", "description": "품사. 예: 동사, 형용사, 명사, 부사, 숙어"},
    "pronunciation": {"type": "string", "description": "발음(IPA)과 강세. 예: /ˈædɪkwət/ 첫 음절 강세"},
    "meanings": {
        "type": "array", "items": {"type": "string"},
        "description": "한국어 뜻 목록. 자주 쓰는 순서. 예: ['충분한, 적당한', '(겨우) 만족스러운']",
    },
    "english_def": {"type": "string", "description": "영어 해설 한두 문장(영어로)."},
    "synonyms": {
        "type": "array", "items": {"type": "string"},
        "description": "비슷한 단어. '단어(뜻)' 꼴. 예: ['sufficient(충분한)', 'enough(충분한)']",
    },
    "antonyms": {
        "type": "array", "items": {"type": "string"},
        "description": "반대말. '단어(뜻)' 꼴.",
    },
    "examples": {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "en": {"type": "string", "description": "영어 예문"},
                "ko": {"type": "string", "description": "해석"},
                "grammar": {"type": "string", "description": "그 문장에서의 문법 포인트 한 줄"},
            },
            "required": ["en", "ko"],
        },
        "description": "예문 2~3개. 사용자가 보낸 문장이 있으면 그 문장을 첫 예문으로.",
    },
    "forms": {
        "type": "string",
        "description": "변화형. 동사면 'run – ran – run – running', 그 외엔 품사 변화 "
                       "'형용사 adequate / 부사 adequately / 명사 adequacy'.",
    },
    "notes": {
        "type": "string",
        "description": "불규칙 포인트·뉘앙스·발음 강세·헷갈리는 단어와의 차이. 짧게.",
    },
    "context": {"type": "string", "description": "이 단어를 만난 원문 문장(있으면)."},
}


def _row(w: dict) -> dict:
    return {
        "id": w.get("id", ""),
        "word": w.get("word", ""),
        "kind": w.get("kind", ""),
        "pos": w.get("pos", ""),
        "meanings": list(w.get("meanings") or [])[:4],
        "tags": list(w.get("tags") or []),
        "level": int(w.get("level") or 0),
        "next_review": w.get("next_review", ""),
    }


def _full(w: dict) -> dict:
    keys = ("id", "word", "kind", "pos", "pronunciation", "meanings", "english_def", "synonyms",
            "antonyms", "examples", "forms", "notes", "tags", "context", "level",
            "next_review", "review_ok", "review_ng")
    return {k: w.get(k) for k in keys if k in w}


class ListVocab(SkillBase):
    name = "list_vocab"
    description = (
        "단어장을 본다. tag 로 출처(논문 제목 등)만 거르고, query 로 표제어·뜻·유사어를 찾는다. "
        "due_only 면 오늘 복습할 단어만. 여기서 얻은 id 를 update_vocab_word/delete_vocab_word 에 넘긴다. "
        "'이 단어 있어?'는 query 로 묻는다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "tag": {"type": "string", "description": "이 태그가 붙은 단어만."},
            "query": {"type": "string", "description": "검색어(표제어·뜻·유사어·문맥)."},
            "due_only": {"type": "boolean", "description": "오늘 복습할 것만."},
            "kind": {"type": "string", "enum": list(vocab_store.KINDS),
                     "description": "갈래로 거른다(word/phrase/sentence/grammar/term)."},
            "full": {"type": "boolean", "description": "true 면 사전 내용 전부(예문·해설). 기본은 요약."},
            "limit": {"type": "integer", "description": "최대 개수(기본 50)."},
        },
    }

    def run(self, args, ctx):
        limit = int(args.get("limit") or 50)
        limit = max(1, min(limit, _MAX_ROWS))
        try:
            words = vocab_store.list_words(
                ctx.user, ctx.settings,
                tag=str(args.get("tag") or ""), query=str(args.get("query") or ""),
                due_only=bool(args.get("due_only")), kind=str(args.get("kind") or ""),
            )
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        total = len(words)
        rows = [(_full if args.get("full") else _row)(w) for w in words[:limit]]
        msg = f"단어 {total}개"
        if total > limit:
            # 모델이 스스로 limit 을 줬다면 잘린 게 아니라 **시킨 대로** 낸 것이다.
            # 그때까지 "tag/query 로 좁히세요"라고 하면, 이미 좁혀 놓고 세 개만
            # 달라고 한 모델에게 엉뚱한 훈수를 두는 셈이다(47차에서 실제로 봤다).
            asked = args.get("limit")
            msg += (f" (요청한 {limit}개만 냈습니다)" if asked
                    else f" (앞 {limit}개만 표시 — tag/query 로 좁히세요)")
        return SkillResult(ok=True, message=msg, data={"items": rows, "total": total})


class ListVocabTags(SkillBase):
    name = "list_vocab_tags"
    description = "단어장의 태그(출처) 목록과 개수. 어떤 논문·주제에서 단어를 모았는지 볼 때."
    parameters = {"type": "object", "properties": {}}

    def run(self, args, ctx):
        try:
            tags = vocab_store.list_tags(ctx.user, ctx.settings)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        return SkillResult(ok=True, message=f"태그 {len(tags)}개", data={"tags": tags})


class AddVocabWords(SkillBase):
    mutates = "vocab"
    expose_data = True  # 화면이 "추가됨: …" 칩을 보여 준다
    name = "add_vocab_words"
    description = (
        "단어장에 단어를 넣는다. **사전 내용은 네가 채운다** — 뜻(여러 개)·비슷한 단어·반대말·"
        "영어 해설·예문(해석+문법)·변화형·포인트를 간결하게. 사용자가 보낸 문장에서 나온 단어면 "
        "context 에 그 문장을 넣고 예문 첫 줄로도 쓴다. 여러 단어를 한 번에 넣을 수 있다. "
        "tags 에는 출처를 적는다(논문 화면이면 논문 제목이 자동으로 붙으니 비워도 된다). "
        "이미 있는 단어는 새로 만들지 않고 합쳐진다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "words": {
                "type": "array",
                "items": {"type": "object", "properties": _WORD_PROPS, "required": ["word", "meanings"]},
                "description": "넣을 단어들(사전 내용 포함).",
            },
            "tags": {
                "type": "array", "items": {"type": "string"},
                "description": "모든 단어에 붙일 태그(출처). 예: ['일상 대화'], ['TOEIC'].",
            },
        },
        "required": ["words"],
    }

    def run(self, args, ctx):
        words = args.get("words")
        if not isinstance(words, list) or not words:
            return SkillResult(ok=False, message="넣을 단어가 없습니다.", error_code="invalid")
        tags = args.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        # 화면(논문 등)이 정한 기본 태그가 있으면 모델이 뭘 주든 함께 붙는다
        tags = list(tags) + list(ctx.vocab_tags or [])
        try:
            out = vocab_store.add_words(ctx.user, ctx.settings, words, extra_tags=tags)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        added = [w["word"] for w in out["added"]]
        merged = [w["word"] for w in out["merged"]]
        failed = out["failed"]
        bits = []
        if added:
            bits.append(f"추가 {len(added)}개: " + ", ".join(added))
        if merged:
            bits.append(f"이미 있어 합침 {len(merged)}개: " + ", ".join(merged))
        if failed:
            bits.append(f"실패 {len(failed)}개: " + ", ".join(f"{f['word']}({f['reason']})" for f in failed))
        ok = bool(added or merged)
        return SkillResult(
            ok=ok, message=" / ".join(bits) or "아무것도 넣지 못했습니다.",
            data={
                "added": [_row(w) for w in out["added"]],
                "merged": [_row(w) for w in out["merged"]],
                "failed": failed,
                "tags": tags,
            },
            error_code="" if ok else "invalid",
        )


class ProposeVocabWords(SkillBase):
    expose_data = True  # 화면이 후보 체크 목록을 그린다
    name = "propose_vocab_words"
    description = (
        "저장하지 않고 '이것들을 단어장에 넣을까요?' 하고 **후보를 내민다.** 사용자가 단어·문장·"
        "문법·전문 용어를 물었을 때, 답을 다 한 뒤 이 스킬로 그 답에 나온 어려운 것들을 후보로 "
        "올린다. 화면에 체크 목록이 뜨고 **사용자가 고른 것만** 저장된다(사전 내용은 서버가 "
        "백그라운드에서 채우므로 너는 한 줄 뜻만 주면 된다). "
        "사용자가 이미 '넣어줘'라고 분명히 말했으면 이걸 쓰지 말고 add_vocab_words 로 바로 넣는다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "words": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "word": {"type": "string", "description": "표제어(원형)"},
                        "kind": {"type": "string", "enum": list(vocab_store.KINDS),
                                 "description": "갈래. 논문의 전문 용어는 term."},
                        "pos": {"type": "string"},
                        "meaning": {"type": "string", "description": "한 줄 뜻(체크 목록에 보일 것)"},
                    },
                    "required": ["word", "meaning"],
                },
            },
            "context": {"type": "string", "description": "단어들이 나온 원문 문장(있으면)."},
        },
        "required": ["words"],
    }

    def run(self, args, ctx):
        words = args.get("words")
        if not isinstance(words, list) or not words:
            return SkillResult(ok=False, message="후보가 없습니다.", error_code="invalid")
        clean = []
        seen: set[str] = set()
        for w in words:
            if not isinstance(w, dict):
                continue
            hw = str(w.get("word") or "").strip()
            if not hw or hw.lower() in seen:
                continue
            seen.add(hw.lower())
            kind = str(w.get("kind") or "").strip().lower()
            clean.append({
                "word": hw[:vocab_store.MAX_WORD],
                "kind": kind if kind in vocab_store.KINDS else vocab_store.guess_kind(hw),
                "pos": str(w.get("pos") or "")[:60],
                "meaning": str(w.get("meaning") or "")[:200],
            })
        if not clean:
            return SkillResult(ok=False, message="후보가 없습니다.", error_code="invalid")
        # 이미 단어장에 있는 것은 표시해 준다(사용자가 다시 고르지 않도록)
        try:
            existing = {vocab_store.headword(x.get("word")) for x in
                        vocab_store.list_words(ctx.user, ctx.settings)}
        except Exception:  # noqa: BLE001
            existing = set()
        for c in clean:
            c["exists"] = c["word"].lower() in existing
        return SkillResult(
            ok=True,
            message=f"후보 {len(clean)}개를 화면에 띄웠습니다. **고른 것만** 백그라운드에서 채워 "
                    "저장되니 너는 더 넣지 말고, 이 뒤에 짧게 '넣을 것을 골라 주세요' 정도만 말하면 된다.",
            data={"proposal": clean, "context": str(args.get("context") or "")[:1000],
                  "tags": list(ctx.vocab_tags or [])},
        )


class UpdateVocabWord(SkillBase):
    mutates = "vocab"
    name = "update_vocab_word"
    description = (
        "단어장 항목을 고친다. id 는 list_vocab 으로 얻는다. 준 필드만 바뀐다. "
        "예문을 더하거나 뜻을 고치거나 태그를 바꿀 때."
    )
    parameters = {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "list_vocab 이 준 id"},
            **_WORD_PROPS,
            "tags": {"type": "array", "items": {"type": "string"}, "description": "태그 전체(교체)."},
        },
        "required": ["id"],
    }

    def run(self, args, ctx):
        wid = str(args.get("id") or "").strip()
        if not wid:
            return SkillResult(ok=False, message="id 가 없습니다.", error_code="invalid")
        patch = {k: v for k, v in args.items() if k != "id" and v is not None}
        if not patch:
            return SkillResult(ok=False, message="바꿀 내용이 없습니다.", error_code="invalid")
        try:
            w = vocab_store.update_word(ctx.user, ctx.settings, wid, patch)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        return SkillResult(ok=True, message=f"'{w['word']}' 수정됨", data=_row(w))


class DeleteVocabWord(SkillBase):
    mutates = "vocab"
    name = "delete_vocab_word"
    description = "단어장에서 지운다(휴지통으로 간다). id 는 list_vocab 으로 얻는다."
    parameters = {
        "type": "object",
        "properties": {"id": {"type": "string", "description": "list_vocab 이 준 id"}},
        "required": ["id"],
    }

    def run(self, args, ctx):
        wid = str(args.get("id") or "").strip()
        if not wid:
            return SkillResult(ok=False, message="id 가 없습니다.", error_code="invalid")
        try:
            out = vocab_store.delete_word(ctx.user, ctx.settings, wid)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        return SkillResult(ok=True, message=f"'{out['word']}' 휴지통으로 이동", data=out)


VOCAB_SKILLS: list[SkillBase] = [
    ListVocab(), ListVocabTags(), AddVocabWords(), ProposeVocabWords(),
    UpdateVocabWord(), DeleteVocabWord(),
]
