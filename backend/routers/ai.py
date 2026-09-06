"""AI 라우터: ReAct 비서 채팅(SSE 스트리밍).

스킬은 모두 세션 사용자 스코프(common | 본인 me)로만 동작하므로,
다른 사용자의 파일/노트/일정에는 접근할 수 없다.

모드(mode). 모드가 있으면 대화는 **서버에 남고** 브라우저가 보낸 history 는 무시한다.
모델에 들어가는 것은 그중 최근 하루치이고(context_store.RECENT_WINDOW_SEC), 그보다
옛날은 모델이 컨텍스트 스킬로 직접 꺼낸다.

  - ""          하위호환. 대화를 남기지 않고 브라우저의 history 를 그대로 쓴다.
  - "assistant" 비서 화면 (chats/assistant.json)
  - "calendar"  캘린더 오른쪽 패널 (chats/calendar.json)
  - "english" 영어 학습 화면. 대화가 서버(chats/english.json)에 남고 history 는 무시한다.
  - "paper"   논문 화면. paper_id 가 필요하고 대화는 그 논문 폴더에 남는다.
              드래그한 영역 이미지(attachments)와 선택한 글(selections)이 함께 온다.
  - "meeting" 회의 화면. meeting_id 가 필요하고 대화는 그 회의 폴더에 남는다.
"""
from __future__ import annotations

import base64
import binascii
import logging
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import chat_store, context_store, meeting_store, paper_store, vocab_store
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
#: 자르는 일은 **글자 수**가 맡는다. 턴 수는 안전망일 뿐이다.
#: 20 이던 때, 짧은 말 34개를 주고받은 대화가 글자 예산의 1%(251/24000자)만 쓰고도
#: 잘렸다. 밀려난 사실을 물으면 모델은 꺼내 보지 않고 지어냈다("좋아하는 음식"에
#: 말한 적 없는 '피자'). 짧은 말이 오가는 대화일수록 턴 수로 자르면 손해가 크다.
MAX_HISTORY_TURNS = 80
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
    """대화 공간 이름 → 파일. 공간 목록은 context_store 가 한 곳에서 정한다."""
    return context_store.space_path(user, settings, space)


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
        full = (s.text or "").strip()
        txt = full[:MAX_SELECTION_CHARS]
        if not txt:
            continue
        where = f"{s.page}쪽" if s.page else "논문"
        # 조용히 자르면 모델은 앞부분만 보고 "이 대목에는 그런 말이 없다"고 답한다.
        cut = (f"\n[…이 선택은 {MAX_SELECTION_CHARS}자에서 잘렸습니다. "
               f"뒤에 {len(full) - MAX_SELECTION_CHARS}자가 더 있습니다 — "
               "필요하면 나눠서 선택해 달라고 말하세요.]") if len(full) > MAX_SELECTION_CHARS else ""
        lines.append(f"[{where}에서 선택한 글]\n{txt}{cut}")
    if len(selections) > MAX_SELECTIONS:
        lines.append(f"[안내] 선택한 글이 {len(selections)}개인데 앞 {MAX_SELECTIONS}개만 실었습니다.")
    for i, a in enumerate(attachments, 1):
        lines.append(f"[첨부 이미지 {i}: {a.get('label') or '드래그한 영역'}]")
    quoted = "\n\n".join(lines)
    return f"{quoted}\n\n[질문]\n{message}" if quoted else message


def _stopped_note(streamed: str, tool_notes: list[dict]) -> str:
    """중단된 차례를 기록에 남길 문장. 남길 것이 없으면 빈 문자열.

    조각만 남기면 안 된다. 스킬이 이미 돌아간 뒤에 끊겼는데 기록에 답이 없으면,
    다음 차례에 모델은 **아직 안 한 일로 보고 그대로 다시 한다** — 할 일이 두 벌
    생긴다. 무엇을 이미 끝냈는지 함께 적어 둔다.
    """
    done: list[str] = []
    for n in tool_notes:
        if not n.get("ok"):
            continue
        name = str(n.get("name") or "")
        if name:
            done.append(name)
    if not streamed and not done:
        return ""
    counted = []
    for name in dict.fromkeys(done):          # 순서는 지키고 중복만 묶는다
        c = done.count(name)
        counted.append(f"{name}×{c}" if c > 1 else name)
    note = "_(여기서 멈췄습니다."
    if counted:
        note += f" 이 차례에 이미 끝낸 일: {', '.join(counted)} — 다시 하지 마세요."
    note += ")_"
    return f"{streamed}\n\n{note}" if streamed else note


