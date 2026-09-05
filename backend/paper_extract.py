"""논문 정보 추출 — 업로드 직후 백그라운드에서 한 번.

1) pypdf 로 쪽수와 본문을 뽑아 text.txt 에 둔다(스킬이 본문을 읽는 데 쓴다).
2) Gemini 에 PDF(작으면 원본, 크면 본문 앞부분)를 주고 제목·저자·연도·초록·
   요약·핵심 발견·방법·한계·키워드·섹션을 JSON 으로 받는다.
3) 결과를 index.json 의 메타에 적고 status 를 ready/failed 로 바꾼다.

같은 논문을 두 번 돌리지 않도록 진행 중인 (사용자, id) 를 기억한다. 서버가
재시작되면 pending 인 채 남은 것은 목록 조회 때 다시 큐에 넣는다(routers.papers).
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path

from . import paper_store
from .auth import SessionUser
from .config import Settings

logger = logging.getLogger("server.papers")

#: Gemini 에 PDF 원본을 그대로 넣는 상한(그보다 크면 본문 텍스트로 대신한다)
INLINE_PDF_MAX = 18 * 1024 * 1024
#: 본문 텍스트로 대신할 때 보내는 글자 수
TEXT_FALLBACK_CHARS = 60000
#: text.txt 에 남기는 본문 상한
TEXT_STORE_CHARS = 400000

_running: set[tuple[str, str]] = set()
_running_guard = threading.Lock()

_PROMPT = """You are cataloguing an academic paper for a personal reading workspace.
Read the paper and answer with a single JSON object (no prose, no code fence) with these keys:
{
  "title": "exact paper title",
  "authors": ["First Author", "..."],
  "year": "2024",
  "venue": "conference or journal, or empty string",
  "abstract": "the paper's abstract verbatim (or close)",
  "summary": "한국어로 4~6문장. 무엇을 왜 했고 무엇을 얻었는지",
  "key_findings": ["한국어로 핵심 발견·기여 3~6개, 한 줄씩"],
  "methods": "한국어로 방법·실험 설계 2~4문장",
  "limitations": "한국어로 한계·후속 연구 1~3문장 (없으면 빈 문자열)",
  "keywords": ["5~10개 영어 키워드"],
  "sections": ["1 Introduction", "2 Related Work", "..."]
}
Keep every value concise. Use Korean for summary/key_findings/methods/limitations, keep title/authors/abstract/keywords in the paper's language."""


def extract_text(pdf: Path) -> tuple[int, str]:
    """pypdf 로 (쪽수, 본문). 실패하면 (0, '')."""
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover
        logger.warning("pypdf 가 없어 본문을 뽑지 못한다")
        return 0, ""
    try:
        reader = PdfReader(str(pdf))
        pages = len(reader.pages)
        chunks: list[str] = []
        total = 0
        for i, page in enumerate(reader.pages):
            try:
                t = page.extract_text() or ""
            except Exception:  # noqa: BLE001
                t = ""
            t = t.strip()
            if t:
                chunks.append(f"\n\n[[page {i + 1}]]\n{t}")
                total += len(t)
            if total > TEXT_STORE_CHARS:
                break
        return pages, "".join(chunks)[:TEXT_STORE_CHARS]
    except Exception:  # noqa: BLE001
        logger.exception("PDF 본문 추출 실패: %s", pdf)
        return 0, ""


def _parse_json(text: str) -> dict:
    """모델 응답에서 JSON 객체를 꺼낸다(코드 펜스·앞뒤 말 허용)."""
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


def _ask_gemini(settings: Settings, pdf: Path, text: str, model: str = "") -> dict:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=settings.gemini_api_key)
    parts: list = []
    size = pdf.stat().st_size if pdf.exists() else 0
    if 0 < size <= INLINE_PDF_MAX:
        parts.append(types.Part.from_bytes(data=pdf.read_bytes(), mime_type="application/pdf"))
    else:
        parts.append(types.Part.from_text(text=text[:TEXT_FALLBACK_CHARS] or "(no text)"))
    parts.append(types.Part.from_text(text=_PROMPT))
    resp = client.models.generate_content(
        model=model or settings.gemini_model,
        contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(response_mime_type="application/json"),
    )
    return _parse_json(getattr(resp, "text", "") or "")


