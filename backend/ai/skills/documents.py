"""문서 스킬 — 사용자 문서 공간 하나를 다룬다.

2026-08 개편 전에는 파일 스킬(list_files/read_file/…)과 노트 스킬
(list_notes/read_note/…)이 따로 있었고 `scope`(common|me)로 위치를 골랐다.
저장소가 하나로 합쳐지면서 두 벌이 같은 것을 가리키게 되어, 모델이 어느 쪽을
쓸지 헷갈리는 원인이 됐다. 하나로 통합한다.

**식별자 규약**: 문서 루트 기준 상대경로. 마크다운은 확장자를 생략해도 되고
(`업무/주간보고`), 그 외 파일은 확장자를 포함한다(`사진/여행.png`).
list·search가 준 값을 다른 스킬에 그대로 넘길 수 있다.
"""
from __future__ import annotations

from pathlib import Path

from ...file_kinds import is_editable, kind_of
from ...notes_graph import backlinks_for
from ...security_paths import safe_join, to_rel
from ...storage import user_data_root
from ...trash import move_to_trash
from ..skill_base import SkillBase, SkillResult
from ._common import _MAX_READ, _is_sensitive

_PATH_PROP = {
    "type": "string",
    "description": (
        "문서 식별자(문서 루트 기준 상대경로). list_documents·search_documents가 준 값을 "
        "그대로 쓰면 된다. 마크다운은 확장자 생략 가능('업무/주간보고'), 그 외는 포함('사진/a.png'). "
        "폴더를 빼고 이름만 줘도 유일하면 찾아준다."
    ),
}


def _ident(root: Path, p: Path) -> str:
    """식별자 — 마크다운은 .md를 떼고, 나머지는 확장자를 유지한다."""
    rel = to_rel(root, p)
    return rel[:-3] if rel.endswith(".md") else rel


class _Ambiguous(Exception):
    """같은 이름의 문서가 여러 폴더에 있어 대상을 특정할 수 없음."""

    def __init__(self, root: Path, hits: list):
        self.candidates = [_ident(root, p) for p in hits]


def _find_by_name(root: Path, ident: str) -> list:
    """폴더를 생략한 이름으로 전체에서 찾는다(모델이 흔히 이름만 준다).

    이름을 glob 패턴에 끼워 넣지 않는다 — '*'·'[' 가 든 이름의 오매칭 방지.
    """
    name = ident.rsplit("/", 1)[-1]
    stem = name[:-3] if name.endswith(".md") else name
    out = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.name == name or p.stem == stem:
            out.append(p)
    return sorted(out)


def _resolve(root: Path, ident: str):
    """식별자 → 실제 파일. 없으면 None, 후보가 여럿이면 _Ambiguous."""
    for cand in (ident, f"{ident}.md"):
        p = safe_join(root, cand)
        if p.is_file():
            return p
    hits = _find_by_name(root, ident)
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        raise _Ambiguous(root, hits)
    return None


def _ambiguous_result(exc: _Ambiguous) -> SkillResult:
    joined = ", ".join(exc.candidates)
    return SkillResult(
        ok=False,
        message=f"같은 이름의 문서가 여러 개입니다. 폴더까지 지정하세요: {joined}",
        error_code="ambiguous",
        data={"candidates": exc.candidates},
    )


def _target_for_write(root: Path, ident: str) -> Path:
    """쓰기 대상 — 기존 문서가 있으면 그 위치, 없으면 준 경로에 새로 만든다."""
    found = _resolve(root, ident)
    if found:
        return found
    rel = ident if Path(ident).suffix else f"{ident}.md"
    return safe_join(root, rel)


class ListDocuments(SkillBase):
    name = "list_documents"
    description = (
        "문서 목록을 본다(마크다운·텍스트·이미지·PDF 등 전부). 폴더 안 문서는 "
        "'폴더/이름' 형태로 나오며, 그 값을 다른 스킬의 path에 그대로 쓰면 된다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "folder": {"type": "string", "description": "이 폴더 아래만 보기(생략 시 전체)"}
        },
    }

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        base = safe_join(root, args.get("folder") or "")
        if not base.is_dir():
            return SkillResult(ok=False, message="폴더를 찾을 수 없습니다.", error_code="not_found")
        items = [
            {"path": _ident(root, p), "kind": kind_of(p.name), "size": p.stat().st_size}
            for p in sorted(base.rglob("*"))
            if p.is_file()
        ]
        return SkillResult(ok=True, message=f"{len(items)}개 문서", data={"documents": items})


