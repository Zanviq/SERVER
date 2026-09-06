"""단어장 API — 영어 학습 화면과 논문 화면이 함께 쓴다."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .. import vocab_fill, vocab_store
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/vocab", tags=["vocab"])


class WordInput(BaseModel):
    word: str
    kind: str | None = None
    pos: str | None = None
    pronunciation: str | None = None
    meanings: list[str] | str | None = None
    english_def: str | None = None
    synonyms: list[str] | str | None = None
    antonyms: list[str] | str | None = None
    examples: list[Any] | None = None
    forms: str | None = None
    notes: str | None = None
    tags: list[str] | str | None = None
    context: str | None = None
    source: str | None = None


class WordPatch(WordInput):
    word: str | None = None  # type: ignore[assignment]


class BulkInput(BaseModel):
    words: list[WordInput]
    #: 모든 단어에 함께 붙일 태그(논문 이름 등)
    tags: list[str] | None = None


class TagRename(BaseModel):
    old: str
    new: str = ""


class FillItem(BaseModel):
    """후보 목록에서 사용자가 고른 항목. 사전 내용은 서버가 채운다."""
    word: str
    meaning: str = ""
    kind: str = ""


class FillInput(BaseModel):
    words: list[FillItem]
    tags: list[str] = []
    context: str = ""


class CollectInput(BaseModel):
    """단어·문장·문법을 뒤섞어 적은 글. AI 가 갈래로 나눠 넣는다."""
    text: str
    tags: list[str] = []


class ReviewInput(BaseModel):
    ok: bool


@router.get("/board")
def board(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """단어·태그·통계를 한 번에(화면 첫 로드)."""
    return vocab_store.board(user, settings)


@router.get("/words")
def words(
    tag: str = Query("", description="이 태그가 붙은 단어만"),
    q: str = Query("", description="표제어·뜻·유사어·문맥 검색"),
    due: bool = Query(False, description="오늘 복습할 것만"),
    kind: str = Query("", description="갈래(word/phrase/sentence/grammar/term)"),
    limit: int = Query(0, ge=0, le=5000),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return vocab_store.list_words(user, settings, tag=tag, query=q, due_only=due,
                                  kind=kind, limit=limit)


@router.get("/tags")
def tags(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return vocab_store.list_tags(user, settings)


@router.get("/stats")
def stats(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return vocab_store.stats(user, settings)


@router.post("/words")
def word_create(
    req: WordInput,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    word, merged = vocab_store.add_word(user, settings, req.model_dump(exclude_none=True))
    return {"word": word, "merged": merged}


@router.post("/words/bulk")
def words_bulk(
    req: BulkInput,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return vocab_store.add_words(
        user, settings, [w.model_dump(exclude_none=True) for w in req.words],
        extra_tags=req.tags or [],
    )


@router.put("/words/{wid}")
def word_update(
    wid: str,
    req: WordPatch,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return vocab_store.update_word(user, settings, wid, req.model_dump(exclude_none=True))


@router.delete("/words/{wid}")
def word_delete(
    wid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return vocab_store.delete_word(user, settings, wid)


@router.post("/fill")
def fill(
    req: FillInput,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """고른 항목을 **백그라운드에서** 사전 형식으로 채워 넣는다.

    넣을 목록을 서버가 쥐고 모델 결과를 그 목록으로 걸러내므로, 고르지 않은
    항목이 딸려 들어갈 수 없다. 대화를 막지 않도록 즉시 돌아온다.
    """
    if not req.words:
        raise HTTPException(status_code=400, detail="넣을 항목이 없습니다.")
    # 조용히 자르지 않는다. 앞 40개만 남기고 아무 말도 안 하던 시절에는 60개를
    # 고른 사용자가 40개만 저장된 것을 눈치채지 못했다(실측).
    if len(req.words) > vocab_fill.MAX_ITEMS:
        raise HTTPException(
            status_code=400,
            detail=f"한 번에 {vocab_fill.MAX_ITEMS}개까지 넣을 수 있습니다 "
                   f"({len(req.words)}개를 고르셨습니다). 나눠서 넣어 주세요.")
    items = [w.model_dump() for w in req.words]
    tags = [t for t in (vocab_store.normalize_tag(t) for t in req.tags) if t]
    return vocab_fill.start_fill(user, settings, items, tags, req.context[:2000])


@router.post("/collect")
def collect(
    req: CollectInput,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """뒤섞어 적은 글을 AI 가 단어·문장·문법·용어로 나눠 넣는다(백그라운드)."""
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="정리할 내용이 없습니다.")
    if len(text) > vocab_fill.MAX_COLLECT_CHARS:
        raise HTTPException(status_code=413,
                            detail=f"한 번에 {vocab_fill.MAX_COLLECT_CHARS}자까지 정리합니다.")
    tags = [t for t in (vocab_store.normalize_tag(t) for t in req.tags) if t]
    return vocab_fill.start_collect(user, settings, text, tags)


@router.get("/jobs")
def jobs(user: SessionUser = Depends(require_session)):
    """백그라운드 정리 작업 상태(진행 표시용). 서버 재시작이면 비어 있다."""
    return {"jobs": vocab_fill.jobs_for(user)}


@router.post("/tags/rename")
def tag_rename(
    req: TagRename,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return vocab_store.rename_tag(user, settings, req.old, req.new)


@router.get("/review")
def review_queue(
    tag: str = Query(""),
    limit: int = Query(20, ge=1, le=200),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return vocab_store.review_queue(user, settings, tag=tag, limit=limit)


@router.post("/words/{wid}/review")
def review(
    wid: str,
    req: ReviewInput,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return vocab_store.record_review(user, settings, wid, req.ok)
