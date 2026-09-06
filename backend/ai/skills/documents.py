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

from ... import doc_cache
from ...file_kinds import is_editable, kind_of, looks_like_extension
from ...json_store import lock_for, write_text_atomic
from ...notes_graph import backlinks_for
from ...security_paths import safe_join, to_rel
from ...storage import user_data_root, walk_all, walk_dirs, walk_files
from ...trash import move_to_trash
from ..skill_base import SkillBase, SkillResult
from ._common import _MAX_READ, _is_sensitive

#: 한 번에 모델에게 보여줄 문서·폴더 수 상한
_MAX_DOCS = 200

_PATH_PROP = {
    "type": "string",
    "description": (
        "문서 식별자(문서 루트 기준 상대경로). list_documents·search_documents가 준 값을 "
        "그대로 쓰면 된다. 마크다운은 확장자 생략 가능('업무/주간보고'), 그 외는 포함('사진/a.png'). "
        "폴더를 빼고 이름만 줘도 유일하면 찾아준다."
    ),
}


def _ident_rel(rel: str, known: set[str]) -> str:
    """이미 상대경로를 알고 있을 때의 식별자(파일시스템을 건드리지 않는다)."""
    if not rel.endswith(".md"):
        return rel
    stem = rel[:-3]
    return rel if stem in known else stem


def _ident(root: Path, p: Path, known: set[str] | None = None) -> str:
    """식별자 — 마크다운은 .md를 떼고, 나머지는 확장자를 유지한다.

    단, 확장자를 뗀 이름의 파일이 실제로 옆에 있으면 떼지 않는다.
    `메모`와 `메모.md`가 함께 있으면 둘 다 식별자가 `메모`가 되어, 목록에 같은
    값이 두 번 나오고 _resolve는 확장자 없는 쪽을 먼저 집어 .md 문서에 영영
    도달할 수 없었다(확장자 없는 파일 생성을 허용하면서 실제로 닿는 경로가 됐다).

    `known`은 이미 알고 있는 상대경로 집합이다. 목록·검색처럼 트리를 이미
    걷고 있는 쪽은 이걸 넘겨라 — 안 넘기면 **마크다운 파일마다 exists() 스탯이
    한 번씩** 나간다(문서 200개에서 list_documents가 114ms였다).
    """
    rel = to_rel(root, p)
    if not rel.endswith(".md"):
        return rel
    stem = rel[:-3]
    sibling = (stem in known) if known is not None else (root / stem).exists()
    return rel if sibling else stem


class _Ambiguous(Exception):
    """같은 이름의 문서가 여러 폴더에 있어 대상을 특정할 수 없음."""

    def __init__(self, root: Path, hits: list):
        self.candidates = [_ident(root, p) for p in hits]


class _IsFolder(Exception):
    """식별자가 문서가 아니라 폴더를 가리킨다.

    list_folders 가 준 값을 그대로 문서 스킬에 넘기는 일이 실제로 일어난다.
    조용히 `<이름>.md` 로 바꿔 읽으면 **지목하지 않은 문서**가 사라진다
    (폴더는 그대로 남은 채 "지웠습니다"라고 답했다 — 실측).

    `twin` 은 같은 이름의 문서가 함께 있을 때 그 상대경로다. 그때는 무엇을
    말한 것인지 알 수 없으므로 되물어야 한다.
    """

    def __init__(self, ident: str, twin: str | None = None):
        self.ident = ident
        self.twin = twin


def _folder_result(exc: _IsFolder) -> SkillResult:
    if exc.twin:
        return SkillResult(
            ok=False,
            message=(
                f"'{exc.ident}' 이름의 폴더와 문서가 둘 다 있습니다. "
                f"문서를 말한 것이면 '{exc.twin}' 처럼 확장자까지 적으세요."
            ),
            error_code="ambiguous",
            data={"folder": exc.ident, "document": exc.twin},
        )
    return SkillResult(
        ok=False,
        message=(
            f"'{exc.ident}'은(는) 폴더입니다. 이 스킬은 문서만 다룹니다. "
            f"폴더 안의 문서를 지정하려면 '{exc.ident}/문서이름' 처럼 적으세요."
        ),
        error_code="is_folder",
        data={"folder": exc.ident},
    )


def _find_by_name(root: Path, ident: str, *, editable_only: bool = False) -> list:
    """폴더를 생략한 이름으로 전체에서 찾는다(모델이 흔히 이름만 준다).

    이름을 glob 패턴에 끼워 넣지 않는다 — '*'·'[' 가 든 이름의 오매칭 방지.
    """
    name = ident.rsplit("/", 1)[-1]
    stem = name[:-3] if name.endswith(".md") else name
    out = []
    for f in walk_files(root):
        if editable_only and not is_editable(f.name):
            continue  # 쓰기 대상 탐색에서는 이미지·PDF를 후보로 삼지 않는다
        fname = f.name
        fstem = fname[:-3] if fname.endswith(".md") else fname
        if fname == name or fstem == stem:
            out.append(f.path)
    return out