def _title_guess(text: str, fallback: str) -> str:
    """모델을 못 쓸 때 첫 줄에서 제목을 짐작한다."""
    for line in (text or "").splitlines():
        s = line.strip()
        if s.startswith("[[page"):
            continue
        if 8 <= len(s) <= 200 and not s.lower().startswith(("abstract", "arxiv")):
            return s
    return fallback


def run_sync(user: SessionUser, settings: Settings, pid: str, *, asker=None) -> dict:
    """추출을 지금 이 스레드에서 한다. asker 는 테스트용 대체(가짜 모델)."""
    pdf = paper_store.pdf_path(user, settings, pid)
    if not pdf.exists():
        return paper_store.update_meta(user, settings, pid, {
            "status": paper_store.STATUS_FAILED, "error": "PDF 파일이 없습니다.",
        })
    pages, text = extract_text(pdf)
    try:
        paper_store.text_path(user, settings, pid).write_text(text, encoding="utf-8")
    except OSError:
        logger.exception("본문 저장 실패: %s", pid)
    meta = paper_store.find_paper(user, settings, pid) or {}
    patch: dict = {"pages": pages}

    ask = asker or (_ask_gemini if settings.gemini_api_key else None)
    if ask is None:
        patch.update({
            "status": paper_store.STATUS_FAILED,
            "error": "GEMINI_API_KEY 가 없어 논문 정보를 뽑지 못했습니다.",
            "title": _title_guess(text, str(meta.get("title") or "")),
        })
        return paper_store.update_meta(user, settings, pid, patch)

    try:
        info = ask(settings, pdf, text) if asker else _ask_gemini(settings, pdf, text, _model_of(user, settings))
    except Exception as e:  # noqa: BLE001
        logger.exception("논문 정보 추출 실패: %s", pid)
        patch.update({
            "status": paper_store.STATUS_FAILED,
            "error": (str(e) if settings.debug else "AI 호출에 실패했습니다.")[:300],
            "title": _title_guess(text, str(meta.get("title") or "")),
        })
        return paper_store.update_meta(user, settings, pid, patch)

    if not isinstance(info, dict) or not info:
        patch.update({
            "status": paper_store.STATUS_FAILED,
            "error": "AI 응답을 해석하지 못했습니다.",
            "title": _title_guess(text, str(meta.get("title") or "")),
        })
        return paper_store.update_meta(user, settings, pid, patch)

    for k in ("title", "authors", "year", "venue", "abstract", "summary", "key_findings",
              "methods", "limitations", "keywords", "sections"):
        if k in info and info[k] not in (None, ""):
            patch[k] = info[k]
    if not patch.get("title"):
        patch["title"] = _title_guess(text, str(meta.get("title") or ""))
    patch.update({"status": paper_store.STATUS_READY, "error": "", "extracted_at": time.time()})
    return paper_store.update_meta(user, settings, pid, patch)


def _model_of(user: SessionUser, settings: Settings) -> str:
    """비서 설정에서 고른 모델을 따른다(없으면 서버 기본)."""
    try:
        from . import user_settings

        return str(user_settings.load(user, settings).get("ai", {}).get("model") or "")
    except Exception:  # noqa: BLE001
        return ""


def start(user: SessionUser, settings: Settings, pid: str) -> bool:
    """백그라운드 추출을 시작한다. 이미 돌고 있으면 False."""
    key = (user.username, pid)
    with _running_guard:
        if key in _running:
            return False
        _running.add(key)

    def worker():
        try:
            run_sync(user, settings, pid)
        except Exception:  # noqa: BLE001
            logger.exception("논문 추출 스레드 실패: %s", pid)
            try:
                paper_store.update_meta(user, settings, pid, {
                    "status": paper_store.STATUS_FAILED, "error": "추출 중 오류가 났습니다.",
                })
            except Exception:  # noqa: BLE001
                pass
        finally:
            with _running_guard:
                _running.discard(key)

    threading.Thread(target=worker, name=f"paper-extract-{pid[:8]}", daemon=True).start()
    return True


def is_running(user: SessionUser, pid: str) -> bool:
    with _running_guard:
        return (user.username, pid) in _running
