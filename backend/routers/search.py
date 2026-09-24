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
    found = search_all.find(user, settings, q, picked or search_all.KINDS, limit)
    # more: 갈래마다 잘려서 안 보인 수. at_least: 그 수가 "적어도"인 갈래(끝까지 세지 못했다)
    return {"query": q, "hits": found.hits, "more": found.more, "more_at_least": sorted(found.at_least)}
