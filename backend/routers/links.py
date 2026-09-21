"""링크 — 입력칸의 `[갈래/경로]` 후보와, 링크를 눌렀을 때 열 화면.

본문은 여기서 주지 않는다. 링크 내용은 채팅 요청 안에서 **모델에게만** 간다
(backend/links.py 설명 참조).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from .. import links
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/links", tags=["links"])


@router.get("/suggest")
def suggest(
    q: str = Query("", max_length=300),
    limit: int = Query(30, ge=1, le=60),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return {"query": q, "items": links.suggest(user, settings, q, limit)}


@router.get("/open")
def open_link(
    path: str = Query(..., min_length=1, max_length=600),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """링크 → 그 항목을 여는 화면 주소. 못 찾으면 found=false(화면이 알린다)."""
    return links.resolve(user, settings, path).brief()
