"""지난 대화(컨텍스트) 스킬 — 어디의, 언제 이야기를 꺼낼지 **모델이 고른다**.

프롬프트에는 지금 화면의 최근 하루치만 들어간다. 그보다 오래됐거나 다른 화면에서
한 이야기는 여기 스킬로 직접 꺼낸다(Anthropic 이 말하는 just-in-time 검색).
전부 미리 넣으면 요금·지연이 늘고 관계없는 옛 대화가 답을 흐린다.

계약:
- list_context_spaces 가 준 space 문자열을 read/search 에 그대로 넘긴다.
- 시간은 days_ago(며칠 전부터) 로 준다. 날짜 문자열을 지어내지 않게 하려는 것이다.
"""
from __future__ import annotations

import time

from ... import context_store
from ..skill_base import SkillBase, SkillResult
from .todo import _fail

_MAX_MESSAGES = 60
_MAX_TEXT = 1200


def _fmt_ts(ts: float) -> str:
    if not ts:
        return ""
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))


def _row(m: dict, *, with_tools: bool) -> dict:
    out = {
        "role": m.get("role", ""),
        "at": _fmt_ts(float(m.get("ts") or 0)),
        "text": str(m.get("text") or "")[:_MAX_TEXT],
    }
    if with_tools:
        tools = (m.get("meta") or {}).get("tools") or []
        if tools:
            out["tools"] = [{"name": t.get("name", ""), "ok": t.get("ok"),
                             "message": str(t.get("message") or "")[:200]} for t in tools[:12]]
    return out


def _current_space(ctx) -> str:
    """지금 이 대화가 남는 공간. 0건일 때 어디를 대신 보여 줄지 정하는 데 쓴다."""
    if getattr(ctx, "paper_id", ""):
        return f"paper:{ctx.paper_id}"
    if getattr(ctx, "meeting_id", ""):
        return f"meeting:{ctx.meeting_id}"
    mode = str(getattr(ctx, "mode", "") or "")
    return mode if mode in context_store.FIXED_SPACES else ""


def _since(args: dict) -> float:
    """days_ago → unix 초. 0/없음이면 제한 없음."""
    try:
        days = float(args.get("days_ago") or 0)
    except (TypeError, ValueError):
        return 0.0
    return time.time() - days * 86400 if days > 0 else 0.0


class ListContextSpaces(SkillBase):
    name = "list_context_spaces"
    description = (
        "지난 대화가 어디에 얼마나 있는지 본다. 화면 하나가 공간 하나다 — "
        "'assistant'(비서), 'calendar'(캘린더), 'english'(영어 학습), "
        "'paper:<논문id>', 'meeting:<회의id>'. "
        "여기서 얻은 space 문자열을 read_context/search_context 에 그대로 넘긴다. "
        "'전에 어디서 이야기했더라' 처럼 어느 화면인지 모를 때 먼저 부른다."
    )
    parameters = {"type": "object", "properties": {}}

    def run(self, args, ctx):
        try:
            rows = context_store.space_rows(ctx.user, ctx.settings)
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        out = [{
            "space": r["space"], "label": r["label"], "kind": r["kind"],
            "messages": r["messages"], "sessions": r["sessions"],
            "last_at": _fmt_ts(r["last_at"]),
        } for r in rows if r["messages"] > 0]
        return SkillResult(ok=True, message=f"대화가 있는 공간 {len(out)}곳", data={"spaces": out})


