"""논문 스킬 — 논문 화면의 AI 가 "이 논문"과 "다른 논문에서 했던 이야기"를 찾는다.

컨텍스트 계약: 논문 화면은 SkillContext.paper_id 로 지금 보는 논문을 알려 준다.
paper_id 를 생략한 호출은 그 논문을 뜻한다. 다른 논문을 보려면 list_papers 가
준 id 를 넘긴다.

본문은 통째로 주지 않는다(수십 쪽이면 컨텍스트가 터진다). read_paper_text 는
쪽 범위나 검색어로 잘라 준다.
"""
from __future__ import annotations

import re
import time

from ... import chat_store, paper_store
from ..skill_base import SkillBase, SkillResult
from .todo import _fail

#: read_paper_text 가 한 번에 주는 글자 수
_MAX_CHUNK = 12000
_PAGE_RE = re.compile(r"\[\[page (\d+)\]\]")


def _pid(args: dict, ctx) -> str:
    return str(args.get("paper_id") or ctx.paper_id or "").strip()


def _split_pages(text: str) -> dict[int, str]:
    """text.txt 의 [[page n]] 표식으로 쪽마다 나눈다."""
    out: dict[int, str] = {}
    pos = [(m.start(), m.end(), int(m.group(1))) for m in _PAGE_RE.finditer(text)]
    for i, (start, end, n) in enumerate(pos):
        stop = pos[i + 1][0] if i + 1 < len(pos) else len(text)
        out[n] = text[end:stop].strip()
    if not out and text.strip():
        out[1] = text.strip()
    return out


class ListPapers(SkillBase):
    name = "list_papers"
    description = (
        "내 논문 목록(제목·저자·연도·키워드·한 줄 요약). query 를 주면 제목·초록·요약·키워드·메모에서 찾는다. "
        "'전에 읽은 ~ 관련 논문', '다른 논문에서는 어땠어?' 같은 질문은 여기서 시작한다."
    )
    parameters = {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "검색어(생략하면 전체)."}},
    }

    def run(self, args, ctx):
        q = str(args.get("query") or "").strip()
        try:
            papers = (paper_store.search(ctx.user, ctx.settings, q, limit=50) if q
                      else paper_store.list_papers(ctx.user, ctx.settings))
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        rows = [paper_store.brief(p) for p in papers[:50]]
        for r in rows:
            r["current"] = r["id"] == ctx.paper_id
        return SkillResult(ok=True, message=f"논문 {len(rows)}편", data={"items": rows})


class GetPaperInfo(SkillBase):
    name = "get_paper_info"
    description = (
        "논문 한 편의 정보 전부(초록·요약·핵심 발견·방법·한계·키워드·섹션·내 메모). "
        "paper_id 를 생략하면 지금 보고 있는 논문."
    )
    parameters = {
        "type": "object",
        "properties": {"paper_id": {"type": "string", "description": "list_papers 가 준 id"}},
    }

    def run(self, args, ctx):
        pid = _pid(args, ctx)
        if not pid:
            return SkillResult(ok=False, message="어느 논문인지 paper_id 가 필요합니다.", error_code="invalid")
        try:
            p = paper_store.get_paper(ctx.user, ctx.settings, pid)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        keys = ("id", "title", "authors", "year", "venue", "abstract", "summary", "key_findings",
                "methods", "limitations", "keywords", "sections", "pages", "notes", "tags", "status")
        return SkillResult(ok=True, message=f"'{p.get('title', '')}'", data={k: p.get(k) for k in keys})


