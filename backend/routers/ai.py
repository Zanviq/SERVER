"""AI 라우터: ReAct 비서 채팅(SSE 스트리밍).

스킬은 모두 세션 사용자 스코프(common | 본인 me)로만 동작하므로,
다른 사용자의 파일/노트/일정에는 접근할 수 없다.
"""
from __future__ import annotations

from datetime import date

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..ai import models as ai_models
from ..ai import orchestrator
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

logger = logging.getLogger("server.ai.router")

router = APIRouter(prefix="/api/ai", tags=["ai"])


class ChatTurn(BaseModel):
    role: str  # user | assistant
    text: str


#: 한 요청에서 모델로 나가는 양의 상한. 키는 주인 것 하나이므로, 승인된
#: 계정이라도 무제한으로 태울 수 있으면 안 된다(요금과 지연 모두).
MAX_MESSAGE_CHARS = 8000
MAX_HISTORY_TURNS = 20
MAX_HISTORY_CHARS = 24000


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

    message = (body.message or "")[:MAX_MESSAGE_CHARS]
    if not message.strip():
        raise HTTPException(status_code=400, detail="메시지가 비어 있습니다.")

    # 최근 것부터 담되 총량도 제한한다. 턴 수만 자르면 장문 몇 개로 뚫린다.
    history: list[dict] = []
    budget = MAX_HISTORY_CHARS
    for t in reversed(body.history[-MAX_HISTORY_TURNS:]):
        text = (t.text or "")[:MAX_MESSAGE_CHARS]
        if budget - len(text) < 0:
            break
        budget -= len(text)
        history.append({"role": t.role, "text": text})
    history.reverse()

    def gen():
        try:
            for ev in orchestrator.run(
                user, settings, message, today, history=history
            ):
                yield orchestrator.sse_format(ev)
        except Exception as e:  # noqa: BLE001
            # 내부 예외 문자열을 사용자에게 그대로 흘리지 않는다(경로·키가 섞일 수 있다).
            logger.exception("AI 스트림 실패")
            detail = str(e) if settings.debug else "처리 중 오류가 발생했습니다."
            yield orchestrator.sse_format({"type": "error", "message": detail})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