@dataclass
class Prepared:
    """한 번의 요청에서 **모델에 실제로 가는 것들**.

    예전에는 이 조립이 chat() 안에만 있었다. 그래서 "컨텍스트에 무엇이 들어가는지"
    보여주는 화면을 만들려면 같은 코드를 한 벌 더 써야 했고, 한 벌 더 쓴 미리보기는
    반드시 어긋나 **거짓말을 한다**. 조립은 여기 한 곳뿐이다.
    """

    today: str
    mode: str
    message: str
    full_message: str
    system: str
    history: list[dict]
    history_note: str
    attachments: list[dict]
    paper_id: str
    meeting_id: str
    vocab_tags: list[str]
    persist_path: Path | None
    user_meta: dict


def _prepare(body: "ChatRequest", user: SessionUser, settings: Settings) -> Prepared:
    """요청 → 모델에 보낼 재료. /chat 과 /preview 가 같은 것을 쓴다."""
    today = date.today().isoformat()

    raw_message = body.message or ""
    message = raw_message[:MAX_MESSAGE_CHARS]
    if len(raw_message) > MAX_MESSAGE_CHARS:
        # 조용히 자르면 모델은 잘린 앞부분만 보고 답하고, 사용자는 뒤에 적은
        # 것(대개 진짜 질문이 거기 있다)이 왜 무시됐는지 모른다.
        message += (
            f"\n\n[안내] 이 메시지는 {MAX_MESSAGE_CHARS}자에서 잘렸습니다. "
            f"뒤에 {len(raw_message) - MAX_MESSAGE_CHARS}자가 더 있었습니다 — "
            "잘린 뒤의 내용은 보이지 않으니, 필요하면 나눠서 다시 보내 달라고 말하세요."
        )
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

    if spec and spec.name in ("assistant", "calendar"):
        # 시스템 프롬프트는 기본(build_system) 그대로 두고 대화만 남긴다.
        persist_path = context_store.space_path(user, settings, spec.name)
    elif spec and spec.name == "english":
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
    history_note = ""
    if persist_path is not None:
        # 기본은 '최근 하루'. 그보다 옛날 이야기는 모델이 컨텍스트 스킬로 직접 꺼낸다
        # (전부 넣으면 요금·지연이 늘고 관계없는 옛 대화가 답을 흐린다).
        stored = chat_store.load(persist_path)
        history = context_store.recent_for_llm(
            stored,
            window_sec=context_store.RECENT_WINDOW_SEC,
            max_turns=MAX_HISTORY_TURNS, max_chars=MAX_HISTORY_CHARS,
        )
        # 잘렸으면 그 사실과 꺼내는 법을 알려 준다 — 모르면 보이는 앞부분을
        # "대화의 시작"으로 단정한다.
        space_name = spec.name if spec.name in context_store.FIXED_SPACES else (
            f"paper:{paper_id}" if paper_id else f"meeting:{meeting_id}" if meeting_id else "")
        if space_name:
            history_note = context_store.truncation_note(
                len([m for m in stored if str(m.get("text") or "").strip()]),
                len(history), space_name,
                context_store.space_label(user, settings, space_name),
            )
            # 시스템 프롬프트 끝에만 두면 모델이 "위 대화에 있으면 그대로 답하라"는
            # 앞선 규칙을 따라 잘린 앞부분을 대화의 시작으로 단정한다(실측).
            # 대화 맨 앞에도 같은 표식을 세워, 모델이 '시작'을 찾는 그 자리에서 보게 한다.
            if history_note and history:
                history = [{"role": "user", "text": history_note}] + history
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

    return Prepared(
        today=today, mode=mode, message=message, full_message=full_message,
        system=system, history=history, history_note=history_note,
        attachments=attachments, paper_id=paper_id, meeting_id=meeting_id,
        vocab_tags=vocab_tags, persist_path=persist_path, user_meta=user_meta,
    )


