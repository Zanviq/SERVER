"""회의 녹음 받아쓰기 — 업로드 직후 백그라운드에서 한 번.

Gemini 에 녹음을 그대로 듣게 하고(작으면 인라인, 크면 Files API 로 올린 뒤)
발화자 라벨·시각·문장을 JSON 으로 받는다. 화자 구분은 모델이 목소리로 짐작한
것이라 "화자 1/화자 2" 라벨이고, 이름은 사용자가 화면에서 붙인다(meta.speakers).

결과는 transcript.json 에 두고 status 를 ready/failed 로 바꾼다. 같은 회의를 두 번
돌리지 않도록 진행 중인 (사용자, id) 를 기억한다(paper_extract 와 같은 구조).
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path

from . import meeting_store
from .auth import SessionUser
from .config import Settings

logger = logging.getLogger("server.meetings")

#: 요청 본문에 그대로 넣는 상한. 그보다 크면 Files API 로 올린다(최대 2GB, 48시간 보관).
INLINE_AUDIO_MAX = 18 * 1024 * 1024
#: Files API 처리 대기 상한(초)
FILE_WAIT_SECS = 180

_running: set[tuple[str, str]] = set()
_running_guard = threading.Lock()

_PROMPT = """You are transcribing a meeting recording for the participant's personal workspace.
Listen to the whole audio and answer with a single JSON object (no prose, no code fence):
{
  "language": "ko",
  "summary": "한국어로 3~5문장. 무엇을 논의했고 무엇이 결정됐는지",
  "segments": [
    {"start": "00:00", "end": "00:12", "speaker": "화자 1", "text": "..."},
    {"start": "00:12", "end": "00:31", "speaker": "화자 2", "text": "..."}
  ]
}
Rules:
- Transcribe verbatim in the spoken language (do not translate). Fix obvious filler words only.
- Split into segments whenever the speaker changes or roughly every 20~40 seconds.
- Distinguish speakers by voice; label them "화자 1", "화자 2", ... consistently across the whole recording.
  If you genuinely cannot tell speakers apart, use "화자 1" for everything.
