"""전역 검색 — 화면을 가로질러 한 번에 찾는다."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from .. import links, search_all
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
    # href: 고르면 갈 화면. 링크와 같은 규칙(links.screen_of) 하나로 만든다 — 화면이 따로
    # 규칙을 들고 있으면 한쪽만 고쳐진다. AI 스킬은 find 를 직접 쓰므로 여기서만 붙인다.
    hits = [{**h, "href": links.screen_of(h["kind"], h["id"], h["when"])} for h in found.hits]
    # more: 갈래마다 잘려서 안 보인 수. at_least: 그 수가 "적어도"인 갈래(끝까지 세지 못했다)
    return {"query": q, "hits": hits, "more": found.more, "more_at_least": sorted(found.at_least)}
