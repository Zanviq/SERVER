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
from ...json_store import lock_for, write_text_atomic
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
    """식별자 — 마크다운은 .md를 떼고, 나머지는 확장자를 유지한다.

    단, 확장자를 뗀 이름의 파일이 실제로 옆에 있으면 떼지 않는다.
    `메모`와 `메모.md`가 함께 있으면 둘 다 식별자가 `메모`가 되어, 목록에 같은
    값이 두 번 나오고 _resolve는 확장자 없는 쪽을 먼저 집어 .md 문서에 영영
    도달할 수 없었다(확장자 없는 파일 생성을 허용하면서 실제로 닿는 경로가 됐다).
    """
    rel = to_rel(root, p)
    if rel.endswith(".md") and not (root / rel[:-3]).exists():
        return rel[:-3]
    return rel


class _Ambiguous(Exception):
    """같은 이름의 문서가 여러 폴더에 있어 대상을 특정할 수 없음."""

    def __init__(self, root: Path, hits: list):
        self.candidates = [_ident(root, p) for p in hits]


def _find_by_name(root: Path, ident: str, *, editable_only: bool = False) -> list:
    """폴더를 생략한 이름으로 전체에서 찾는다(모델이 흔히 이름만 준다).

    이름을 glob 패턴에 끼워 넣지 않는다 — '*'·'[' 가 든 이름의 오매칭 방지.
    """
    name = ident.rsplit("/", 1)[-1]
    stem = name[:-3] if name.endswith(".md") else name
    out = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if editable_only and not is_editable(p.name):
            continue  # 쓰기 대상 탐색에서는 이미지·PDF를 후보로 삼지 않는다
        if p.name == name or p.stem == stem:
            out.append(p)
    return sorted(out)


def _resolve(root: Path, ident: str, *, editable_only: bool = False):
    """식별자 → 실제 파일. 없으면 None, 후보가 여럿이면 _Ambiguous.

    **폴더를 명시했으면 이름 검색으로 넘어가지 않는다.** 예전에는 `업무/보고서`가
    없으면 트리 전체에서 `보고서`를 찾아 `개인/보고서.md`를 돌려줬고, 그게
    쓰기 대상이 되어 엉뚱한 폴더의 문서를 통째로 덮어썼다(덮어쓰기는 휴지통을
    거치지 않아 복구 불가였다). 삭제·이동·이름변경도 같은 경로를 탄다.
    """
    for cand in (ident, f"{ident}.md"):
        p = safe_join(root, cand)
        if p.is_file():
            return p
    if "/" in ident.strip("/"):
        return None  # 폴더까지 지정했는데 없다 = 없는 것이다
    hits = _find_by_name(root, ident, editable_only=editable_only)
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


def _backup_before_overwrite(root: Path, target: Path, ctx) -> None:
    """덮어쓰기 전 이전 내용을 휴지통에 넣는다(사본을 만들어 옮긴다).

    원본을 그대로 옮기면 그 자리에 파일이 없어지므로, 중간에 실패하면 문서가
    통째로 사라진다. 사본을 만들어 그것만 휴지통에 넣는다.
    """
    import shutil
    import tempfile

    rel = to_rel(root, target)
    tmp_dir = Path(tempfile.mkdtemp(prefix="ovw_", dir=str(target.parent)))
    try:
        copy = tmp_dir / target.name
        shutil.copy2(target, copy)
        move_to_trash(copy, rel, ctx.user, ctx.settings)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


_EXT_RE = __import__("re").compile(r"\.[A-Za-z0-9]{1,8}$")


def _has_extension(name: str) -> bool:
    """진짜 확장자인가.

    Path.suffix는 'v1.2 회의록'의 suffix를 '.2 회의록'으로 준다. 그걸 확장자로
    믿으면 .md를 안 붙여 확장자 없는 파일이 만들어지고, kind_of가 'other'로
    분류해 다시 열 수도 없는 문서가 된다.
    """
    return bool(_EXT_RE.search(name.rsplit("/", 1)[-1]))


def _target_for_write(root: Path, ident: str) -> Path:
    """쓰기 대상 — 기존 문서가 있으면 그 위치, 없으면 준 경로에 새로 만든다."""
    # 쓰기 후보는 편집 가능한 문서만. 예전에는 `사진/여행.png` 하나 때문에
    # 새 노트 `여행`을 아예 만들 수 없었다("텍스트 문서만 편집할 수 있습니다").
    found = _resolve(root, ident, editable_only=True)
    if found:
        return found
    rel = ident if _has_extension(ident) else f"{ident}.md"
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


class ListFolders(SkillBase):
    name = "list_folders"
    description = (
        "폴더 목록을 본다. 문서를 어디에 만들지 정하기 전에 확인하면 "
        "오타로 새 폴더가 생기는 것을 막을 수 있다(빈 폴더는 문서 목록에 안 나온다)."
    )
    parameters = {"type": "object", "properties": {}}

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        folders = sorted(
            to_rel(root, p) for p in root.rglob("*") if p.is_dir()
        )
        return SkillResult(
            ok=True,
            message=f"{len(folders)}개 폴더",
            data={"folders": folders},
        )


