"""전역 검색 스킬 — "그거 어디 있었지"를 화면을 몰라도 답한다.

기존 조회 스킬은 갈래마다 따로다(list_papers, list_todos, search_context…). 무엇을
찾는지는 아는데 **어디에 넣었는지 모를 때** 모델은 갈래를 하나씩 찔러 보게 되고,
그만큼 단계와 요금을 쓴다. 여기서 한 번에 훑고, 나온 id 를 각 갈래의 조회 스킬에
그대로 넘긴다.
"""
from __future__ import annotations

from ... import search_all
from ..skill_base import SkillBase, SkillResult
from .todo import _fail

_KIND_LABEL = {
    "note": "문서", "paper": "논문", "meeting": "회의", "vocab": "단어",
    "todo": "할 일", "event": "일정", "chat": "지난 대화",
}


class SearchEverything(SkillBase):
    name = "search_everything"
    description = (
        "문서·논문·회의·단어장·할 일·일정·지난 대화를 **한 번에** 낱말로 찾는다. "
        "'그거 어디 있었지', '제올라이트 관련해서 내가 뭐 해뒀지'처럼 **어느 화면인지 "
        "모를 때** 먼저 부른다. 어느 화면인지 이미 안다면 그 화면 전용 조회 스킬이 더 "
        "자세하다(list_papers, list_todos, read_context …). "
        "결과의 id 는 갈래마다 뜻이 다르다 — 문서는 경로, 지난 대화는 '<space>|<session>', "
        "나머지는 그 갈래 스킬에 그대로 넘길 수 있는 id 다. "
        "kinds 로 갈래를 좁힐 수 있다(예: 'paper,meeting'). "
        "**0건이라고 곧바로 '없다'고 단정하지 마라** — 낱말을 짧고 특징적인 명사로 바꿔 다시 찾아라."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "찾을 말. 짧고 특징적인 명사가 잘 걸린다."},
            "kinds": {
                "type": "string",
                "description": "쉼표로 구분한 갈래(note,paper,meeting,vocab,todo,event,chat). 비우면 전부.",
            },
            "limit": {"type": "integer", "description": "최대 건수(기본 20)."},
        },
        "required": ["query"],
    }

    def run(self, args, ctx):
        q = str(args.get("query") or "").strip()
        if not q:
            return SkillResult(ok=False, message="찾을 말이 없습니다.", error_code="invalid")
        picked = tuple(k.strip() for k in str(args.get("kinds") or "").split(",")
                       if k.strip() in search_all.KINDS)
        try:
            limit = int(args.get("limit") or 20)
        except (TypeError, ValueError):
            limit = 20
        try:
            # 결과가 모델로 나간다 — 민감 문서의 내용은 빼라고 알린다
            result = search_all.find(ctx.user, ctx.settings, q,
                                     picked or search_all.KINDS, max(1, min(limit, 50)),
                                     for_model=True)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        rows = [{
            "kind": h["kind"], "where": _KIND_LABEL.get(h["kind"], h["kind"]),
            "id": h["id"], "title": h["title"],
            "snippet": h["snippet"][:200], "when": h["when"] or h["where"],
        } for h in result.hits]
        found = ", ".join(sorted({_KIND_LABEL.get(r["kind"], r["kind"]) for r in rows}))
        message = f"'{q}' — {len(rows)}건" + (f" ({found})" if rows else " (없음)")
        # 잘려서 안 보인 것이 있으면 말한다 — 말없이 자르면 모델은 "이게 전부"라고 답한다
        more = _more_note(result)
        if more:
            message += f". 더 있음: {more} — 갈래(kinds)를 정하거나 검색어를 좁혀 다시 찾으세요."
        return SkillResult(
            ok=True, message=message,
            data={"query": q, "hits": rows, "more": result.more,
                  "more_at_least": sorted(result.at_least)},
        )


def _more_note(result) -> str:
    """'노트 16건 넘게, 단어 3건' 처럼. 끝까지 세지 못한 갈래는 '넘게'·'더 있을 수 있음'."""
    parts = []
    for kind in sorted(set(result.more) | result.at_least):
        n = result.more.get(kind, 0)
        label = _KIND_LABEL.get(kind, kind)
        if kind in result.at_least:
            parts.append(f"{label} {n}건 넘게" if n else f"{label} 더 있을 수 있음")
        else:
            parts.append(f"{label} {n}건")
    return ", ".join(parts)