class ReadDocument(SkillBase):
    name = "read_document"
    description = "텍스트·마크다운 문서의 내용을 읽는다. 이미지·PDF는 읽을 수 없다."
    parameters = {
        "type": "object",
        "properties": {"path": _PATH_PROP},
        "required": ["path"],
    }

    def run(self, args, ctx):
        if _is_sensitive(args["path"]):
            return SkillResult(ok=False, message="민감 문서로 판단되어 AI 읽기가 차단되었습니다.", error_code="blocked")
        root = user_data_root(ctx.user, ctx.settings)
        try:
            target = _resolve(root, args["path"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        if target is None:
            return SkillResult(ok=False, message="문서를 찾을 수 없습니다.", error_code="not_found")
        if not is_editable(target.name):
            return SkillResult(
                ok=False,
                message=f"'{kind_of(target.name)}' 파일이라 내용을 읽을 수 없습니다.",
                error_code="unsupported",
            )
        return SkillResult(
            ok=True,
            message="읽기 완료",
            data={
                "path": _ident(root, target),
                "content": target.read_text(encoding="utf-8", errors="replace")[:_MAX_READ],
            },
        )


class WriteDocument(SkillBase):
    name = "write_document"
    description = "문서를 만들거나 덮어쓴다(마크다운, [[위키링크]] 가능). 확장자를 안 적으면 .md."
    parameters = {
        "type": "object",
        "properties": {"path": _PATH_PROP, "content": {"type": "string"}},
        "required": ["path", "content"],
    }

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        try:
            target = _target_for_write(root, args["path"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        if target.exists() and not is_editable(target.name):
            return SkillResult(ok=False, message="텍스트 문서만 편집할 수 있습니다.", error_code="unsupported")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(args["content"], encoding="utf-8")
        ident = _ident(root, target)
        return SkillResult(ok=True, message=f"'{ident}' 저장됨", data={"path": ident})


class AppendDocument(SkillBase):
    name = "append_document"
    description = "기존 문서 끝에 내용을 덧붙인다(없으면 생성). 일지·목록 누적에 유용."
    parameters = {
        "type": "object",
        "properties": {"path": _PATH_PROP, "content": {"type": "string"}},
        "required": ["path", "content"],
    }

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        try:
            target = _target_for_write(root, args["path"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        if target.exists() and not is_editable(target.name):
            return SkillResult(ok=False, message="텍스트 문서만 편집할 수 있습니다.", error_code="unsupported")
        target.parent.mkdir(parents=True, exist_ok=True)
        title = args["path"].rsplit("/", 1)[-1]
        prev = target.read_text(encoding="utf-8", errors="replace") if target.exists() else f"# {title}\n"
        sep = "" if prev.endswith("\n") else "\n"
        target.write_text(prev + sep + args["content"] + "\n", encoding="utf-8")
        ident = _ident(root, target)
        return SkillResult(ok=True, message=f"'{ident}'에 덧붙임", data={"path": ident})


class DeleteDocument(SkillBase):
    name = "delete_document"
    description = "문서나 폴더를 휴지통으로 보낸다(웹 휴지통에서 복구 가능)."
    parameters = {
        "type": "object",
        "properties": {"path": _PATH_PROP},
        "required": ["path"],
    }

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        try:
            target = _resolve(root, args["path"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        if target is None:
            # 폴더일 수도 있다
            folder = safe_join(root, args["path"])
            if folder.is_dir() and folder != root:
                rel = to_rel(root, folder)
                move_to_trash(folder, rel, ctx.user, ctx.settings)
                return SkillResult(ok=True, message=f"폴더 '{rel}'을(를) 휴지통으로 옮겼습니다.", data={"path": rel})
            return SkillResult(ok=False, message="문서를 찾을 수 없습니다.", error_code="not_found")
        ident = _ident(root, target)
        move_to_trash(target, to_rel(root, target), ctx.user, ctx.settings)
        return SkillResult(ok=True, message=f"'{ident}'을(를) 휴지통으로 옮겼습니다(복구 가능).", data={"path": ident})


class RenameDocument(SkillBase):
    name = "rename_document"
    description = "문서 이름을 바꾼다(같은 폴더 유지)."
    parameters = {
        "type": "object",
        "properties": {
            "path": _PATH_PROP,
            "new_name": {"type": "string", "description": "새 이름. 확장자를 안 적으면 원래 확장자를 유지한다."},
        },
        "required": ["path", "new_name"],
    }

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        try:
            src = _resolve(root, args["path"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        if src is None:
            return SkillResult(ok=False, message="문서를 찾을 수 없습니다.", error_code="not_found")
        new = (args["new_name"] or "").strip()
        if not new or "/" in new or ".." in new:
            return SkillResult(ok=False, message="잘못된 이름입니다.", error_code="invalid")
        if not Path(new).suffix:
            new = f"{new}{src.suffix}"
        dst = src.parent / new
        if dst.exists():
            return SkillResult(ok=False, message="같은 이름의 문서가 이미 있습니다.", error_code="exists")
        src.rename(dst)
        return SkillResult(
            ok=True, message=f"'{_ident(root, src)}' → '{_ident(root, dst)}'", data={"path": _ident(root, dst)}
        )


class MoveDocument(SkillBase):
    name = "move_document"
    description = "문서를 다른 폴더로 옮긴다(이름 유지)."
    parameters = {
        "type": "object",
        "properties": {
            "path": _PATH_PROP,
            "target_folder": {"type": "string", "description": "대상 폴더 상대경로. 빈 값이면 루트."},
        },
        "required": ["path", "target_folder"],
    }

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        try:
            src = _resolve(root, args["path"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        if src is None:
            return SkillResult(ok=False, message="문서를 찾을 수 없습니다.", error_code="not_found")
        folder = (args.get("target_folder") or "").strip().strip("/")
        dst = safe_join(root, f"{folder}/{src.name}" if folder else src.name)
        if dst == src:
            return SkillResult(ok=True, message="이미 그 위치입니다.", data={"path": _ident(root, src)})
        if dst.exists():
            return SkillResult(ok=False, message="대상 폴더에 같은 이름의 문서가 있습니다.", error_code="exists")
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        return SkillResult(ok=True, message=f"'{_ident(root, dst)}'로 이동", data={"path": _ident(root, dst)})


class CreateFolder(SkillBase):
    name = "create_folder"
    description = "새 폴더를 만든다."
    parameters = {
        "type": "object",
        "properties": {"path": {"type": "string", "description": "문서 루트 기준 상대경로"}},
        "required": ["path"],
    }

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        target = safe_join(root, args["path"])
        if target == root:
            return SkillResult(ok=False, message="폴더 이름이 비어 있습니다.", error_code="invalid")
        if target.exists():
            return SkillResult(ok=False, message="이미 존재합니다.", error_code="exists")
        target.mkdir(parents=True)
        return SkillResult(ok=True, message=f"폴더 생성: {to_rel(root, target)}", data={"path": to_rel(root, target)})


class SearchDocuments(SkillBase):
    name = "search_documents"
    description = "문서 이름·내용을 검색한다. 이미지·PDF는 이름으로만 찾는다."
    parameters = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }

    _LIMIT = 30

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        ql = args["query"].lower()
        hits = []
        for p in sorted(root.rglob("*")):
            if not p.is_file():
                continue
            name_hit = ql in p.name.lower()
            if not is_editable(p.name):
                if name_hit:
                    hits.append({"path": _ident(root, p), "kind": kind_of(p.name)})
            else:
                # 이름이 이미 맞으면 본문을 읽지 않는다(불필요한 디스크 read 제거)
                if name_hit or ql in p.read_text(encoding="utf-8", errors="replace").lower():
                    hits.append({"path": _ident(root, p), "kind": kind_of(p.name)})
            if len(hits) >= self._LIMIT:
                break
        return SkillResult(ok=True, message=f"{len(hits)}개 검색됨", data={"matches": hits})


class DocumentBacklinks(SkillBase):
    name = "document_backlinks"
    description = "특정 문서를 [[위키링크]]로 가리키는 다른 문서들을 찾는다."
    parameters = {
        "type": "object",
        "properties": {"path": _PATH_PROP},
        "required": ["path"],
    }

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        title = args["path"].rsplit("/", 1)[-1]
        if title.endswith(".md"):
            title = title[:-3]
        return SkillResult(ok=True, message="백링크 조회", data={"backlinks": backlinks_for(root, title)})
