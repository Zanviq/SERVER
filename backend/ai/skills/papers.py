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
    """어느 논문인지 고른다.

    모델이 준 id 를 먼저 쓰되, **그 id 가 없는 논문이면 지금 보고 있는 논문으로**
    돌아간다. 회의 쪽에서 모델이 id 를 지어내 "찾을 수 없습니다"로 끝난 적이 있다 —
    화면이 알려 준 id 가 모델이 타이핑한 id 보다 믿을 만하다.
    """
    given = str(args.get("paper_id") or "").strip()
    here = str(ctx.paper_id or "").strip()
    if given and here and given != here:
        if paper_store.find_paper(ctx.user, ctx.settings, given) is None:
            return here
    return given or here


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
        "내 논문 목록(제목·저자·연도·키워드·**짧은** 한 줄 요약). query 를 주면 제목·초록·요약·키워드·메모에서 찾는다. "
        "요약은 어느 논문인지 알아볼 만큼만 잘려 있다 — 자세한 내용이 필요하면 그 논문만 get_paper_info 로 가져간다. "
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
        # 보여 준 개수를 전체 개수처럼 말하면 안 된다. 60편을 가진 사람이
        # "논문 몇 편 있어?"라고 물었을 때 50이라고 답하게 된다.
        total = len(papers)
        msg = f"논문 {total}편"
        data: dict = {"items": rows, "total": total}
        if total > len(rows):
            data["truncated"] = True
            msg += f" — 앞 {len(rows)}편만 표시(query 로 좁히세요)"
        return SkillResult(ok=True, message=msg, data=data)


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
            # 8곳에서 끊는다는 것을 알리지 않으면 모델이 "본문에 여덟 번 나온다"고 답한다
            capped = len(hits) >= 8
            msg = f"'{q}' {len(hits)}곳" + (" (상한 8곳에 도달 — 더 있을 수 있습니다)" if capped else "")
            return SkillResult(ok=True, message=msg, data={"hits": hits, "truncated": capped})

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
        hits = out[:30]
        # 30건에서 끊은 것을 조용히 넘기면 모델이 "이게 전부"라고 답한다
        capped = len(out) >= 30
        msg = f"이전 대화 {len(hits)}건" + (" (상한 30건에 도달 — 더 있을 수 있습니다)" if capped else "")
        return SkillResult(ok=True, message=msg, data={"hits": hits, "truncated": capped})


#: 메모 자리에 들어온 "못 읽었다"는 설명을 알아보는 규칙.
#:
#: 논문 추출에서 쓰는 것과 **같은 두 신호**를 쓴다(paper_extract._drop_refusals):
#: 못 하겠다는 말 + 그 대상이 문서·정보라는 말. 한쪽만 보면 진짜 메모를 막는다
#: ("이 논문은 한계가 명확하지 않다"는 사용자가 적을 법한 메모다).
#:
#: 길이도 함께 본다. 긴 메모 안에 그런 문장이 한 줄 섞이는 것은 정상이고,
#: **메모 전체가** 그 설명뿐일 때만 막는다.
_EXCUSE_VERB = re.compile(
    r"추출되지 않|추출하지 못|제공되지 않|확인할 수 없|읽을 수 없|찾을 수 없"
    r"|없습니다|아직 없|비어 있|not (?:provided|available|extracted)|unable to|no content",
    re.I,
)
_EXCUSE_SUBJECT = re.compile(
    r"정보|내용|요약|본문|논문|문서|핵심|발견|방법|한계|섹션"
    r"|information|content|summary|abstract|paper|document",
    re.I,
)
#: 이보다 길거나 문장이 많으면 설명이 섞인 진짜 메모로 본다.
#:
#: **놓치는 쪽이 지우는 쪽보다 낫다**(90차와 같은 판단). 잘못 막으면 사용자가
#: 부탁한 메모가 사라지고, 놓치면 지저분한 줄이 하나 남을 뿐이다. 그래서 실제로
#: 본 실패의 모양 — **한 문장짜리 짧은 설명** — 에만 걸리게 좁힌다.
#: ("…성능이 떨어진다는 정보가 없습니다. 그래서 후속 연구에서…" 같은 여러 문장
#:  짜리 진짜 메모를 막던 것을 실측으로 잡아 이 조건을 붙였다.)
_EXCUSE_MAX_CHARS = 200
_EXCUSE_MAX_SENTENCES = 2
_SENTENCE_END = re.compile(r"[.!?…]|다\s*$|다[\s\n]", re.M)


def _is_excuse(text: str) -> bool:
    """메모가 아니라 '정보가 없다'는 설명인가."""
    body = (text or "").strip()
    if not body or len(body) > _EXCUSE_MAX_CHARS:
        return False
    if len(_SENTENCE_END.findall(body)) > _EXCUSE_MAX_SENTENCES:
        return False
    return bool(_EXCUSE_VERB.search(body) and _EXCUSE_SUBJECT.search(body))


class SetPaperNotes(SkillBase):
    mutates = "papers"
    name = "set_paper_notes"
    description = (
        "논문 메모(내 정리)를 쓴다. **이미 적어 둔 메모가 있으면 아래에 덧붙인다** — "
        "통째로 바꾸려면 append=false 를 분명히 주세요(사용자가 '메모 다시 써 줘'라고 했을 때만). "
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
        if _is_excuse(notes):
            # **"못 읽었다"는 말은 메모가 아니다.** 추출이 실패한 논문에서
            # "메모해 둬"를 시키면 모델이 "아직 핵심 발견·방법·한계 정보는
            # 추출되지 않았습니다"를 메모에 적어 넣었다(실측). 메모는 덧붙이는
            # 자리라 그런 줄이 쌓이고, 사용자가 손으로 지워야 한다.
            # 90차에 논문 제목에서 막은 것과 같은 결함이 자리만 옮긴 것이다.
            return SkillResult(
                ok=False,
                error_code="nothing_to_note",
                message=("메모에 적을 내용이 아니라 '정보가 없다'는 설명입니다 — 저장하지 "
                         "않았습니다. 그 사실은 **답으로 말하고**, 무엇을 메모할지 "
                         "물어보거나 read_paper_text 로 본문을 읽어 내용을 만드세요."),
            )
        # **이미 적어 둔 메모를 덮지 않는다.** 논문 메모는 사용자가 손으로 쓴
        # 글이라, "메모해 둬" 한마디에 통째로 바뀌면 그동안 정리한 것이 사라진다
        # (일기에서 같은 일을 겪었다). 덮어쓰기는 append=false 를 분명히 준
        # 경우에만 — 사용자가 "메모 다시 써 줘"라고 했을 때다.
        #
        # 이어 붙이기는 **저장소가 락 안에서** 한다. 여기서 읽어 붙여 넘기면 그
        # 사이에 들어온 다른 요청과 서로를 덮는다(실측: 동시 20건 중 1건만 남음).
        overwrite = args.get("append") is False
        try:
            had = bool(str(paper_store.get_paper(ctx.user, ctx.settings, pid).get("notes") or "").strip())
            p = paper_store.update_meta(
                ctx.user, ctx.settings, pid,
                {"notes": notes} if overwrite else {"notes_append": notes},
            )
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        how = "덮어씀" if (overwrite or not had) else "덧붙임"
        return SkillResult(ok=True, message=f"'{p.get('title', '')}' 메모 {how}", data={"paper_id": pid})


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