class ReadDocument(SkillBase):
    name = "read_document"
    description = "텍스트·마크다운 문서의 내용을 읽는다. 이미지·PDF는 읽을 수 없다."
    parameters = {
        "type": "object",
        "properties": {"path": _PATH_PROP},
        "required": ["path"],
    }

    _BLOCKED = "민감 문서로 판단되어 AI 읽기가 차단되었습니다."

    def run(self, args, ctx):
        # 요청 문자열로 한 번 — 없는 경로라도 막아서 존재 여부를 흘리지 않는다.
        if _is_sensitive(args["path"]):
            return SkillResult(ok=False, message=self._BLOCKED, error_code="blocked")
        root = user_data_root(ctx.user, ctx.settings)
        try:
            target = _resolve(root, args["path"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        if target is None:
            return SkillResult(ok=False, message="문서를 찾을 수 없습니다.", error_code="not_found")
        # 해석된 **실제 경로**로 한 번 더. 요청 문자열만 보면 `비밀/일기`는 막히는데
        # `일기`는 통과해 같은 파일이 그대로 읽혔다 — 스킬 설명이 "이름만 줘도 된다"고
        # 안내하므로 이 우회는 공격이 아니라 모델의 정상 동작이었다.
        if _is_sensitive(to_rel(root, target)):
            return SkillResult(ok=False, message=self._BLOCKED, error_code="blocked")
        if not is_editable(target.name):
            return SkillResult(
                ok=False,
                message=f"'{kind_of(target.name)}' 파일이라 내용을 읽을 수 없습니다.",
                error_code="unsupported",
            )
        full = target.read_text(encoding="utf-8", errors="replace")
        content = full[:_MAX_READ]
        truncated = len(full) > _MAX_READ
        # 잘렸다는 사실을 반드시 알린다. 예전에는 조용히 잘라 줘서, 모델이 그걸
        # 전문으로 믿고 write_document로 되쓰면 뒷부분이 영구히 사라졌다.
        return SkillResult(
            ok=True,
            message=(
                f"읽기 완료 — 전체 {len(full)}자 중 앞 {len(content)}자만 읽었습니다. "
                "이 내용으로 문서를 덮어쓰면 나머지가 사라집니다."
                if truncated
                else "읽기 완료"
            ),
            data={
                "path": _ident(root, target),
                "content": content,
                "truncated": truncated,
                "total_chars": len(full),
                "read_chars": len(content),
            },
        )


class WriteDocument(SkillBase):
    mutates = "documents"
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

        # 덮어쓰기는 이 시스템에서 가장 되돌리기 어려운 동작이었다 — 삭제는 휴지통을
        # 거치는데 덮어쓰기만 아무 흔적도 안 남겼다. 이전 내용을 휴지통에 넣어
        # restore_from_trash로 되돌릴 수 있게 한다.
        backed_up = False
        backup_failed = False
        # 같은 문서에 대한 다른 쓰기(UI 자동저장 등)와 겹치지 않게 직렬화한다
        with lock_for(target):
            if target.exists() and target.read_text(encoding="utf-8", errors="replace") != args["content"]:
                try:
                    _backup_before_overwrite(root, target, ctx)
                    backed_up = True
                except Exception:  # noqa: BLE001 - 백업 실패가 저장을 막지는 않는다
                    backup_failed = True
            write_text_atomic(target, args["content"])
        ident = _ident(root, target)
        msg = f"'{ident}' 저장됨"
        if backed_up:
            msg += " (이전 내용은 휴지통에 있습니다)"
        elif backup_failed:
            # 백업 실패를 '백업 불필요'와 같이 취급하면 안 된다 — 되돌릴 수 없는 상태다
            msg += " (경고: 이전 내용을 휴지통에 남기지 못했습니다)"
        return SkillResult(
            ok=True, message=msg,
            data={"path": ident, "backed_up": backed_up, "backup_failed": backup_failed},
        )


class AppendDocument(SkillBase):
    mutates = "documents"
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
        # 읽고-고쳐-쓰기라 락이 없으면 동시에 들어온 덧붙이기가 서로를 덮어쓴다
        # (실측: 락 없이 동시 20건 중 2건만 남았다).
        with lock_for(target):
            prev = target.read_text(encoding="utf-8", errors="replace") if target.exists() else f"# {title}\n"
            sep = "" if prev.endswith("\n") else "\n"
            write_text_atomic(target, prev + sep + args["content"] + "\n")
        ident = _ident(root, target)
        return SkillResult(ok=True, message=f"'{ident}'에 덧붙임", data={"path": ident})


class DeleteDocument(SkillBase):
    mutates = "documents"
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
    mutates = "documents"
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
    mutates = "documents"
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
    mutates = "documents"
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
