"""회의 스킬 — 회의 화면의 AI 가 받아쓰기를 읽고, 그 회의 공간에 문서를 만든다.

컨텍스트 계약: 회의 화면은 SkillContext.meeting_id 로 지금 보는 회의를 알려 준다.
meeting_id 를 생략한 호출은 그 회의를 뜻한다. 다른 회의는 list_meetings 가 준 id 로.

문서 식별자는 **이름**(확장자 없는 파일 이름)이다. list_meeting_docs 가 준 name 을
read/write/append/delete 에 그대로 넘긴다. 노트(문서 화면)와 저장소가 다르므로
write_document 로는 이 공간에 쓸 수 없다 — 회의 요약은 반드시 write_meeting_doc 으로.
"""
from __future__ import annotations

import re

from ... import meeting_store
from ..skill_base import SkillBase, SkillResult
from .todo import _fail

#: read_meeting_transcript 가 한 번에 주는 글자 수
_MAX_CHUNK = 14000


def _mid(args: dict, ctx) -> str:
    return str(args.get("meeting_id") or ctx.meeting_id or "").strip()


class ListMeetings(SkillBase):
    name = "list_meetings"
    description = (
        "내 회의 녹음 목록(제목·날짜·카테고리·받아쓰기 상태·한 줄 요약). "
        "query 를 주면 제목·카테고리·요약에서, date 를 주면 그 날짜만. "
        "'지난주 회의에서 뭐 결정했지?' 같은 질문은 여기서 시작한다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "검색어(생략하면 전체)."},
            "date": {"type": "string", "description": "YYYY-MM-DD. 그 날짜의 회의만."},
            "category": {"type": "string", "description": "이 카테고리만."},
        },
    }

    def run(self, args, ctx):
        q = str(args.get("query") or "").strip().lower()
        day = str(args.get("date") or "").strip()
        cat = str(args.get("category") or "").strip().lower()
        try:
            items = meeting_store.list_meetings(ctx.user, ctx.settings)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        rows = []
        for m in items:
            if day and str(m.get("date") or "") != day:
                continue
            if cat and str(m.get("category") or "").lower() != cat:
                continue
            if q:
                hay = " ".join([str(m.get("title") or ""), str(m.get("category") or ""),
                                str(m.get("summary") or "")]).lower()
                if q not in hay:
                    continue
            r = meeting_store.brief(m)
            r["current"] = r["id"] == ctx.meeting_id
            rows.append(r)
            if len(rows) >= 50:
                break
        return SkillResult(ok=True, message=f"회의 {len(rows)}건", data={"items": rows})


class GetMeetingInfo(SkillBase):
    name = "get_meeting_info"
    description = (
        "회의 하나의 정보(제목·날짜·카테고리·받아쓰기 상태·요약·화자 이름·문서 목록). "
        "meeting_id 를 생략하면 지금 보고 있는 회의."
    )
    parameters = {
        "type": "object",
        "properties": {"meeting_id": {"type": "string", "description": "list_meetings 가 준 id"}},
    }

    def run(self, args, ctx):
        mid = _mid(args, ctx)
        if not mid:
            return SkillResult(ok=False, message="어느 회의인지 meeting_id 가 필요합니다.", error_code="invalid")
        try:
            m = meeting_store.get_meeting(ctx.user, ctx.settings, mid)
            docs = meeting_store.list_docs(ctx.user, ctx.settings, mid)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        keys = ("id", "title", "date", "category", "status", "error", "summary", "speakers", "segments")
        data = {k: m.get(k) for k in keys}
        data["docs"] = [d["name"] for d in docs]
        return SkillResult(ok=True, message=f"'{m.get('title', '')}'", data=data)


