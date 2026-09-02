"""설정 API: 개인 settings.json 조회/부분수정."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import user_settings
from ..ai import models as ai_models
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
    # 없는 모델 id가 저장되면 그 뒤로 AI가 통째로 실패한다 — 저장 전에 막는다.
    # `{"ai": 1}` 처럼 섹션이 dict 가 아닐 수도 있다(그냥 무시된다). 여기서 .get 을
    # 부르면 AttributeError 로 500 이 됐다.
    ai_section = body.changes.get("ai")
    model = ai_section.get("model") if isinstance(ai_section, dict) else None
    if model is not None and not ai_models.is_allowed(settings, str(model)):
        raise HTTPException(status_code=400, detail=f"쓸 수 없는 모델입니다: {model}")
    return {"settings": user_settings.patch(user, settings, body.changes)}
