"""단어장 스킬 — 영어 학습·논문 화면에서 AI 가 단어를 넣고 찾고 고친다.

**대화에서 오는 것은 어느 스킬이든 단어장에 바로 쓰지 않는다.** add_vocab_words
든 propose_vocab_words 든 화면에 체크 목록을 띄우고 끝이다 — 실제로 넣는 것은
사용자가 고른 뒤 화면이 부르는 /api/vocab/fill 뿐이다.

그렇게까지 하는 이유는 사용자가 두 번 겪었기 때문이다.
  1. 낱말 하나만 쳐도 모델이 제멋대로 넣었다(3번 중 2번, 71차 실측).
  2. 넣어 달라고 했을 때도 모델이 고른 목록과 사용자가 넣고 싶은 것이 달라서,
     문장 하나를 물어도 대여섯 개가 통째로 들어갔다.
고르지도 않은 단어는 복습 대기열에 영영 남는다. 목록을 한 번 누르는 것이
원치 않는 단어를 하나씩 지우는 것보다 싸다.

또 **후보 목록은 넣어 달라고 했을 때만 뜬다**(`_asked_for_vocab`). 예전에는
프롬프트가 "설명한 뒤에는 후보를 올리세요"라고 무조건 시켜서, 뜻을 물을 때마다
목록이 답 밑에 따라붙었다 — 사용자가 직접 보고한 문제다.

사전 내용(뜻·유사어·예문·변화형)은 고른 뒤 vocab_fill 이 채운다. 그래서 모델은
한 줄 뜻만 주면 된다.

단어장은 **영어 단어 전용이 아니다.** 논문 화면에서는 전문 용어(kind=term)가,
영어 학습에서는 문장·문법 항목이 함께 들어온다.

계약:
- list_vocab 이 준 id 를 update/delete 에 그대로 넘긴다.
- 같은 표제어를 다시 넣으면 새로 생기지 않고 합쳐진다(태그가 더해진다).
  결과의 merged 로 알 수 있다.
"""
from __future__ import annotations

import logging
import re

from ... import vocab_store
from ..skill_base import SkillBase, SkillResult
from .todo import _fail

logger = logging.getLogger("server.ai.vocab")

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
    meanings = list(w.get("meanings") or [])
    row = {
        "id": w.get("id", ""),
        "word": w.get("word", ""),
        "kind": w.get("kind", ""),
        "pos": w.get("pos", ""),
        "meanings": meanings[:4],
        "tags": list(w.get("tags") or []),
        "level": int(w.get("level") or 0),
        "next_review": w.get("next_review", ""),
    }
    # 뜻을 넷에서 끊는 것을 알리지 않으면 "이 단어 뜻 다 알려줘"에 넷만 말한다
    if len(meanings) > 4:
        row["meanings_total"] = len(meanings)
        row["more"] = "뜻이 더 있습니다 — full=true 로 다시 조회하세요"
    return row


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


def _as_proposal(words: list, ctx) -> SkillResult:
    """저장 대신 **체크 목록**으로 돌려준다.

    화면은 propose_vocab_words 와 같은 모양의 data 를 보고 목록을 그린다.
    사용자가 고르면 /api/vocab/fill 로 바로 가므로, 여기서 아무것도 저장하지
    않아도 한 번 누르는 것으로 끝난다.
    """
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
            "meaning": ", ".join(str(m) for m in (w.get("meanings") or []) if m)[:200],
        })
    if not clean:
        return SkillResult(ok=False, message="넣을 단어가 없습니다.", error_code="invalid")
    try:
        existing = {vocab_store.headword(x.get("word")) for x in
                    vocab_store.list_words(ctx.user, ctx.settings)}
    except Exception:  # noqa: BLE001
        existing = set()
    for c in clean:
        c["exists"] = c["word"].lower() in existing
    return SkillResult(
        ok=True,
        # **모델에게 "실패했다"고 들리면 안 된다.** 예전 문구는 "넣어 달라고 하지
        # 않아 저장하지 않았습니다"였는데, 이제는 넣어 달라고 했을 때도 이 길로
        # 오므로 앞뒤가 안 맞는다. 실제로 모델이 그 말에 혼란스러워하며 "결과
        # 메시지가 적절하지 않습니다" 같은 속엣말을 답에 그대로 적었다(실측).
        #
        # 지금 일어난 일을 그대로 적는다: 목록을 띄웠고, 고르는 것은 사용자다.
        message=(f"단어 {len(clean)}개를 화면의 체크 목록으로 띄웠습니다. "
                 "**아직 아무것도 저장되지 않았습니다** — 사용자가 목록에서 고르면 그때 "
                 "저장됩니다(사전 내용은 서버가 채웁니다).\\n"
                 "**'추가했습니다'·'넣었습니다'라고 말하지 마세요. 거짓말이 됩니다.** "
                 "'아래에서 넣을 것을 골라 주세요' 한 줄이면 충분합니다. "
                 "이번 답에서 다른 스킬을 더 부르지도 마세요."),
        data={"proposal": clean, "context": "", "tags": list(ctx.vocab_tags or [])},
    )


