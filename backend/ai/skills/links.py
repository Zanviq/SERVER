"""링크 읽기 — 사용자가 `[note/서버/기록.md]` 처럼 적은 것을 모델이 다시 읽는다.

링크가 든 메시지를 보내면 그 차례에는 내용이 메시지 앞에 붙어 간다. 하지만
저장되는 것은 사용자가 친 글뿐이라, 다음 차례에 "아까 그 문서 3번 항목"을 물으면
모델에게는 링크 글자만 남아 있다. 그때 이 스킬로 다시 읽는다. 잘린 긴 본문의
뒷부분도 offset 으로 읽는다.

갈래마다 따로 있는 조회 스킬(read_document, read_paper_text …)을 부르게 할 수도
있지만, 그러려면 모델이 링크 경로를 각 스킬의 id 로 옮겨야 한다 — 그 번역에서
틀린다(논문 링크는 제목인데 스킬은 id 를 받는다). 링크는 링크로 읽는다.
"""
from __future__ import annotations

from ... import links
from ..skill_base import SkillBase, SkillResult
from .todo import _fail


class ReadLink(SkillBase):
    name = "read_link"
    description = (
        "사용자가 메시지에 [갈래/경로] 로 적은 **링크**의 내용을 읽는다. 갈래: note/(문서, "
        "note/논문/… · note/회의/… 포함) · paper/(논문 제목) · meeting/(회의 제목) · "
        "todo/(분류/제목) · event/(YYYY-MM-DD/제목) · vocab/(단어) · diary/(YYYY-MM-DD). "
        "이번 메시지의 링크 내용은 이미 메시지 앞에 실려 있으니 다시 부르지 마세요 — "
        "지난 차례의 링크를 다시 봐야 하거나, 잘린 본문의 뒷부분(offset)이 필요할 때 부른다. "
        "폴더 링크(note/서버)는 안에 든 항목 목록을 준다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "대괄호 없이 적은 링크 경로. 예: note/서버/기록.md"},
            "offset": {"type": "integer", "description": "이만큼 건너뛰고 읽는다(잘린 본문 이어 읽기). 기본 0."},
        },
        "required": ["path"],
    }

    def run(self, args, ctx):
        path = str(args.get("path") or "").strip()
        if not path:
            return SkillResult(ok=False, message="링크 경로가 없습니다.", error_code="invalid")
        try:
            offset = int(args.get("offset") or 0)
        except (TypeError, ValueError):
            offset = 0
        try:
            got = links.read(ctx.user, ctx.settings, path, offset)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        if not got["found"]:
            return SkillResult(ok=False, message=f"'{path}' — {got['note'] or '찾지 못했습니다.'}",
                               error_code="not_found")
        msg = f"{got['path']} 읽음"
        if got["truncated"]:
            nxt = got["offset"] + len(got["content"])
            msg += f" — 전체 {got['total_chars']}자 중 {got['offset']}~{nxt}자. 이어서 offset={nxt}"
        if got["note"]:
            msg += f" ({got['note']})"
        return SkillResult(ok=True, message=msg, data=got)


LINK_SKILLS: list[SkillBase] = [ReadLink()]
