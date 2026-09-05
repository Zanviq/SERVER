"""AI 라우터: ReAct 비서 채팅(SSE 스트리밍).

스킬은 모두 세션 사용자 스코프(common | 본인 me)로만 동작하므로,
다른 사용자의 파일/노트/일정에는 접근할 수 없다.

모드(mode):
  - ""        비서 화면. 대화는 브라우저가 들고 다니며 history 로 보낸다.
  - "english" 영어 학습 화면. 대화가 서버(chats/english.json)에 남고 history 는 무시한다.
  - "paper"   논문 화면. paper_id 가 필요하고 대화는 그 논문 폴더에 남는다.
              드래그한 영역 이미지(attachments)와 선택한 글(selections)이 함께 온다.
  - "meeting" 회의 화면. meeting_id 가 필요하고 대화는 그 회의 폴더에 남는다.
"""
from __future__ import annotations

import base64
import binascii
import logging
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import chat_store, meeting_store, paper_store, vocab_store
from ..ai import models as ai_models
from ..ai import modes, orchestrator
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

logger = logging.getLogger("server.ai.router")

router = APIRouter(prefix="/api/ai", tags=["ai"])


class ChatTurn(BaseModel):
    role: str  # user | assistant
    text: str


class Attachment(BaseModel):
    """논문 화면에서 드래그한 영역 이미지(data URL 의 base64 부분)."""
    mime: str
    data: str
    label: str = ""


class Selection(BaseModel):
    """논문 화면에서 드래그해 고른 글."""
    text: str
    page: int = 0


#: 한 요청에서 모델로 나가는 양의 상한. 키는 주인 것 하나이므로, 승인된
#: 계정이라도 무제한으로 태울 수 있으면 안 된다(요금과 지연 모두).
MAX_MESSAGE_CHARS = 8000
MAX_HISTORY_TURNS = 20
MAX_HISTORY_CHARS = 24000
#: 영역 이미지: 개수와 한 장 크기(디코딩 후 바이트)
MAX_ATTACHMENTS = 8
MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024
MAX_SELECTIONS = 12
MAX_SELECTION_CHARS = 4000
_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}


class ChatRequest(BaseModel):
    message: str
    history: list[ChatTurn] = []
    mode: str = ""
    paper_id: str = ""
    meeting_id: str = ""
    attachments: list[Attachment] = []
    selections: list[Selection] = []


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


def _space_path(space: str, user: SessionUser, settings: Settings) -> Path:
    """대화 공간 이름 → 파일. 'english' · 'paper:<id>' · 'meeting:<id>'."""
    if space == "english":
        return chat_store.english_path(user, settings)
    if space.startswith("paper:"):
        pid = space[len("paper:"):]
        paper_store.get_paper(user, settings, pid)  # 없으면 404
        return paper_store.chat_path(user, settings, pid)
    if space.startswith("meeting:"):
        mid = space[len("meeting:"):]
        meeting_store.get_meeting(user, settings, mid)  # 없으면 404
        return meeting_store.chat_path(user, settings, mid)
    raise HTTPException(status_code=404, detail="없는 대화 공간입니다.")