class AddVocabWords(SkillBase):
    # 이 스킬은 이제 **저장하지 않는다**(체크 목록으로 돌려준다) — mutates 를 두면
    # 화면이 바뀌지도 않은 단어장을 다시 받아 온다.
    expose_data = True  # 화면이 체크 목록을 그린다
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
        # **대화에서 들어오는 것은 언제나 체크 목록을 거친다.**
        #
        # 예전에는 사용자가 "넣어줘"라고 하면 모델이 고른 대로 바로 저장했다.
        # 그런데 모델이 고르는 목록과 사용자가 넣고 싶은 것은 자주 다르다 —
        # 문장 하나를 물어도 대여섯 개를 통째로 넣어 버리고, 고르지도 않은
        # 단어가 복습 대기열에 영영 남는다. 어느 것을 넣을지는 사용자가 정한다.
        #
        # 손해가 다르다: 목록을 한 번 누르는 것과, 원치 않는 단어를 하나씩
        # 지우는 것. 사전 내용은 고른 뒤 서버가 채우므로 품질도 같다
        # (/api/vocab/fill → vocab_fill).
        return _as_proposal(words, ctx)


#: "단어장에 넣어 달라"고 실제로 말했는가.
#:
#: 예전에는 프롬프트가 "설명한 뒤에는 후보를 올리세요"라고 무조건 시켰고, 서버까지
#: 나서서 채웠다(vocab_suggest). 그 결과 **단어를 물을 때마다 매번** "단어장에
#: 넣을까요?" 목록이 떴다 — 묻지도 않았는데 화면 절반을 차지하고, 끄는 방법도 없었다.
#: 회의 문서의 `_asked_to_save` 와 같은 자리다: 부탁으로는 양쪽으로 어긋나므로
#: 서버가 사용자의 말을 직접 본다.
_ASK_FOR_VOCAB = re.compile(
    r"단어장|단어 ?장|어휘장|외울|외워|암기"
    r"|(넣|담|저장|추가|등록)\w*\s*(줘|주세요|해줘|해 줘|하자|할래|해라|해 주|해줄)"
    r"|넣어|담아|저장해|추가해|등록해"
    r"|\bvocab\w*\b|add to my? ?(word|vocab)"
)


def _asked_for_vocab(ctx) -> bool:
    """이번 차례에 사람이 '단어장에 넣어 달라'고 했는가.

    안 했으면 후보를 내밀지 않는다. 잘못 판단해도 손해가 다르다 — 안 내밀면
    사용자가 "단어장에 넣어줘" 한 번 더 말하면 되고, 잘못 내밀면 물어볼 때마다
    긴 목록이 답 밑에 따라붙는다(그게 지금까지의 모습이었다).

    화면이 부른 것(user_message 가 비어 있는 경우)은 사용자가 단추를 눌러 시킨
    일이므로 막지 않는다.
    """
    msg = str(getattr(ctx, "user_message", "") or "")
    return not msg.strip() or bool(_ASK_FOR_VOCAB.search(msg))


class ProposeVocabWords(SkillBase):
    expose_data = True  # 화면이 후보 체크 목록을 그린다
    name = "propose_vocab_words"
    description = (
        "저장하지 않고 '이것들을 단어장에 넣을까요?' 하고 **후보를 내민다.** "
        "**사용자가 '단어장에 넣어 줘'라고 말했을 때만 쓴다** — 단어를 설명해 달라는 말은 "
        "설명해 달라는 뜻이지 단어장에 넣으라는 뜻이 아니다. "
        "화면에 체크 목록이 뜨고 **사용자가 고른 것만** 저장된다(사전 내용은 서버가 "
        "백그라운드에서 채우므로 너는 한 줄 뜻만 주면 된다). "
        "어떤 단어를 넣을지 분명하면 이걸로 후보를 내밀고, 사용자가 고르게 한다."
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
        if not _asked_for_vocab(ctx):
            # 사용자는 뜻을 물었을 뿐이다. 목록을 띄우지 않고 **답만** 하게 한다.
            return SkillResult(
                ok=True,
                message=("사용자가 단어장에 넣어 달라고 하지 않아 **후보를 띄우지 않았습니다.** "
                         "설명만 하고, 단어장 이야기는 꺼내지 마세요. 사용자가 나중에 "
                         "'단어장에 넣어 줘'라고 하면 그때 이 스킬을 부르면 됩니다."),
                data={"skipped": True},
            )
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
            # "더 넣지 마라"는 이번 차례에만 해당한다 — 이 문장이 대화 기록에 남아
            # 다음 차례의 "넣어줘"까지 막지 않도록 범위를 분명히 적는다.
            message=f"후보 {len(clean)}개를 화면의 체크 목록으로 띄웠습니다. "
                    "**아직 아무것도 저장되지 않았습니다** — 사용자가 고르면 그때 저장됩니다.\\n"
                    "**'추가했습니다'·'넣었습니다'라고 말하지 마세요. 거짓말이 됩니다.** "
                    "'아래에서 넣을 것을 골라 주세요' 한 줄이면 충분합니다.",
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
