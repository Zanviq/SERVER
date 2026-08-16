"""노트 관련 스킬."""
from __future__ import annotations

from ...notes_graph import backlinks_for
from ...security_paths import safe_join, to_rel
from ...storage import notes_root
from ...trash import move_to_trash
from ..skill_base import SkillBase, SkillResult
from ._common import _MAX_READ, _SCOPE_PROP, _is_sensitive


_TITLE_PROP = {
    "type": "string",
    "description": (
        "노트 식별자. list_notes·search_notes가 준 값을 그대로 쓰면 된다. "
        "폴더 안 노트는 '폴더/제목', 루트 노트는 '제목'. 제목만 줘도 유일하면 찾아준다."
    ),
}


def _ident(root, p) -> str:
    """노트 식별자 — 루트 기준 상대경로에서 .md만 뗀 것.

    루트 노트는 제목 그대로("메모"), 폴더 안 노트는 "폴더/제목"이 된다.
    list/search가 주는 값을 read/append/delete/rename에 그대로 쓸 수 있게 한다.
    """
    rel = to_rel(root, p)
    return rel[:-3] if rel.endswith(".md") else rel


def _find_by_stem(root, title: str) -> list:
    """폴더를 생략한 제목으로 볼트 전체에서 찾는다(모델이 흔히 제목만 준다).

    제목을 glob 패턴에 끼워 넣지 않는다 — '*'·'['·'?' 같은 문자가 든 제목이
    엉뚱한 파일에 매칭되거나 패턴 오류를 내는 것을 막기 위해 stem을 직접 비교한다.
    """
    stem = title.rsplit("/", 1)[-1]
    return sorted(p for p in root.rglob("*.md") if p.is_file() and p.stem == stem)


class _Ambiguous(Exception):
    """같은 제목의 노트가 여러 폴더에 있어 대상을 특정할 수 없음."""

    def __init__(self, root, hits):
        self.candidates = [_ident(root, p) for p in hits]


def _resolve_note(root, title: str):
    """제목/경로 → 실제 파일. 없으면 None, 후보가 여럿이면 _Ambiguous.

    1) 준 값을 경로로 그대로 해석 → 있으면 그것.
    2) 없으면 제목(stem)으로 볼트 전체 검색 → 유일하면 그것, 여럿이면 거절.
    """
    exact = safe_join(root, f"{title}.md")
    if exact.is_file():
        return exact
    hits = _find_by_stem(root, title)
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        raise _Ambiguous(root, hits)
    return None


def _ambiguous_result(exc: _Ambiguous) -> SkillResult:
    joined = ", ".join(exc.candidates)
    return SkillResult(
        ok=False,
        message=f"같은 제목의 노트가 여러 개입니다. 폴더까지 지정하세요: {joined}",
        error_code="ambiguous",
        data={"candidates": exc.candidates},
    )


def _note_path(args, ctx):
    """쓰기용 대상 — 기존 노트가 있으면 그 위치, 없으면 준 경로에 새로 만든다."""
    root = notes_root(args["scope"], ctx.user, ctx.settings)
    found = _resolve_note(root, args["title"])
    return root, (found or safe_join(root, f"{args['title']}.md"))


class ListNotes(SkillBase):
    name = "list_notes"
    description = (
        "노트 목록을 본다. 폴더 안 노트는 '폴더/제목' 형태로 나오며, "
        "그 값을 read_note·append_note·delete_note의 title에 그대로 쓰면 된다."
    )
    parameters = {"type": "object", "properties": {"scope": _SCOPE_PROP}, "required": ["scope"]}

    def run(self, args, ctx):
        root = notes_root(args["scope"], ctx.user, ctx.settings)
        titles = [_ident(root, p) for p in sorted(root.rglob("*.md")) if p.is_file()]
        return SkillResult(ok=True, message=f"{len(titles)}개 노트", data={"notes": titles})


