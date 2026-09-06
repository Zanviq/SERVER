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
    """어느 회의인지 고른다.

    모델이 준 id 를 먼저 쓰되, **그 id 가 없는 회의면 지금 보고 있는 회의로 돌아간다.**
    모델이 id 를 지어내 "회의를 찾을 수 없습니다"로 끝난 적이 있다(실측) — 화면이
    알려 준 id 가 모델이 타이핑한 id 보다 믿을 만하다.
    """
    given = str(args.get("meeting_id") or "").strip()
    here = str(ctx.meeting_id or "").strip()
    if given and here and given != here:
        from ... import meeting_store as _ms

        if _ms.find_meeting(ctx.user, ctx.settings, given) is None:
            return here
    return given or here


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
        # 50건에서 끊은 것을 알리지 않으면 모델이 그 수를 전체로 말한다
        capped = len(rows) >= 50
        msg = f"회의 {len(rows)}건" + (" (상한 50건에 도달 — 더 있을 수 있으니 date/query/category 로 좁히세요)"
                                     if capped else "")
        return SkillResult(ok=True, message=msg, data={"items": rows, "truncated": capped})


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
            # 8곳에서 끊는 것을 알리지 않으면 모델이 "여덟 번 나온다"고 답한다
            capped = len(hits) >= 8
            msg = f"'{q}' {len(hits)}곳" + (" (상한 8곳에 도달 — 더 있을 수 있습니다)" if capped else "")
            return SkillResult(ok=True, message=msg, data={"hits": hits, "truncated": capped})
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
        # 길면 잘라서 주는데 길이는 전체를 말하고 있었다 — 모델은 다 받은 줄 안다.
        body = d["content"][:_MAX_CHUNK * 2]
        cut = len(d["content"]) > len(body)
        msg = f"'{d['name']}' {len(d['content'])}자"
        if cut:
            msg += f" (앞 {len(body)}자만 실었습니다)"
        return SkillResult(ok=True, message=msg,
                           data={"name": d["name"], "content": body,
                                 "total_chars": len(d["content"]), "truncated": cut})


#: "문서로 남겨 달라"고 실제로 말했는가.
#:
#: 프롬프트가 "정리한 결과는 문서로 남깁니다"라고 무조건 시키고 있어서, 그냥
#: "요약해 줘"에도 2번 중 2번 문서를 만들었다(실측). 문구를 고쳤더니 이번에는
#: 반대로 **"'요약' 문서로 만들어줘"라는 분명한 요청을 2번 중 1번 무시**했다.
#: 프롬프트로 양쪽에 실패했으므로 서버가 직접 본다(단어장 71차와 같은 교훈).
_ASK_TO_SAVE = re.compile(
    r"문서|파일|저장|남겨|남기|남겨둬|작성|기록해|기록으로|정리해서 .*(만들|남)"
    r"|만들어 ?줘|만들어 ?주|만들자|추가해|붙여|이어 ?써|덮어"
    r"|\bdoc\b|\bsave\b|\bwrite\b|\bfile\b"
)


def _asked_to_save(ctx) -> bool:
    """이번 차례에 사람이 '문서로 남겨 달라'고 했는가.

    안 했으면 만들지 않고 **본문을 그대로 돌려준다** — 모델은 그것을 말로 답하면
    된다. 잘못 판단해도 손해가 다르다: 안 만들면 사용자가 한 번 더 말하면 되고,
    잘못 만들면 회의 공간에 만든 적 없는 문서가 쌓이고 같은 이름이면 앞의 것을
    덮어쓴다.

    화면이 부른 것(user_message 가 비어 있는 경우)은 사용자가 단추를 눌러
    시킨 일이므로 막지 않는다.
    """
    msg = str(getattr(ctx, "user_message", "") or "")
    return not msg.strip() or bool(_ASK_TO_SAVE.search(msg))


class WriteMeetingDoc(SkillBase):
    mutates = "meetings"
    name = "write_meeting_doc"
    description = (
        "회의 공간에 문서를 만들거나 통째로 덮어쓴다(마크다운). "
        "**사용자가 '문서로 만들어 줘'·'남겨 줘'라고 했을 때만 쓴다** — 그냥 '요약해 줘'는 "
        "말로 답하라는 뜻이지 문서를 만들라는 뜻이 아니다. "
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
            "shorten": {
                "type": "boolean",
                "description": "긴 문서를 일부러 짧게 줄이는 경우에만 true. 기본 false.",
            },
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
        if not _asked_to_save(ctx):
            # 사용자는 "요약해 줘"라고만 했다. 만들지 않고 본문을 돌려준다 —
            # 모델은 이것을 말로 답하면 되고, 사용자가 원하면 그때 남긴다.
            return SkillResult(
                ok=True,
                message=("사용자가 문서로 남겨 달라고 하지 않아 **만들지 않았습니다.** "
                         "아래 내용을 그대로 답으로 말하고, 끝에 '문서로 남길까요?' 라고 "
                         "한 줄만 물어보세요. **이번 답에서는** 다시 만들려고 하지 마세요."),
                data={"not_saved": True, "name": name, "content": content},
            )
        # read_meeting_doc 이 앞 _MAX_CHUNK*2 자만 준다. 그걸 전문으로 믿고 되쓰면
        # 뒷부분이 사라지는데, 회의 문서는 노트와 달리 **휴지통 백업이 없다** —
        # 되돌릴 방법이 아예 없으므로 노트보다 더 확실히 막는다.
        if not args.get("shorten"):
            try:
                cur = meeting_store.read_doc(ctx.user, ctx.settings, mid, name)["content"]
            except Exception:  # noqa: BLE001 - 없는 문서면 새로 만드는 것이다
                cur = ""
            if len(cur) > _MAX_CHUNK * 2 >= len(content):
                return SkillResult(
                    ok=False,
                    error_code="would_truncate",
                    message=(
                        f"'{name}' 은 {len(cur)}자인데 {len(content)}자로 덮으려 했습니다. "
                        f"read_meeting_doc 은 앞 {_MAX_CHUNK * 2}자만 주므로 읽은 만큼만 "
                        "되쓰면 뒷부분이 사라지고, 회의 문서는 휴지통에 남지 않습니다. "
                        "끝에 더하는 것이면 append_meeting_doc 을, 정말로 줄이는 것이면 "
                        "shorten=true 로 다시 부르세요."
                    ),
                    data={"meeting_id": mid, "name": name, "total_chars": len(cur)},
                )
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
            # **여기서 읽어 합치지 않는다.** 모델은 "화자 1은 김철수, 화자 2는
            # 박영희야" 한 마디에 이 도구를 나란히 두 번 부르는데, 각자 읽어
            # 합치면 서로를 덮어 한 사람 이름만 남는다. 저장소가 락 안에서 합친다.
            patch["speakers_merge"] = {str(k): str(v) for k, v in args["speakers"].items()}
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