class SearchContext(SkillBase):
    name = "search_context"
    description = (
        "지난 대화에서 **낱말로 찾는다.** '전에 물어봤던 X', '지난주에 이야기한 Y' 처럼 "
        "찾을 말이 분명할 때 쓴다. space 를 주면 그 화면만, 비우면 전부 뒤진다. "
        "**화면만 지목하고 내용을 모를 때는('영어 학습에서 뭐 물어봤지') 검색하지 말고 "
        "read_context(space=...) 로 통째로 읽어라.** 낱말이 없는데 검색하면 0건이 나온다. "
        "days_ago 로 언제부터인지 정한다(예: 7 = 최근 일주일). "
        "찾은 뒤 그 대목을 통째로 보려면 read_context(space, session) 를 부른다. "
        "**0건이라고 곧바로 '그런 대화가 없다'고 단정하지 마라** — 최근 하루치는 이미 위 대화에 "
        "들어 있으니 먼저 그것을 보고, 그래도 못 찾으면 낱말을 바꿔(짧고 특징적인 명사로) 다시 찾아라."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "찾을 말. 낱말을 띄어 쓰면 **모두** 든 대화만 나온다."},
            "space": {"type": "string", "description": "이 공간만. 비우면 전부."},
            "days_ago": {"type": "number", "description": "며칠 전부터. 비우면 처음부터."},
            "limit": {"type": "integer", "description": "최대 건수(기본 20)."},
        },
        "required": ["query"],
    }

    def run(self, args, ctx):
        q = str(args.get("query") or "").strip()
        if not q:
            return SkillResult(ok=False, message="찾을 말이 없습니다.", error_code="invalid")
        space = str(args.get("space") or "").strip()
        try:
            if space:
                space = context_store.resolve_space(ctx.user, ctx.settings, space)
            hits = context_store.search(
                ctx.user, ctx.settings, q,
                spaces=[space] if space else None,
                since=_since(args),
                limit=int(args.get("limit") or 20),
            )
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        rows = [{
            "space": h["space"], "label": h["label"], "session": h["session"],
            "role": h["role"], "at": _fmt_ts(h["ts"]), "snippet": h["snippet"],
        } for h in hits]
        data: dict = {"hits": rows, "query": q}
        if rows:
            msg = f"{len(rows)}건 찾음"
        else:
            # 0건을 그냥 돌려주면 모델이 "그런 대화가 없다"고 단정해 버린다(실측).
            # 막다른 길 대신 **최근 대화를 함께 준다** — 찾던 것이 대개 거기 있다.
            target = space or _current_space(ctx)
            recent = []
            if target:
                try:
                    recent = [_row(m, with_tools=False)
                              for m in context_store.read(ctx.user, ctx.settings, target, limit=8)]
                except Exception:  # noqa: BLE001
                    recent = []
            data["recent"] = recent
            msg = (f"낱말로는 0건. 대신 최근 대화 {len(recent)}개를 함께 냅니다 — 여기 있는지 먼저 보세요. "
                   "없으면 짧고 특징적인 명사로 다시 찾거나 read_context 로 통째로 읽으세요."
                   if recent else
                   "낱말로는 0건. read_context(space=...) 로 통째로 읽거나 다른 낱말로 다시 찾으세요.")
        return SkillResult(ok=True, message=msg, data=data)


class ReadContext(SkillBase):
    name = "read_context"
    description = (
        "지난 대화를 **통째로 읽는다.** search_context 로 찾은 session 을 주면 그 대화 한 판을, "
        "days_ago 만 주면 그 기간의 대화를 낸다. 스킬을 무엇을 불렀는지도 함께 나오므로 "
        "'그때 뭘 저장했더라' 를 확인할 수 있다. 지금 화면의 최근 하루치는 이미 위에 있으니 "
        "그보다 옛날이나 다른 화면을 볼 때만 쓴다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "space": {"type": "string", "description":
                      "'assistant'(비서) · 'calendar'(캘린더) · 'english'(영어 학습) · "
                      "'paper:<논문id>' · 'meeting:<회의id>'. 확실하지 않으면 list_context_spaces 로 확인한다."},
            "session": {"type": "string", "description": "search_context 가 준 세션 id(있으면 그 세션만)."},
            "days_ago": {"type": "number", "description": "며칠 전부터. session 을 주면 무시된다."},
            "limit": {"type": "integer", "description": "최대 메시지 수(기본 40, 최대 60)."},
            "with_tools": {"type": "boolean", "description": "스킬 호출 기록도 함께(기본 true)."},
        },
        "required": ["space"],
    }

    def run(self, args, ctx):
        space = str(args.get("space") or "").strip()
        if not space:
            return SkillResult(ok=False, message="공간을 지정하세요.", error_code="invalid")
        limit = max(1, min(int(args.get("limit") or 40), _MAX_MESSAGES))
        try:
            # 이름이 틀렸는데 "대화 없음"으로 돌려주면 모델이 없는 줄 알고 넘어간다.
            # 먼저 공간을 확인해서 not_found 로 알린다 → list_context_spaces 로 재시도한다.
            # 모델이 "영어 학습" 처럼 부르면 여기서 id 로 바꾼다(못 알아들으면 not_found)
            space = context_store.resolve_space(ctx.user, ctx.settings, space)
            msgs = context_store.read(
                ctx.user, ctx.settings, space,
                since=_since(args), session=str(args.get("session") or "").strip(),
                limit=limit,
            )
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        with_tools = args.get("with_tools") is not False
        rows = [_row(m, with_tools=with_tools) for m in msgs]
        label = context_store.space_label(ctx.user, ctx.settings, space)
        return SkillResult(
            ok=True,
            message=f"'{label}' 대화 {len(rows)}개" if rows else f"'{label}' 에 그 기간 대화가 없습니다.",
            data={"space": space, "label": label, "messages": rows, "truncated": len(msgs) >= limit},
        )


CONTEXT_SKILLS: list[SkillBase] = [ListContextSpaces(), SearchContext(), ReadContext()]
