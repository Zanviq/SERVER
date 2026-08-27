"""AI 라우터: ReAct 비서 채팅(SSE 스트리밍).

스킬은 모두 세션 사용자 스코프(common | 본인 me)로만 동작하므로,
다른 사용자의 파일/노트/일정에는 접근할 수 없다.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..ai import models as ai_models
from ..ai import orchestrator
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/ai", tags=["ai"])


class ChatTurn(BaseModel):
    role: str  # user | assistant
    text: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatTurn] = []


@router.get("/status")
def status(settings: Settings = Depends(get_settings)):
    """AI 사용 가능 여부."""
    return {"enabled": bool(settings.gemini_api_key), "model": settings.gemini_model}


@router.get("/models")
def models(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """설정 화면 드롭다운용 — 비서로 쓸 수 있는 Gemini 모델 목록."""
    return {"models": ai_models.list_models(settings), "server_default": settings.gemini_model}


@router.post("/chat")
def chat(
    body: ChatRequest,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """ReAct 비서. SSE로 thought/tool_call/tool_result/text/done 이벤트 스트리밍."""
    today = date.today().isoformat()

    history = [{"role": t.role, "text": t.text} for t in body.history][-12:]

    def gen():
        try:
            for ev in orchestrator.run(
                user, settings, body.message, today, history=history
            ):
                yield orchestrator.sse_format(ev)
        except Exception as e:  # noqa: BLE001
            yield orchestrator.sse_format({"type": "error", "message": str(e)})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
