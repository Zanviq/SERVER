"""단어장 API — 영어 학습 화면과 논문 화면이 함께 쓴다."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from .. import vocab_store
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/vocab", tags=["vocab"])


class WordInput(BaseModel):
    word: str
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
    limit: int = Query(0, ge=0, le=5000),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return vocab_store.list_words(user, settings, tag=tag, query=q, due_only=due, limit=limit)


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