@router.post("/preview")
def preview(
    body: ChatRequest,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """**이 요청을 보내면 모델이 실제로 무엇을 받는가.** 모델은 부르지 않는다.

    컨텍스트 화면이 쓴다. 대화 기록만 보여 주면 "왜 저렇게 답했지"의 절반만
    보인다 — 답을 좌우하는 것은 시스템 프롬프트(화면마다 다르다), 잘림 안내,
    이 화면에서 쓸 수 있는 스킬 목록이다. 그 전부를 원문 그대로 낸다.
    """
    p = _prepare(body, user, settings)
    spec = modes.get_mode(p.mode) if p.mode else None
    catalog = orchestrator.default_registry().build_catalog()
    skills = [s["name"] for s in catalog if spec is None or spec.allows(s["name"])]
    system = orchestrator.effective_system(user, settings, p.today, p.system, p.history_note)
    turns = [{"role": t["role"], "text": t["text"], "chars": len(t["text"])} for t in p.history]
    return {
        "today": p.today,
        "mode": p.mode or "assistant",
        "system": system,
        "history": turns,
        "message": p.full_message,
        "attachments": [{"label": a.get("label", ""), "mime": a.get("mime", ""),
                         "bytes": len(a.get("data") or b"")} for a in p.attachments],
        "skills": skills,
        "totals": {
            "system_chars": len(system),
            "history_turns": len(turns),
            "history_chars": sum(t["chars"] for t in turns),
            "message_chars": len(p.full_message),
            "skills": len(skills),
            # 대략의 눈금이다. 정확한 토큰 수는 모델만 안다 — 그렇다고 아무 수치도
            # 안 주면 "왜 느리지·왜 비싸지"를 가늠할 방법이 없다.
            "chars_total": len(system) + sum(t["chars"] for t in turns) + len(p.full_message),
        },
    }


@router.post("/chat")
def chat(
    body: ChatRequest,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """ReAct 비서. SSE로 thought/tool_call/tool_result/text/done 이벤트 스트리밍."""
    p = _prepare(body, user, settings)
    message, full_message = p.message, p.full_message
    persist_path, user_meta = p.persist_path, p.user_meta

    def gen():
        final_text = ""
        streamed = ""     # 흘려보낸 조각들 — 중간에 멈췄을 때 화면과 기록을 맞춘다
        errored = False
        tool_notes: list[dict] = []
        try:
            for ev in orchestrator.run(
                user, settings, p.full_message, p.today, history=p.history,
                mode=p.mode, system=p.system, attachments=p.attachments,
                paper_id=p.paper_id, vocab_tags=p.vocab_tags, meeting_id=p.meeting_id,
                history_note=p.history_note,
            ):
                if ev.get("type") == "text":
                    final_text = str(ev.get("text") or "")
                elif ev.get("type") == "text_delta":
                    streamed += str(ev.get("text") or "")
                elif ev.get("type") == "tool_call":
                    streamed = ""   # 도구를 쓰면 모델이 답을 처음부터 다시 쓴다
                elif ev.get("type") == "error":
                    errored = True
                elif ev.get("type") == "tool_result":
                    # 인자·결과까지 남긴다 — 나중에 "AI 가 뭘 했지"를 되짚으려면
                    # 이름과 한 줄 요약만으로는 알 수 없다(컨텍스트 화면이 이걸 보여준다).
                    note = {"name": ev.get("name"), "ok": ev.get("ok"),
                            "message": str(ev.get("message") or "")[:300],
                            "args": str(ev.get("args") or ""),
                            "result": str(ev.get("result") or "")}
                    # 단어 후보는 다시 열었을 때도 고를 수 있게 함께 남긴다.
                    # 스킬 이름이 아니라 **후보가 들어 있는지**로 본다 —
                    # add_vocab_words 도 허락 없이 불리면 후보로 돌려준다.
                    data = ev.get("data")
                    if isinstance(data, dict) and isinstance(data.get("proposal"), list):
                        note["data"] = data
                    tool_notes.append(note)
                yield orchestrator.sse_format(ev)
        except Exception as e:  # noqa: BLE001
            # 내부 예외 문자열을 사용자에게 그대로 흘리지 않는다(경로·키가 섞일 수 있다).
            logger.exception("AI 스트림 실패")
            detail = str(e) if settings.debug else "처리 중 오류가 발생했습니다."
            yield orchestrator.sse_format({"type": "error", "message": detail})
        finally:
            # 화면을 닫아도(스트림이 끊겨도) 사용자 메시지와 받은 데까지는 남긴다.
            # 중단 버튼을 눌렀거나 화면을 닫았으면 최종본은 없고 흘려보낸 조각만
            # 있다 — 사용자가 읽은 그대로를 남기되, 잘렸다는 표시를 붙인다.
            # 다만 오류로 끊긴 것은 남기지 않는다(반쪽 답을 다음 차례가 흉내 낸다).
            body = final_text.strip()
            if not body and not errored:
                body = _stopped_note(streamed.strip(), tool_notes)
            if persist_path is not None:
                try:
                    msgs = [chat_store.message("user", message, user_meta)]
                    if body:
                        msgs.append(chat_store.message("assistant", body, {"tools": tool_notes}))
                    chat_store.append(persist_path, *msgs)
                except Exception:  # noqa: BLE001
                    logger.exception("대화 저장 실패")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