class ReadNote(SkillBase):
    name = "read_note"
    description = "제목으로 노트 내용을 읽는다."
    parameters = {
        "type": "object",
        "properties": {"scope": _SCOPE_PROP, "title": _TITLE_PROP},
        "required": ["scope", "title"],
    }

    def run(self, args, ctx):
        if _is_sensitive(args["title"]):
            return SkillResult(ok=False, message="민감 노트로 판단되어 AI 읽기가 차단되었습니다.", error_code="blocked")
        root = notes_root(args["scope"], ctx.user, ctx.settings)
        try:
            target = _resolve_note(root, args["title"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        if target is None:
            return SkillResult(ok=False, message="노트를 찾을 수 없습니다.", error_code="not_found")
        return SkillResult(
            ok=True,
            message="읽기 완료",
            data={
                "title": _ident(root, target),
                "content": target.read_text(encoding="utf-8", errors="replace")[:_MAX_READ],
            },
        )


class WriteNote(SkillBase):
    name = "write_note"
    description = "노트를 만들거나 덮어쓴다(마크다운, [[위키링크]] 가능)."
    parameters = {
        "type": "object",
        "properties": {
            "scope": _SCOPE_PROP,
            "title": _TITLE_PROP,
            "content": {"type": "string"},
        },
        "required": ["scope", "title", "content"],
    }

    def run(self, args, ctx):
        try:
            root, target = _note_path(args, ctx)
        except _Ambiguous as e:
            return _ambiguous_result(e)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(args["content"], encoding="utf-8")
        ident = _ident(root, target)
        return SkillResult(ok=True, message=f"노트 '{ident}' 저장됨", data={"title": ident})


class AppendNote(SkillBase):
    name = "append_note"
    description = "기존 노트 끝에 내용을 덧붙인다(없으면 생성). 일지·목록 누적에 유용."
    parameters = {
        "type": "object",
        "properties": {
            "scope": _SCOPE_PROP,
            "title": _TITLE_PROP,
            "content": {"type": "string"},
        },
        "required": ["scope", "title", "content"],
    }

    def run(self, args, ctx):
        try:
            root, target = _note_path(args, ctx)
        except _Ambiguous as e:
            return _ambiguous_result(e)
        target.parent.mkdir(parents=True, exist_ok=True)
        title = args["title"].rsplit("/", 1)[-1]
        prev = target.read_text(encoding="utf-8", errors="replace") if target.exists() else f"# {title}\n"
        sep = "" if prev.endswith("\n") else "\n"
        target.write_text(prev + sep + args["content"] + "\n", encoding="utf-8")
        ident = _ident(root, target)
        return SkillResult(ok=True, message=f"노트 '{ident}'에 덧붙임", data={"title": ident})


class DeleteNote(SkillBase):
    name = "delete_note"
    description = "노트를 휴지통으로 보낸다(웹 휴지통에서 복구 가능)."
    parameters = {
        "type": "object",
        "properties": {"scope": _SCOPE_PROP, "title": _TITLE_PROP},
        "required": ["scope", "title"],
    }

    def run(self, args, ctx):
        root = notes_root(args["scope"], ctx.user, ctx.settings)
        try:
            target = _resolve_note(root, args["title"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        if target is None:
            return SkillResult(ok=False, message="노트를 찾을 수 없습니다.", error_code="not_found")
        ident = _ident(root, target)
        # 웹과 동일하게 휴지통 경유 — AI가 대상을 잘못 짚어도 되돌릴 수 있게.
        move_to_trash("note", args["scope"], target, to_rel(root, target), ctx.user, ctx.settings)
        return SkillResult(
            ok=True, message=f"노트 '{ident}'을(를) 휴지통으로 옮겼습니다(복구 가능).", data={"title": ident}
        )


class RenameNote(SkillBase):
    name = "rename_note"
    description = "노트 제목을 바꾼다."
    parameters = {
        "type": "object",
        "properties": {
            "scope": _SCOPE_PROP,
            "old_title": _TITLE_PROP,
            "new_title": {"type": "string", "description": "새 제목. 폴더를 적지 않으면 원래 폴더에 그대로 둔 채 이름만 바뀐다."},
        },
        "required": ["scope", "old_title", "new_title"],
    }

    def run(self, args, ctx):
        root = notes_root(args["scope"], ctx.user, ctx.settings)
        try:
            src = _resolve_note(root, args["old_title"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        if src is None:
            return SkillResult(ok=False, message="노트를 찾을 수 없습니다.", error_code="not_found")
        # 새 이름에 폴더가 없으면 이름만 바꾸고 원래 폴더에 그대로 둔다(이동 아님).
        new = args["new_title"]
        dst = safe_join(root, f"{new}.md") if "/" in new else src.parent / f"{new}.md"
        if dst.exists():
            return SkillResult(ok=False, message="같은 제목의 노트가 이미 있습니다.", error_code="exists")
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        return SkillResult(
            ok=True, message=f"'{_ident(root, src)}' → '{_ident(root, dst)}'", data={"title": _ident(root, dst)}
        )


class SearchNotes(SkillBase):
    name = "search_notes"
    description = "노트 제목·내용을 전문 검색한다."
    parameters = {
        "type": "object",
        "properties": {"scope": _SCOPE_PROP, "query": {"type": "string"}},
        "required": ["scope", "query"],
    }

    def run(self, args, ctx):
        root = notes_root(args["scope"], ctx.user, ctx.settings)
        ql = args["query"].lower()
        hits = []
        for p in sorted(root.rglob("*.md")):
            if not p.is_file():
                continue
            # 제목이 이미 맞으면 본문을 읽지 않는다(불필요한 디스크 read 제거).
            if ql not in p.stem.lower():
                if ql not in p.read_text(encoding="utf-8", errors="replace").lower():
                    continue
            # title은 read_note에 그대로 넘길 수 있는 식별자(폴더 포함)
            hits.append({"title": _ident(root, p), "path": to_rel(root, p)})
            if len(hits) >= 30:
                break
        return SkillResult(ok=True, message=f"{len(hits)}개 검색됨", data={"matches": hits})


class NoteBacklinks(SkillBase):
    name = "note_backlinks"
    description = "특정 노트를 가리키는 다른 노트들(백링크)을 찾는다."
    parameters = {
        "type": "object",
        "properties": {"scope": _SCOPE_PROP, "title": _TITLE_PROP},
        "required": ["scope", "title"],
    }

    def run(self, args, ctx):
        root = notes_root(args["scope"], ctx.user, ctx.settings)
        return SkillResult(ok=True, message="백링크 조회", data={"backlinks": backlinks_for(root, args["title"])})