class ReadPaperText(SkillBase):
    name = "read_paper_text"
    description = (
        "논문 본문을 읽는다. from_page/to_page 로 쪽 범위를 주거나 query 로 그 말이 나오는 대목만 본다. "
        "둘 다 없으면 앞부분(1~2쪽). 한 번에 12000자까지만 오니 넓게 읽으려면 나눠 부른다. "
        "본문에는 [[page n]] 표식이 있으니 답할 때 쪽수를 함께 말한다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "paper_id": {"type": "string", "description": "생략하면 지금 논문"},
            "from_page": {"type": "integer"},
            "to_page": {"type": "integer"},
            "query": {"type": "string", "description": "이 말이 나오는 대목만(앞뒤 600자)."},
        },
    }

    def run(self, args, ctx):
        pid = _pid(args, ctx)
        if not pid:
            return SkillResult(ok=False, message="paper_id 가 필요합니다.", error_code="invalid")
        try:
            p = paper_store.get_paper(ctx.user, ctx.settings, pid)
            text = paper_store.read_text(ctx.user, ctx.settings, pid)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        if not text.strip():
            return SkillResult(
                ok=False, error_code="gone",
                message="이 PDF 에서는 글자를 뽑지 못했습니다(스캔본일 수 있음). 사용자에게 영역을 드래그해 보내 달라고 하세요.",
            )
        pages = _split_pages(text)
        q = str(args.get("query") or "").strip()
        if q:
            ql = q.lower()
            hits = []
            for n in sorted(pages):
                body = pages[n]
                i = body.lower().find(ql)
                while i >= 0 and len(hits) < 8:
                    s, e = max(0, i - 600), min(len(body), i + len(q) + 600)
                    hits.append({"page": n, "text": body[s:e]})
                    i = body.lower().find(ql, e)
                if len(hits) >= 8:
                    break
            if not hits:
                return SkillResult(ok=True, message=f"'{q}' 이(가) 본문에 없습니다.", data={"hits": []})
            return SkillResult(ok=True, message=f"'{q}' {len(hits)}곳", data={"hits": hits})

        total = max(pages) if pages else 0
        try:
            a = int(args.get("from_page") or 1)
            b = int(args.get("to_page") or (a + 1 if not args.get("from_page") else a))
        except (TypeError, ValueError):
            return SkillResult(ok=False, message="쪽수는 정수여야 합니다.", error_code="invalid")
        a, b = max(1, a), max(a, b)
        chunk = ""
        last = a
        for n in range(a, b + 1):
            if n in pages:
                piece = f"\n\n[[page {n}]]\n{pages[n]}"
                if len(chunk) + len(piece) > _MAX_CHUNK:
                    break
                chunk += piece
                last = n
        truncated = last < b or (b < total)
        return SkillResult(
            ok=True,
            message=f"'{p.get('title', '')}' {a}~{last}쪽 (전체 {total}쪽)",
            data={"text": chunk.strip(), "from_page": a, "to_page": last, "total_pages": total,
                  "truncated": truncated},
        )


class SearchPaperChats(SkillBase):
    name = "search_paper_chats"
    description = (
        "모든 논문에서 나눈 예전 대화를 검색한다. '저번에 물어봤던', '다른 논문에서 설명한 ~' 처럼 "
        "이전 대화를 참고해야 할 때. paper_id 를 주면 그 논문의 대화만."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "paper_id": {"type": "string", "description": "생략하면 모든 논문"},
        },
        "required": ["query"],
    }

    def run(self, args, ctx):
        q = str(args.get("query") or "").strip()
        if not q:
            return SkillResult(ok=False, message="검색어가 없습니다.", error_code="invalid")
        only = str(args.get("paper_id") or "").strip()
        try:
            papers = paper_store.list_papers(ctx.user, ctx.settings)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        out = []
        for p in papers:
            pid = str(p.get("id") or "")
            if only and pid != only:
                continue
            msgs = chat_store.load(paper_store.chat_path(ctx.user, ctx.settings, pid))
            for h in chat_store.search(msgs, q, limit=6):
                ts = float(h.get("ts") or 0)
                out.append({
                    "paper_id": pid, "paper_title": p.get("title", ""),
                    "current": pid == ctx.paper_id,
                    "role": h["role"], "snippet": h["snippet"],
                    "when": time.strftime("%Y-%m-%d", time.localtime(ts)) if ts else "",
                })
            if len(out) >= 30:
                break
        return SkillResult(ok=True, message=f"이전 대화 {len(out)}건", data={"hits": out[:30]})