class ReadMeetingTranscript(SkillBase):
    name = "read_meeting_transcript"
    description = (
        "회의 받아쓰기(원본)를 읽는다. 화자 라벨·시각이 붙은 줄 단위. "
        "query 를 주면 그 말이 나오는 대목만, offset 으로 이어서 읽는다. "
        "한 번에 14000자까지만 오니 긴 회의는 나눠 부른다. 요약·정리는 반드시 이걸 먼저 읽고 한다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "meeting_id": {"type": "string", "description": "생략하면 지금 회의"},
            "offset": {"type": "integer", "description": "이 글자 위치부터(이전 호출의 next_offset)."},
            "query": {"type": "string", "description": "이 말이 나오는 대목만(앞뒤 500자)."},
        },
    }

    def run(self, args, ctx):
        mid = _mid(args, ctx)
        if not mid:
            return SkillResult(ok=False, message="meeting_id 가 필요합니다.", error_code="invalid")
        try:
            m = meeting_store.get_meeting(ctx.user, ctx.settings, mid)
            text = meeting_store.transcript_text(ctx.user, ctx.settings, mid, m.get("speakers") or {})
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        if not text.strip():
            status = str(m.get("status") or "")
            if status == meeting_store.STATUS_PENDING:
                return SkillResult(ok=False, error_code="pending",
                                   message="아직 받아쓰는 중입니다. 잠시 뒤 다시 시도하라고 안내하세요.")
            return SkillResult(ok=False, error_code="gone",
                               message=f"받아쓰기가 없습니다({m.get('error') or '실패'}). 화면에서 '다시 받아쓰기'를 눌러 달라고 하세요.")
        q = str(args.get("query") or "").strip()
        if q:
            ql = q.lower()
            hits = []
            i = text.lower().find(ql)
            while i >= 0 and len(hits) < 8:
                s, e = max(0, i - 500), min(len(text), i + len(q) + 500)
                hits.append(text[s:e])
                i = text.lower().find(ql, e)
            if not hits:
                return SkillResult(ok=True, message=f"'{q}' 는 받아쓰기에 없습니다", data={"hits": []})
            return SkillResult(ok=True, message=f"'{q}' {len(hits)}곳", data={"hits": hits})
        try:
            offset = max(0, int(args.get("offset") or 0))
        except (TypeError, ValueError):
            offset = 0
        chunk = text[offset:offset + _MAX_CHUNK]
        nxt = offset + len(chunk)
        data = {"text": chunk, "offset": offset, "total_chars": len(text),
                "next_offset": nxt if nxt < len(text) else None}
        return SkillResult(ok=True, message=f"받아쓰기 {offset}~{nxt}/{len(text)}자", data=data)


class ListMeetingDocs(SkillBase):
    name = "list_meeting_docs"
    description = "이 회의 공간의 문서(요약·정리) 이름 목록. meeting_id 를 생략하면 지금 회의."
    parameters = {
        "type": "object",
        "properties": {"meeting_id": {"type": "string", "description": "생략하면 지금 회의"}},
    }

    def run(self, args, ctx):
        mid = _mid(args, ctx)
        if not mid:
            return SkillResult(ok=False, message="meeting_id 가 필요합니다.", error_code="invalid")
        try:
            meeting_store.get_meeting(ctx.user, ctx.settings, mid)
            docs = meeting_store.list_docs(ctx.user, ctx.settings, mid)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        return SkillResult(ok=True, message=f"문서 {len(docs)}개", data={"items": docs})


class ReadMeetingDoc(SkillBase):
    name = "read_meeting_doc"
    description = "회의 공간의 문서 하나를 읽는다. name 은 list_meeting_docs 가 준 이름."
    parameters = {
        "type": "object",
        "properties": {
            "meeting_id": {"type": "string", "description": "생략하면 지금 회의"},
            "name": {"type": "string"},
        },
        "required": ["name"],
    }

    def run(self, args, ctx):
        mid = _mid(args, ctx)
        if not mid:
            return SkillResult(ok=False, message="meeting_id 가 필요합니다.", error_code="invalid")
        try:
            meeting_store.get_meeting(ctx.user, ctx.settings, mid)
            d = meeting_store.read_doc(ctx.user, ctx.settings, mid, str(args.get("name") or ""))
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        return SkillResult(ok=True, message=f"'{d['name']}' {len(d['content'])}자",
                           data={"name": d["name"], "content": d["content"][:_MAX_CHUNK * 2]})


class WriteMeetingDoc(SkillBase):
    mutates = "meetings"
    name = "write_meeting_doc"
    description = (
        "회의 공간에 문서를 만들거나 통째로 덮어쓴다(마크다운). 요약·회의록·액션 아이템 정리는 이걸로. "
        "이름은 '요약', '회의록', '액션 아이템' 처럼 짧게. 같은 이름이면 덮어쓴다. "
        "사용자가 원하는 느낌(간결하게/자세히/개조식 등)을 그대로 따른다. "
        "노트 화면의 write_document 와 다른 저장소다 — 회의 요약은 이 스킬로만."
    )
    parameters = {
        "type": "object",
        "properties": {
            "meeting_id": {"type": "string", "description": "생략하면 지금 회의"},
            "name": {"type": "string", "description": "문서 이름(확장자 없이)"},
            "content": {"type": "string", "description": "마크다운 본문"},
        },
        "required": ["name", "content"],
    }

    def run(self, args, ctx):
        mid = _mid(args, ctx)
        if not mid:
            return SkillResult(ok=False, message="meeting_id 가 필요합니다.", error_code="invalid")
        name = str(args.get("name") or "").strip()
        content = str(args.get("content") or "")
        if not name:
            return SkillResult(ok=False, message="문서 이름이 없습니다.", error_code="invalid")
        if not content.strip():
            return SkillResult(ok=False, message="내용이 비어 있습니다.", error_code="invalid")
        try:
            d = meeting_store.write_doc(ctx.user, ctx.settings, mid, name, content)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        verb = "만듦" if d.get("created") else "덮어씀"
        return SkillResult(ok=True, message=f"'{d['name']}' {verb} ({len(content)}자)",
                           data={"meeting_id": mid, "name": d["name"]})