- Timestamps are mm:ss (or h:mm:ss beyond an hour) from the start of the recording.
- Keep the whole transcript; do not skip parts."""


def _parse_json(text: str) -> dict:
    s = (text or "").strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s, flags=re.I)
    try:
        obj = json.loads(s)
        return obj if isinstance(obj, dict) else {}
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", s, flags=re.S)
    if m:
        try:
            obj = json.loads(m.group(0))
            return obj if isinstance(obj, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _ask_gemini(settings: Settings, audio: Path, mime: str, model: str = "") -> dict:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=settings.gemini_api_key)
    size = audio.stat().st_size
    uploaded = None
    try:
        if size <= INLINE_AUDIO_MAX:
            media = types.Part.from_bytes(data=audio.read_bytes(), mime_type=mime)
        else:
            uploaded = client.files.upload(file=str(audio), config={"mime_type": mime})
            deadline = time.time() + FILE_WAIT_SECS
            while getattr(getattr(uploaded, "state", None), "name", "") == "PROCESSING" and time.time() < deadline:
                time.sleep(2)
                uploaded = client.files.get(name=uploaded.name)
            if getattr(getattr(uploaded, "state", None), "name", "") == "FAILED":
                raise RuntimeError("파일 처리에 실패했습니다.")
            media = types.Part.from_uri(file_uri=uploaded.uri, mime_type=uploaded.mime_type or mime)
        resp = client.models.generate_content(
            model=model or settings.gemini_model,
            contents=[types.Content(role="user", parts=[media, types.Part.from_text(text=_PROMPT)])],
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        return _parse_json(getattr(resp, "text", "") or "")
    finally:
        if uploaded is not None:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:  # noqa: BLE001
                pass


def _stamp(v) -> str:
    """mm:ss / h:mm:ss 만 남긴다(모델이 초 단위 숫자를 주면 바꿔 준다)."""
    if isinstance(v, (int, float)):
        total = max(0, int(v))
        h, rem = divmod(total, 3600)
        m, s = divmod(rem, 60)
        return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"
    s = str(v or "").strip()
    return s if re.fullmatch(r"\d{1,2}(:\d{2}){1,2}", s) else ""


def _clean_segments(raw) -> list[dict]:
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for s in raw:
        if not isinstance(s, dict):
            continue
        text = str(s.get("text") or "").strip()
        if not text:
            continue
        out.append({
            "start": _stamp(s.get("start")),
            "end": _stamp(s.get("end")),
            "speaker": str(s.get("speaker") or "").strip()[:60],
            "text": text[:4000],
        })
        if len(out) >= 5000:
            break
    return out


def run_sync(user: SessionUser, settings: Settings, mid: str, *, asker=None) -> dict:
    """받아쓰기를 지금 이 스레드에서 한다. asker 는 테스트용 대체(가짜 모델)."""
    meta = meeting_store.find_meeting(user, settings, mid)
    if meta is None:
        raise ValueError("회의가 없습니다")
    ext = str(meta.get("ext") or "")
    audio = meeting_store.audio_path(user, settings, mid, ext) if ext else None
    if audio is None or not audio.exists():
        return meeting_store.update_meta(user, settings, mid, {
            "status": meeting_store.STATUS_FAILED, "error": "녹음 파일이 없습니다.",
        })
    mime = str(meta.get("mime") or meeting_store.AUDIO_TYPES.get(ext, "audio/webm")).split(";")[0]

    ask = asker or (_ask_gemini if settings.gemini_api_key else None)
    if ask is None:
        return meeting_store.update_meta(user, settings, mid, {
            "status": meeting_store.STATUS_FAILED,
            "error": "GEMINI_API_KEY 가 없어 받아쓰기를 하지 못했습니다.",
        })
    try:
        info = ask(settings, audio, mime) if asker else _ask_gemini(settings, audio, mime, _model_of(user, settings))
    except Exception as e:  # noqa: BLE001
        logger.exception("회의 받아쓰기 실패: %s", mid)
        return meeting_store.update_meta(user, settings, mid, {
            "status": meeting_store.STATUS_FAILED,
            "error": (str(e) if settings.debug else "AI 호출에 실패했습니다.")[:300],
        })
    segments = _clean_segments((info or {}).get("segments"))
    if not segments:
        return meeting_store.update_meta(user, settings, mid, {
            "status": meeting_store.STATUS_FAILED, "error": "AI 응답을 해석하지 못했습니다.",
        })
    text = "\n".join(f"{s['speaker']}: {s['text']}" if s["speaker"] else s["text"] for s in segments)
    meeting_store.write_transcript(user, settings, mid, segments, text)
    return meeting_store.update_meta(user, settings, mid, {
        "status": meeting_store.STATUS_READY, "error": "", "transcribed_at": time.time(),
        "summary": str(info.get("summary") or ""), "segments": len(segments),
    })


def _model_of(user: SessionUser, settings: Settings) -> str:
    try:
        from . import user_settings

        return str(user_settings.load(user, settings).get("ai", {}).get("model") or "")
    except Exception:  # noqa: BLE001
        return ""


def start(user: SessionUser, settings: Settings, mid: str) -> bool:
    """백그라운드 받아쓰기를 시작한다. 이미 돌고 있으면 False."""
    key = (user.username, mid)
    with _running_guard:
        if key in _running:
            return False
        _running.add(key)

    def worker():
        try:
            run_sync(user, settings, mid)
        except Exception:  # noqa: BLE001
            logger.exception("회의 받아쓰기 스레드 실패: %s", mid)
            try:
                meeting_store.update_meta(user, settings, mid, {
                    "status": meeting_store.STATUS_FAILED, "error": "받아쓰기 중 오류가 났습니다.",
                })
            except Exception:  # noqa: BLE001
                pass
        finally:
            with _running_guard:
                _running.discard(key)

    threading.Thread(target=worker, name=f"meeting-transcribe-{mid[:8]}", daemon=True).start()
    return True


def is_running(user: SessionUser, mid: str) -> bool:
    with _running_guard:
        return (user.username, mid) in _running
