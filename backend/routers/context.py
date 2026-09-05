"""컨텍스트(지난 대화) 열람 API — 화면 `/context` 가 쓴다.

읽기 전용이다. 지우는 것은 기존 `/api/ai/space/...` 가 맡는다(대화를 만든 화면과
같은 길로 지우는 편이 헷갈리지 않는다).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from .. import context_store
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/context", tags=["context"])


@router.get("/spaces")
def spaces(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """왼쪽 폴더 목록. 대화가 없는 공간도 낸다(고정 공간은 늘 자리를 지킨다)."""
    return {"spaces": context_store.space_rows(user, settings)}


@router.get("/sessions")
def sessions(
    space: str = Query(..., description="공간 이름"),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """그 공간의 세션 목록(최근 순). 세션은 30분 간격으로 나눈다."""
    msgs = context_store.load_space(user, settings, space)
    return {
        "space": space,
        "label": context_store.space_label(user, settings, space),
        "sessions": context_store.session_rows(msgs),
    }


@router.get("/messages")
def messages(
    space: str = Query(..., description="공간 이름"),
    session: str = Query("", description="세션 id. 비우면 전체"),
    limit: int = Query(0, ge=0, le=2000),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """대화 원문. 스킬 호출 기록(meta.tools)도 그대로 나간다 — 감사용이다."""
    return {
        "space": space,
        "label": context_store.space_label(user, settings, space),
        "messages": context_store.read(user, settings, space, session=session, limit=limit),
    }


@router.get("/search")
def search(
    q: str = Query(..., min_length=1, description="찾을 말"),
    space: str = Query("", description="이 공간만. 비우면 전부"),
    limit: int = Query(30, ge=1, le=100),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    hits = context_store.search(
        user, settings, q, spaces=[space] if space else None, limit=limit,
    )
    return {"hits": hits, "query": q}
