"""전역 검색 — 화면을 가로질러 한 번에 찾는다."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from .. import search_all
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
def search(
    q: str = Query(..., min_length=1, max_length=200),
    kinds: str = Query("", description="쉼표로 구분한 갈래. 비우면 전부."),
    limit: int = Query(40, ge=1, le=100),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    picked = tuple(k for k in (kinds or "").split(",") if k in search_all.KINDS)
    hits = search_all.search(user, settings, q, picked or search_all.KINDS, limit)
    return {"query": q, "hits": hits}