@router.get("/space/{space}")
def space_messages(
    space: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """서버에 남은 대화(영어 학습·논문)."""
    return {"messages": chat_store.load(_space_path(space, user, settings))}


@router.delete("/space/{space}")
def space_clear(
    space: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    chat_store.clear(_space_path(space, user, settings))
    return {"ok": True}


@router.delete("/space/{space}/{mid}")
def space_delete_message(
    space: str, mid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    if not chat_store.delete_message(_space_path(space, user, settings), mid):
        raise HTTPException(status_code=404, detail="메시지를 찾을 수 없습니다.")
    return {"ok": True}


def _decode_attachments(items: list[Attachment]) -> list[dict]:
    if len(items) > MAX_ATTACHMENTS:
        raise HTTPException(status_code=400, detail=f"영역 이미지는 {MAX_ATTACHMENTS}개까지입니다.")
    out = []
    for a in items:
        mime = (a.mime or "").split(";")[0].strip().lower()
        if mime not in _IMAGE_MIMES:
            raise HTTPException(status_code=415, detail="영역 이미지는 PNG·JPEG·WebP 만 됩니다.")
        raw = a.data
        if "," in raw[:64] and raw.lstrip().startswith("data:"):
            raw = raw.split(",", 1)[1]
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError) as e:
            raise HTTPException(status_code=400, detail="영역 이미지를 읽을 수 없습니다.") from e
        if not data:
            continue
        if len(data) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(status_code=413, detail="영역 이미지가 너무 큽니다(3MB 이하).")
        out.append({"mime": mime, "data": data, "label": (a.label or "")[:80]})
    return out


def _compose_message(message: str, selections: list[Selection], attachments: list[dict]) -> str:
    """선택한 글·영역 이미지가 있으면 메시지 앞에 인용으로 붙인다.

    모델은 이미지 파트를 직접 보지만, '어느 쪽의 무엇인지'는 글로 알려야 답에
    쪽수를 붙일 수 있다.
    """
    if not selections and not attachments:
        return message
    lines = []
    for s in selections[:MAX_SELECTIONS]:
        txt = (s.text or "").strip()[:MAX_SELECTION_CHARS]
        if not txt:
            continue
        where = f"{s.page}쪽" if s.page else "논문"
        lines.append(f"[{where}에서 선택한 글]\n{txt}")
    for i, a in enumerate(attachments, 1):
        lines.append(f"[첨부 이미지 {i}: {a.get('label') or '드래그한 영역'}]")
    quoted = "\n\n".join(lines)
    return f"{quoted}\n\n[질문]\n{message}" if quoted else message


@router.post("/chat")
def chat(
    body: ChatRequest,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """ReAct 비서. SSE로 thought/tool_call/tool_result/text/done 이벤트 스트리밍."""
    today = date.today().isoformat()

    message = (body.message or "")[:MAX_MESSAGE_CHARS]
    attachments = _decode_attachments(body.attachments) if body.attachments else []
    if not message.strip() and not attachments and not body.selections:
        raise HTTPException(status_code=400, detail="메시지가 비어 있습니다.")
    if not message.strip():
        message = "이 내용을 설명해 주세요."

    mode = (body.mode or "").strip().lower()
    spec = modes.get_mode(mode) if mode else None
    if mode and spec is None:
        raise HTTPException(status_code=400, detail="없는 모드입니다.")

    system = ""
    persist_path: Path | None = None
    paper_id = ""
    meeting_id = ""
    vocab_tags: list[str] = []
    prefs = orchestrator._user_ai_prefs(user, settings)

    if spec and spec.name == "english":
        persist_path = chat_store.english_path(user, settings)
        try:
            board = vocab_store.board(user, settings)
            stats, tags = board["stats"], board["tags"]
        except HTTPException:
            stats, tags = {}, []
        system = modes.english_system(user, prefs["tone"], today, stats, tags)
        # 이 화면에서 넣는 것에는 출처 태그가 하나는 붙어야 한다 — 태그가 없으면
        # 단어장에서 "어디서 온 것인지"로 묶어 볼 수 없다(모델이 tags 를 주면 함께 붙는다).
        vocab_tags = [modes.ENGLISH_TAG]
    elif spec and spec.name == "paper":
        paper_id = (body.paper_id or "").strip()
        paper = paper_store.get_paper(user, settings, paper_id) if paper_id else None
        persist_path = paper_store.chat_path(user, settings, paper_id) if paper_id else None
        others = [paper_store.brief(p) for p in paper_store.list_papers(user, settings)
                  if p.get("id") != paper_id]
        note = ""
        if attachments:
            note = f"\n이번 메시지에는 논문에서 드래그한 영역 이미지 {len(attachments)}장이 붙어 있습니다. 먼저 그 내용을 읽고 답하세요.\n"
        system = modes.paper_system(user, prefs["tone"], today, paper, others, note)
        if paper and paper.get("title"):
            vocab_tags = [str(paper["title"])[:200]]
    elif spec and spec.name == "meeting":
        meeting_id = (body.meeting_id or "").strip()
        meeting = meeting_store.get_meeting(user, settings, meeting_id) if meeting_id else None
        persist_path = meeting_store.chat_path(user, settings, meeting_id) if meeting_id else None
        docs = [d["name"] for d in meeting_store.list_docs(user, settings, meeting_id)] if meeting_id else []
        others = [meeting_store.brief(m) for m in meeting_store.list_meetings(user, settings)
                  if m.get("id") != meeting_id]
        system = modes.meeting_system(user, prefs["tone"], today, meeting, docs, others)
        attachments = []
    else:
        # 논문 화면 밖에서는 이미지가 올 이유가 없다(비서 프롬프트는 이미지를 모른다)
        attachments = []

    # 대화 기록: 모드가 있으면 서버에 남은 것을, 아니면 브라우저가 보낸 것을 쓴다
    if persist_path is not None:
        history = chat_store.history_for_llm(
            chat_store.load(persist_path), max_turns=MAX_HISTORY_TURNS, max_chars=MAX_HISTORY_CHARS,
        )
    else:
        # 최근 것부터 담되 총량도 제한한다. 턴 수만 자르면 장문 몇 개로 뚫린다.
        history = []
        budget = MAX_HISTORY_CHARS
        for t in reversed(body.history[-MAX_HISTORY_TURNS:]):
            text = (t.text or "")[:MAX_MESSAGE_CHARS]
            if budget - len(text) < 0:
                break
            budget -= len(text)
            history.append({"role": t.role, "text": text})
        history.reverse()

    full_message = _compose_message(message, body.selections, attachments)
    user_meta = {
        "selections": [{"text": (s.text or "")[:MAX_SELECTION_CHARS], "page": s.page}
                       for s in body.selections[:MAX_SELECTIONS]],
        "attachments": [{"label": a.get("label", ""), "mime": a["mime"]} for a in attachments],
    }

    def gen():
        final_text = ""
        tool_notes: list[dict] = []
        try:
            for ev in orchestrator.run(
                user, settings, full_message, today, history=history,
                mode=mode, system=system, attachments=attachments,
                paper_id=paper_id, vocab_tags=vocab_tags, meeting_id=meeting_id,
            ):
                if ev.get("type") == "text":
                    final_text = str(ev.get("text") or "")
                elif ev.get("type") == "tool_result":
                    note = {"name": ev.get("name"), "ok": ev.get("ok"),
                            "message": str(ev.get("message") or "")[:300]}
                    # 단어 후보는 다시 열었을 때도 고를 수 있게 함께 남긴다
                    if ev.get("name") == "propose_vocab_words" and isinstance(ev.get("data"), dict):
                        note["data"] = ev["data"]
                    tool_notes.append(note)
                yield orchestrator.sse_format(ev)
        except Exception as e:  # noqa: BLE001
            # 내부 예외 문자열을 사용자에게 그대로 흘리지 않는다(경로·키가 섞일 수 있다).
            logger.exception("AI 스트림 실패")
            detail = str(e) if settings.debug else "처리 중 오류가 발생했습니다."
            yield orchestrator.sse_format({"type": "error", "message": detail})
        finally:
            # 화면을 닫아도(스트림이 끊겨도) 사용자 메시지와 받은 데까지는 남긴다
            if persist_path is not None:
                try:
                    msgs = [chat_store.message("user", message, user_meta)]
                    if final_text.strip():
                        msgs.append(chat_store.message("assistant", final_text, {"tools": tool_notes}))
                    chat_store.append(persist_path, *msgs)
                except Exception:  # noqa: BLE001
                    logger.exception("대화 저장 실패")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
