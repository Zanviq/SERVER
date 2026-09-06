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
Keep every value concise. Use Korean for summary/key_findings/methods/limitations, keep title/authors/abstract/keywords in the paper's language.

If the document is blank or you cannot read it, return every value EMPTY ("" or []).
Do NOT write an explanation into "title" or "summary" — those fields are shown to the
user as the paper's own title and summary. An empty value is correct; a sentence like
"Unable to extract title" is not."""


#: 파이썬 str 에는 담기지만 UTF-8 로는 **인코딩할 수 없는** 글자들(짝 없는 서로게이트).
#: 글꼴 매핑이 깨진 PDF 에서 pypdf 가 이런 값을 그대로 내놓는다.
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _encodable(text: str) -> str:
    """UTF-8 로 내보낼 수 있는 글자만 남긴다.

    실제로 있었던 일: 어떤 논문의 본문에 짝 없는 서로게이트가 섞여 들어와
    `text.txt` 를 쓰는 순간 UnicodeEncodeError 가 났다. 그 자리의 except 는
    OSError 만 잡고 있어서 **추출 스레드가 통째로 죽었고**, 상태를 바꿀 기회도
    없어 화면에는 영영 "추출 중"만 남았다(text.txt 는 0바이트로 남았다).

    깨진 글자는 우리가 살릴 방법이 없다. 그러나 그 몇 글자 때문에 논문 하나가
    통째로 못 쓰게 되는 것은 막을 수 있다 — 지우고 나머지를 쓴다.
    """
    if not text:
        return ""
    cleaned = _LONE_SURROGATE.sub("", text)
    # 서로게이트 말고도 인코딩이 안 되는 것이 남아 있을 수 있다. 한 번 왕복시켜
    # **여기서** 확실히 걸러 둔다 — 이 값은 파일·모델 요청·검색으로 모두 흘러간다.
    return cleaned.encode("utf-8", "ignore").decode("utf-8", "ignore")


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
            t = _encodable(t).strip()
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


#: "못 읽었다"는 설명이 제목·요약 자리에 들어왔을 때 알아보는 말들.
#: 빈 PDF 를 네 번 올려 보니 한 번은 제목에 "Unable to extract title", 요약에
#: "문서 내용이 제공되지 않아 …"가 들어왔다. 목록에는 그게 논문 제목처럼 보인다.
#: **둘 다** 있어야 설명으로 본다 — 못 하겠다는 말과, 그 대상이 문서·제목이라는 말.
#: 한쪽만 보면 "Cannot Stop the Music" 같은 **진짜 제목을 지운다.** 놓치는 쪽이
#: 지우는 쪽보다 낫다(놓치면 보기 흉할 뿐이고, 지우면 정보가 사라진다).
_REFUSAL_VERB = re.compile(
    r"unable to|cannot be|can not be|could not be|not provided|not available|no content"
    r"|is missing|is empty|없어서|없으므로|제공되지 않|읽을 수 없|추출할 수 없|생성할 수 없",
    re.I,
)
_REFUSAL_SUBJECT = re.compile(
    r"document|content|title|abstract|paper|text|file|문서|내용|제목|초록|본문|파일",
    re.I,
)


def _drop_refusals(info: dict) -> dict:
    """모델이 필드에 적어 넣은 '못 읽었다'는 설명을 지운다.

    빈 값이 정답인 자리다 — 비워 두면 제목은 파일 이름으로 되돌아가고 요약은
    안 보인다. 설명을 남기면 사용자는 그 문장을 논문 제목으로 읽게 된다.
    """
    out = dict(info)
    for k in ("title", "summary", "abstract", "methods", "limitations"):
        v = out.get(k)
        if not (isinstance(v, str) and v.strip()):
            continue
        if _REFUSAL_VERB.search(v) and _REFUSAL_SUBJECT.search(v):
            logger.info("추출 결과에서 설명 문장을 지웠다: %s=%r", k, v[:80])
            out[k] = ""
    return out


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
    # 뽑는 쪽에서도 거르지만 **쓰는 쪽에서 한 번 더** 거른다. 여기서부터 본문은
    # 파일로도 나가고 모델 요청으로도 나가는데, 둘 다 UTF-8 로 인코딩된다.
    # 거르는 자리가 생산자 한 곳뿐이면, 다른 경로로 들어온 본문 하나가 같은
    # 자리를 다시 깨뜨린다(시험에서 실제로 그렇게 됐다).
    text = _encodable(text)
    try:
        paper_store.text_path(user, settings, pid).write_text(text, encoding="utf-8")
    except Exception:  # noqa: BLE001
        # **여기서 나는 오류로 추출을 끝내면 안 된다.** 본문 파일은 나중에 다시
        # 읽기 위한 사본일 뿐이고, 진짜 결과(제목·요약)는 아래에서 만든다.
        # OSError 만 잡고 있던 탓에 UnicodeEncodeError 하나가 스레드를 죽여
        # 상태가 영영 '추출 중'에 멈춰 있었다(실측: 신규 사용자의 논문 한 편).
        logger.exception("본문 저장 실패(추출은 계속한다): %s", pid)
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

    info = _drop_refusals(info)
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