def _resolve(root: Path, ident: str, *, editable_only: bool = False):
    """식별자 → 실제 파일. 없으면 None, 후보가 여럿이면 _Ambiguous.

    **폴더를 명시했으면 이름 검색으로 넘어가지 않는다.** 예전에는 `업무/보고서`가
    없으면 트리 전체에서 `보고서`를 찾아 `개인/보고서.md`를 돌려줬고, 그게
    쓰기 대상이 되어 엉뚱한 폴더의 문서를 통째로 덮어썼다(덮어쓰기는 휴지통을
    거치지 않아 복구 불가였다). 삭제·이동·이름변경도 같은 경로를 탄다.
    """
    # **폴더 이름을 문서로 해석하지 않는다.** list_folders 가 준 식별자(`회의록`)를
    # 그대로 넘기면 예전에는 `회의록.md` 를 찾아 **지목하지 않은 문서**를 휴지통에
    # 보내고, 폴더는 그대로 남긴 채 "지웠습니다"라고 답했다(실측).
    if safe_join(root, ident).is_dir():
        twin = next((c for c in (ident, f"{ident}.md") if safe_join(root, c).is_file()), None)
        raise _IsFolder(ident, twin)
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


#: 확장자로 볼 꼬리. **글자가 하나는 있어야 한다** — 숫자만이면 확장자가 아니라
#: '2026.08'·'v1.2'·'예산 1.5' 같은 날짜·버전이다. 예전 규칙은 이것들을 확장자로
#: 보고 .md를 안 붙여, kind가 'other'인 파일을 만든 뒤 다시 읽지 못했다.
#: 확장자 판정은 file_kinds 한 곳에서만 한다.
#: 같은 정규식이 세 파일에 복사돼 있었고, 네 번째 자리(휴지통 복원)가 다른 규칙을
#: 쓰는 바람에 `2026.08 회고` 의 이름이 망가졌다.
_has_extension = looks_like_extension


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
        import datetime as _dt

        # 트리를 한 번만 걷는다(stat 은 순회에 딸려온다). 그 결과를 _ident 에
        # 넘겨 파일당 추가 스탯도 없앤다.
        prefix = to_rel(root, base)
        prefix = "" if prefix in ("", ".") else f"{prefix}/"
        files, dirs = walk_all(base)
        # 폴더도 함께 넣는다. 폴더 `보고서` 와 문서 `보고서.md` 가 같이 있으면
        # 문서를 `보고서` 로 내보내게 되어 폴더 식별자와 겹치고, 그 값으로 부른
        # 삭제·이동이 폴더 대신 문서를 건드린다(폴더는 영영 못 지운다).
        known = {f"{prefix}{f.rel}" for f in files} | {f"{prefix}{d}" for d in dirs}
        items = []
        for f in files:
            rel = f"{prefix}{f.rel}"
            items.append({
                "path": _ident_rel(rel, known),
                "kind": kind_of(f.name),
                "size": f.stat.st_size,
                # 수정시각이 없으면 "최근 문서", "안 쓰는 문서" 같은 요청을
                # 아예 수행할 수 없다(모델이 짐작으로 답하게 된다).
                "modified": _dt.datetime.fromtimestamp(f.stat.st_mtime).strftime("%Y-%m-%dT%H:%M:%S"),
            })
        total = len(items)
        items.sort(key=lambda d: d["modified"], reverse=True)
        shown = items[:_MAX_DOCS]
        data: dict = {"documents": shown}
        msg = f"{total}개 문서"
        if total > _MAX_DOCS:
            data["truncated"] = True
            data["total"] = total
            msg += f" (최근 {_MAX_DOCS}개만 표시 — folder로 좁히거나 search_documents를 쓰세요)"
        return SkillResult(ok=True, message=msg, data=data)


