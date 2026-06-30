"""설정 API: 개인 settings.json 조회/부분수정."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import user_settings
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/settings", tags=["settings"])


class PatchBody(BaseModel):
    changes: dict


@router.get("")
@router.get("/")
def get_settings_endpoint(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return {
        "settings": user_settings.load(user, settings),
        "defaults": user_settings.DEFAULTS,
    }


@router.patch("")
@router.patch("/")
def patch_settings(
    body: PatchBody,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return {"settings": user_settings.patch(user, settings, body.changes)}