class SetPaperNotes(SkillBase):
    mutates = "papers"
    name = "set_paper_notes"
    description = (
        "논문 메모(내 정리)를 쓴다. append=true 면 기존 메모 아래에 덧붙인다. "
        "사용자가 '이거 메모해 둬', '정리해서 남겨 줘' 하면 이걸로."
    )
    parameters = {
        "type": "object",
        "properties": {
            "paper_id": {"type": "string", "description": "생략하면 지금 논문"},
            "notes": {"type": "string"},
            "append": {"type": "boolean"},
        },
        "required": ["notes"],
    }

    def run(self, args, ctx):
        pid = _pid(args, ctx)
        if not pid:
            return SkillResult(ok=False, message="paper_id 가 필요합니다.", error_code="invalid")
        notes = str(args.get("notes") or "").strip()
        if not notes:
            return SkillResult(ok=False, message="메모 내용이 없습니다.", error_code="invalid")
        try:
            if args.get("append"):
                cur = str(paper_store.get_paper(ctx.user, ctx.settings, pid).get("notes") or "").rstrip()
                notes = f"{cur}\n\n{notes}" if cur else notes
            p = paper_store.update_meta(ctx.user, ctx.settings, pid, {"notes": notes})
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        return SkillResult(ok=True, message=f"'{p.get('title', '')}' 메모 저장", data={"paper_id": pid})


class UpdatePaperInfo(SkillBase):
    mutates = "papers"
    name = "update_paper_info"
    description = (
        "논문의 **폴더(분류)·제목·별표·파일 이름**을 고친다. "
        "'이 논문 강화학습 폴더로 옮겨 줘', '제목이 잘못됐어', '별표 달아 줘' 같은 말에 쓴다. "
        "폴더는 미리 만들 필요가 없다 — 이름을 적으면 그 폴더가 생기고, 마지막 논문이 나가면 사라진다. "
        "category 를 빈 문자열로 주면 '분류 없음'으로 뺀다. "
        "**제목을 바꾸면 그 논문으로 넣은 단어장 태그도 함께 따라간다.**"
    )
    parameters = {
        "type": "object",
        "properties": {
            "paper_id": {"type": "string", "description": "생략하면 지금 논문. 모르면 list_papers 로 찾는다."},
            "category": {"type": "string", "description": "폴더 이름. 빈 문자열이면 폴더에서 뺀다."},
            "title": {"type": "string", "description": "제목"},
            "starred": {"type": "boolean", "description": "별표"},
            "filename": {"type": "string", "description": "내려받을 때 쓰는 파일 이름(.pdf 는 서버가 붙인다)."},
        },
    }

    def run(self, args, ctx):
        pid = _pid(args, ctx)
        if not pid:
            return SkillResult(ok=False, message="paper_id 가 필요합니다. list_papers 로 찾으세요.",
                               error_code="invalid")
        patch = {k: args[k] for k in ("category", "title", "starred", "filename")
                 if args.get(k) is not None}
        if not patch:
            return SkillResult(ok=False, message="바꿀 내용이 없습니다.", error_code="invalid")
        try:
            p = paper_store.update_meta(ctx.user, ctx.settings, pid, patch)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        bits = []
        if "category" in patch:
            bits.append(f"폴더 '{p.get('category') or '분류 없음'}'")
        if "title" in patch:
            bits.append(f"제목 '{p.get('title', '')}'")
        if "starred" in patch:
            bits.append("별표 " + ("켬" if p.get("starred") else "끔"))
        if "filename" in patch:
            bits.append(f"파일 이름 '{p.get('filename', '')}'")
        return SkillResult(ok=True, message=" / ".join(bits) or "수정됨",
                           data={"paper_id": pid, "title": p.get("title", ""),
                                 "category": p.get("category", "")})


PAPER_SKILLS: list[SkillBase] = [
    ListPapers(), GetPaperInfo(), ReadPaperText(), SearchPaperChats(), SetPaperNotes(),
    UpdatePaperInfo(),
]