class AppendMeetingDoc(SkillBase):
    mutates = "meetings"
    name = "append_meeting_doc"
    description = "회의 공간의 문서 끝에 덧붙인다. 없으면 새로 만든다. name 은 list_meeting_docs 가 준 이름."
    parameters = {
        "type": "object",
        "properties": {
            "meeting_id": {"type": "string", "description": "생략하면 지금 회의"},
            "name": {"type": "string"},
            "content": {"type": "string"},
        },
        "required": ["name", "content"],
    }

    def run(self, args, ctx):
        mid = _mid(args, ctx)
        if not mid:
            return SkillResult(ok=False, message="meeting_id 가 필요합니다.", error_code="invalid")
        name = str(args.get("name") or "").strip()
        content = str(args.get("content") or "")
        if not name or not content.strip():
            return SkillResult(ok=False, message="이름과 내용이 필요합니다.", error_code="invalid")
        try:
            d = meeting_store.write_doc(ctx.user, ctx.settings, mid, name, content, append=True)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        return SkillResult(ok=True, message=f"'{d['name']}' 에 덧붙임", data={"meeting_id": mid, "name": d["name"]})


class DeleteMeetingDoc(SkillBase):
    mutates = "meetings"
    name = "delete_meeting_doc"
    description = "회의 공간의 문서를 지운다(되돌릴 수 없다 — 사용자가 분명히 원할 때만)."
    parameters = {
        "type": "object",
        "properties": {
            "meeting_id": {"type": "string", "description": "생략하면 지금 회의"},
            "name": {"type": "string"},
        },
        "required": ["name"],
    }

    def run(self, args, ctx):
        mid = _mid(args, ctx)
        if not mid:
            return SkillResult(ok=False, message="meeting_id 가 필요합니다.", error_code="invalid")
        name = str(args.get("name") or "").strip()
        try:
            meeting_store.get_meeting(ctx.user, ctx.settings, mid)
            meeting_store.delete_doc(ctx.user, ctx.settings, mid, name)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        return SkillResult(ok=True, message=f"'{name}' 삭제", data={"meeting_id": mid, "name": name})


class UpdateMeetingInfo(SkillBase):
    mutates = "meetings"
    name = "update_meeting_info"
    description = (
        "회의 제목·카테고리·날짜·요약·화자 이름을 바꾼다. "
        "speakers 는 {'화자 1': '김철수'} 처럼 라벨→이름. 사용자가 '화자 2는 박대리야' 하면 이걸로."
    )
    parameters = {
        "type": "object",
        "properties": {
            "meeting_id": {"type": "string", "description": "생략하면 지금 회의"},
            "title": {"type": "string"},
            "category": {"type": "string"},
            "date": {"type": "string", "description": "YYYY-MM-DD"},
            "summary": {"type": "string"},
            "speakers": {"type": "object", "description": "화자 라벨 → 이름"},
        },
    }

    def run(self, args, ctx):
        mid = _mid(args, ctx)
        if not mid:
            return SkillResult(ok=False, message="meeting_id 가 필요합니다.", error_code="invalid")
        patch = {k: args[k] for k in ("title", "category", "date", "summary") if args.get(k) is not None}
        if isinstance(args.get("speakers"), dict):
            try:
                cur = dict(meeting_store.get_meeting(ctx.user, ctx.settings, mid).get("speakers") or {})
            except Exception as e:  # noqa: BLE001
                return _fail(e)
            cur.update({str(k): str(v) for k, v in args["speakers"].items()})
            patch["speakers"] = cur
        if not patch:
            return SkillResult(ok=False, message="바꿀 내용이 없습니다.", error_code="invalid")
        if "date" in patch and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(patch["date"])):
            return SkillResult(ok=False, message="날짜는 YYYY-MM-DD 형식이어야 합니다.", error_code="invalid")
        try:
            m = meeting_store.update_meta(ctx.user, ctx.settings, mid, patch)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        return SkillResult(ok=True, message=f"'{m.get('title', '')}' 수정", data={"meeting_id": mid})


MEETING_SKILLS: list[SkillBase] = [
    ListMeetings(), GetMeetingInfo(), ReadMeetingTranscript(),
    ListMeetingDocs(), ReadMeetingDoc(), WriteMeetingDoc(), AppendMeetingDoc(), DeleteMeetingDoc(),
    UpdateMeetingInfo(),
]
