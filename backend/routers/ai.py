"""AI 기능 API (Gemini): 문서 요약·자연어 검색·파일 기반 Q&A.

민감 문서 외부 전송 방지를 위해 파일명/경로에 sensitive 키워드가
있으면 요약/Q&A를 차단하는 간단한 가드를 둔다.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config import get_settings
from ..gemini_client import TEXT_EXTENSIONS, generate
from ..security_paths import safe_join, to_rel

router = APIRouter(prefix="/api/ai", tags=["ai"])

# 외부(Gemini) 전송을 막을 민감 키워드 — 파일명/경로 기준.
SENSITIVE_KEYWORDS = {
    "비밀", "민감", "주민등록", "계좌", "secret", "private",
    "password", "비밀번호", "ssn", "card", "여권",
}

MAX_CHARS = 30_000  # 한 파일에서 AI로 보낼 최대 글자수


class PathRequest(BaseModel):
    path: str


class SearchRequest(BaseModel):
    query: str = Field(description="자연어 검색어")


class ChatRequest(BaseModel):
    path: str
    question: str


class TextResponse(BaseModel):
    result: str


class SearchHit(BaseModel):
    path: str
    reason: str


class SearchResponse(BaseModel):
    query: str
    hits: list[SearchHit]


def _guard_sensitive(rel_path: str) -> None:
    low = rel_path.lower()
    for kw in SENSITIVE_KEYWORDS:
        if kw.lower() in low:
            raise HTTPException(
                status_code=403,
                detail=f"민감 문서로 판단되어 외부 AI 전송이 차단되었습니다 ('{kw}').",
            )


def _read_text(path: str) -> tuple[Path, str]:
    """텍스트 파일을 읽어 (절대경로, 내용) 반환. 가드/검증 포함."""
    settings = get_settings()
    target = safe_join(settings.storage_root, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    if target.suffix.lower() not in TEXT_EXTENSIONS:
        raise HTTPException(status_code=415, detail="텍스트 파일만 지원합니다.")

    _guard_sensitive(to_rel(settings.storage_root, target))
    text = target.read_text(encoding="utf-8", errors="replace")
    return target, text[:MAX_CHARS]


@router.post("/summarize", response_model=TextResponse)
def summarize(req: PathRequest):
    """문서 요약 (한국어 불릿 + 자동 태그)."""
    _, text = _read_text(req.path)
    prompt = (
        "다음 문서를 한국어로 요약하라. 형식:\n"
        "1) 3~5개 핵심 불릿\n2) '태그:' 줄에 키워드 3~6개\n\n"
        f"=== 문서 ===\n{text}"
    )
    return TextResponse(result=generate(prompt))


@router.post("/chat", response_model=TextResponse)
def chat(req: ChatRequest):
    """파일 내용 기반 Q&A."""
    _, text = _read_text(req.path)
    prompt = (
        "아래 문서 내용만 근거로 질문에 한국어로 답하라. "
        "문서에 없으면 '문서에서 찾을 수 없음'이라고 답하라.\n\n"
        f"=== 문서 ===\n{text}\n\n=== 질문 ===\n{req.question}"
    )
    return TextResponse(result=generate(prompt))


@router.post("/search", response_model=SearchResponse)
def search(req: SearchRequest):
    """자연어 파일 검색. 파일 트리(이름/경로)를 Gemini에 주고 매칭."""
    import json

    settings = get_settings()
    root = settings.storage_root

    # 저장소 전체 파일 목록 수집 (이름 기반, 최대 500개).
    # 민감 키워드가 포함된 파일명은 외부(Gemini) 전송에서 제외.
    def _is_sensitive(rel: str) -> bool:
        low = rel.lower()
        return any(kw.lower() in low for kw in SENSITIVE_KEYWORDS)

    files: list[str] = []
    for p in root.rglob("*"):
        if p.is_file():
            rel = to_rel(root, p)
            if not _is_sensitive(rel):
                files.append(rel)
        if len(files) >= 500:
            break

    if not files:
        return SearchResponse(query=req.query, hits=[])

    listing = "\n".join(files)
    prompt = (
        "사용자의 자연어 검색어에 가장 잘 맞는 파일을 아래 목록에서 골라라.\n"
        "반드시 JSON 배열만 출력. 각 원소는 {\"path\":..., \"reason\":...}.\n"
        "최대 10개, 관련 없으면 빈 배열 [].\n\n"
        f"=== 검색어 ===\n{req.query}\n\n=== 파일 목록 ===\n{listing}"
    )
    raw = generate(prompt)

    # 모델이 ```json 펜스를 붙일 수 있으니 정리.
    cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(cleaned)
        hits = [
            SearchHit(path=str(d["path"]), reason=str(d.get("reason", "")))
            for d in data
            if isinstance(d, dict) and d.get("path") in files
        ]
    except (json.JSONDecodeError, KeyError, TypeError):
        hits = []

    return SearchResponse(query=req.query, hits=hits[:10])