class ListFolders(SkillBase):
    name = "list_folders"
    description = (
        "폴더 목록을 본다. 문서를 어디에 만들지 정하기 전에 확인하면 "
        "오타로 새 폴더가 생기는 것을 막을 수 있다(빈 폴더는 문서 목록에 안 나온다)."
    )
    parameters = {"type": "object", "properties": {}}

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        folders = walk_dirs(root)
        total = len(folders)
        data: dict = {"folders": folders[:_MAX_DOCS]}
        msg = f"{total}개 폴더"
        if total > _MAX_DOCS:
            data["truncated"] = True
            data["total"] = total
            msg += f" ({_MAX_DOCS}개만 표시)"
        return SkillResult(ok=True, message=msg, data=data)


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
        except _IsFolder as e:
            return _folder_result(e)
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
        # 범용 줄바꿈 변환을 피한다 — 읽어서 그대로 되쓰는 흐름(read → write)에서
        # `\r\n` 이 조용히 `\n` 으로 바뀌어 저장된다.
        full = target.read_bytes().decode("utf-8", errors="replace")
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
    description = (
        "문서를 만들거나 덮어쓴다(마크다운, [[위키링크]] 가능). 확장자를 안 적으면 .md. "
        "**끝에 무언가를 더하는 것이라면 append_document 를 쓰세요** — 이건 통째로 바꿉니다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": _PATH_PROP,
            "content": {"type": "string"},
            "shorten": {
                "type": "boolean",
                "description": "긴 문서를 일부러 짧게 줄이는 경우에만 true. 기본 false.",
            },
        },
        "required": ["path", "content"],
    }

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        try:
            target = _target_for_write(root, args["path"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        except _IsFolder as e:
            return _folder_result(e)
        if not is_editable(target.name):
            # 있는 파일만 보던 검사였다. 그러면 `보고서.xyz` 처럼 모르는 확장자로
            # **새로** 만드는 것은 통과해서, 다시 읽지도 덧붙이지도 못하는 문서를
            # 만들어 놓고 "저장됨"이라고 답하게 된다.
            what = "텍스트 문서만 편집할 수 있습니다."
            if not target.exists():
                what += f" '{target.name}' 대신 .md 나 .txt 로 이름을 지어 주세요."
            return SkillResult(ok=False, message=what, error_code="unsupported")
        target.parent.mkdir(parents=True, exist_ok=True)

        # 빈 문서를 만들지 않는다. 모델이 "먼저 빈 파일을 만들고 나중에 채우겠다"
        # 하고 내용 없이 부르는 일이 있는데(실측), 그러면 목록에 0바이트 문서가
        # 남는다. 위키링크로 만들어지는 문서와 같은 규칙으로 제목 한 줄을 넣는다.
        if not str(args.get("content") or "").strip() and not target.exists():
            args = dict(args)
            args["content"] = f"# {target.stem}\n"

        # 덮어쓰기는 이 시스템에서 가장 되돌리기 어려운 동작이었다 — 삭제는 휴지통을
        # 거치는데 덮어쓰기만 아무 흔적도 안 남겼다. 이전 내용을 휴지통에 넣어
        # restore_from_trash로 되돌릴 수 있게 한다.
        backed_up = False
        backup_failed = False
        # 같은 문서에 대한 다른 쓰기(UI 자동저장 등)와 겹치지 않게 직렬화한다
        with lock_for(target):
            prev = target.read_text(encoding="utf-8", errors="replace") if target.exists() else None
            # read_document 는 앞 _MAX_READ 자만 준다. 모델이 그걸 전문으로 믿고
            # 손봐서 되쓰면 뒷부분이 통째로 날아간다 — "나머지가 사라집니다" 라고
            # 알려 주기는 하지만, 그건 부탁이지 잠금장치가 아니다. 한도보다 긴 글이
            # 한도 아래로 줄어드는 것은 그 사고의 정확한 모양이므로 여기서 막고,
            # **정말 줄이려는 것이면** shorten=true 로 한 번 더 부르게 한다.
            if prev is not None and not args.get("shorten"):
                if len(prev) > _MAX_READ >= len(args["content"]):
                    return SkillResult(
                        ok=False,
                        error_code="would_truncate",
                        message=(
                            f"'{args['path']}' 는 {len(prev)}자인데 {len(args['content'])}자로 "
                            f"덮으려 했습니다. read_document 는 앞 {_MAX_READ}자만 주므로, "
                            "읽은 만큼만 되쓰면 뒷부분이 사라집니다. 끝에 더하는 것이면 "
                            "append_document 를, 정말로 줄이는 것이면 shorten=true 로 다시 부르세요."
                        ),
                        data={"path": _ident(root, target), "total_chars": len(prev)},
                    )
            if prev is not None and prev != args["content"]:
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
        except _IsFolder as e:
            return _folder_result(e)
        if not is_editable(target.name):
            # 있는 파일만 보던 검사였다. 그러면 `보고서.xyz` 처럼 모르는 확장자로
            # **새로** 만드는 것은 통과해서, 다시 읽지도 덧붙이지도 못하는 문서를
            # 만들어 놓고 "저장됨"이라고 답하게 된다.
            what = "텍스트 문서만 편집할 수 있습니다."
            if not target.exists():
                what += f" '{target.name}' 대신 .md 나 .txt 로 이름을 지어 주세요."
            return SkillResult(ok=False, message=what, error_code="unsupported")
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
        except _IsFolder as e:
            # **이 스킬은 폴더도 지운다**(설명에 그렇게 적혀 있다). 다만 같은
            # 이름의 문서가 함께 있으면 무엇을 말한 것인지 알 수 없으므로 되묻는다 —
            # 예전에는 말없이 문서 쪽을 지우고 폴더는 그대로 뒀다.
            if e.twin:
                return _folder_result(e)
            folder = safe_join(root, e.ident)
            if folder == root:
                return SkillResult(ok=False, message="루트는 지울 수 없습니다.", error_code="invalid")
            rel = to_rel(root, folder)
            move_to_trash(folder, rel, ctx.user, ctx.settings)
            return SkillResult(ok=True, message=f"폴더 '{rel}'을(를) 휴지통으로 옮겼습니다.",
                               data={"path": rel})
        if target is None:
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
        except _IsFolder as e:
            return _folder_result(e)
        if src is None:
            return SkillResult(ok=False, message="문서를 찾을 수 없습니다.", error_code="not_found")
        new = (args["new_name"] or "").strip()
        if not new or "/" in new or ".." in new:
            return SkillResult(ok=False, message="잘못된 이름입니다.", error_code="invalid")
        # Path(...).suffix를 쓰면 '월간정리 2026.08'의 '.08'을 확장자로 봐서
        # 원래 .md를 안 붙인다 → kind가 'other'가 되어 이름만 바꿔도 못 읽는
        # 문서가 된다. 쓰기 경로와 같은 판정을 쓴다.
        if not _has_extension(new):
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
        except _IsFolder as e:
            return _folder_result(e)
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
    #: 본문 검색 대상 크기 상한. 큰 파일을 통째로 메모리에 올리지 않는다.
    _MAX_SCAN_BYTES = 1_000_000

    def run(self, args, ctx):
        root = user_data_root(ctx.user, ctx.settings)
        ql = args["query"].lower()
        # 순회 한 번에 stat 까지 받아 둔다. 상한(_LIMIT)에서 끊더라도 순회 자체는
        # 싸다(scandir) — 대신 본문 읽기는 필요한 것만 한다.
        files, dirs = walk_all(root)
        known = {f.rel for f in files} | set(dirs)
        hits = []
        scanned = 0
        for f in files:
            scanned += 1
            rel = f.rel
            name_hit = ql in f.name.lower()
            # 민감 문서는 **본문을 읽지 않는다**. 읽어서 매칭하고 경로만 돌려줘도
            # "그 문서에 이 단어가 있다"를 알려주는 셈이라 차단이 무의미해진다.
            if _is_sensitive(rel) or not is_editable(f.name):
                if name_hit:
                    hits.append({"path": _ident_rel(rel, known), "kind": kind_of(f.name)})
            elif name_hit:
                hits.append({"path": _ident_rel(rel, known), "kind": kind_of(f.name)})
            else:
                if f.stat.st_size > self._MAX_SCAN_BYTES:
                    continue
                text = doc_cache.text_of(f.path, f.stat)  # 두 번째부터는 안 읽는다
                if text is not None and ql in text.lower():
                    hits.append({"path": _ident_rel(rel, known), "kind": kind_of(f.name)})
            if len(hits) >= self._LIMIT:
                break
        truncated = len(hits) >= self._LIMIT
        msg = f"{len(hits)}개 검색됨"
        if truncated:
            # 조용히 30건에서 끊으면 모델이 "이게 전부"라고 답한다
            msg += f" (상한 {self._LIMIT}건에 도달 — 더 있을 수 있으니 검색어를 좁히세요)"
        return SkillResult(
            ok=True, message=msg,
            data={"matches": hits, "truncated": truncated, "scanned": scanned},
        )


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
        # 대상이 실재하는지 먼저 본다. 예전엔 오타를 넣어도 ok=True + 빈 목록이라
        # "가리키는 문서가 없다"와 "그런 문서가 없다"가 구분되지 않았다.
        try:
            target = _resolve(root, args["path"])
        except _Ambiguous as e:
            return _ambiguous_result(e)
        except _IsFolder as e:
            return _folder_result(e)
        if target is None:
            return SkillResult(
                ok=False,
                message=f"'{args['path']}' 문서를 찾을 수 없습니다.",
                error_code="not_found",
            )
        title = target.name
        if title.endswith(".md"):
            title = title[:-3]
        links = backlinks_for(root, title)
        return SkillResult(
            ok=True,
            message=f"'{title}'을(를) 가리키는 문서 {len(links)}개",
            data={"path": _ident(root, target), "backlinks": links},
        )
