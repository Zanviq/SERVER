"""파일 관련 스킬 — 모두 세션 사용자 스코프."""
from __future__ import annotations

from ...gemini_client import TEXT_EXTENSIONS
from ...security_paths import to_rel
from ...storage import resolve, scope_root
from ...trash import move_to_trash
from ..skill_base import SkillBase, SkillResult
from ._common import _MAX_READ, _SCOPE_PROP, _is_sensitive


class ListFiles(SkillBase):
    name = "list_files"
    description = "지정한 공간/폴더의 파일·폴더 목록을 본다."
    parameters = {
        "type": "object",
        "properties": {
            "scope": _SCOPE_PROP,
            "path": {"type": "string", "description": "스코프 루트 기준 상대 폴더 (기본 루트)"},
        },
        "required": ["scope"],
    }

    def run(self, args, ctx):
        root = scope_root(args["scope"], ctx.user, ctx.settings)
        target = resolve(args["scope"], args.get("path", ""), ctx.user, ctx.settings)
        if not target.exists() or not target.is_dir():
            return SkillResult(ok=False, message="폴더를 찾을 수 없습니다.", error_code="not_found")
        items = [
            {"name": c.name, "path": to_rel(root, c), "is_dir": c.is_dir()}
            for c in sorted(target.iterdir())
        ]
        return SkillResult(ok=True, message=f"{len(items)}개 항목", data={"items": items})


class ReadFile(SkillBase):
    name = "read_file"
    description = "텍스트 파일의 내용을 읽는다(.md/.txt/코드 등). 민감 파일은 차단됨."
    parameters = {
        "type": "object",
        "properties": {"scope": _SCOPE_PROP, "path": {"type": "string"}},
        "required": ["scope", "path"],
    }

    def run(self, args, ctx):
        if _is_sensitive(args["path"]):
            return SkillResult(ok=False, message="민감 파일로 판단되어 AI 읽기가 차단되었습니다.", error_code="blocked")
        target = resolve(args["scope"], args["path"], ctx.user, ctx.settings)
        if not target.exists() or not target.is_file():
            return SkillResult(ok=False, message="파일을 찾을 수 없습니다.", error_code="not_found")
        if target.suffix.lower() not in TEXT_EXTENSIONS:
            return SkillResult(ok=False, message="텍스트 파일만 읽을 수 있습니다.", error_code="unsupported")
        return SkillResult(ok=True, message="읽기 완료", data={"content": target.read_text(encoding="utf-8", errors="replace")[:_MAX_READ]})


class SearchFiles(SkillBase):
    name = "search_files"
    description = "파일명에 키워드가 포함된 파일을 찾는다."
    parameters = {
        "type": "object",
        "properties": {"scope": _SCOPE_PROP, "query": {"type": "string"}},
        "required": ["scope", "query"],
    }

    _LIMIT = 50

    def run(self, args, ctx):
        root = scope_root(args["scope"], ctx.user, ctx.settings)
        q = args["query"].lower()
        hits: list[str] = []
        # 파일명으로 먼저 거르고, 상한에 닿으면 즉시 중단 — 전체 트리를 끝까지
        # 훑은 뒤 자르면 HDD 저장소에서 불필요하게 오래 걸린다.
        for p in root.rglob("*"):
            if q not in p.name.lower() or not p.is_file():
                continue
            rel = to_rel(root, p)
            if _is_sensitive(rel):
                continue
            hits.append(rel)
            if len(hits) >= self._LIMIT:
                break
        hits.sort()
        more = " (상한 도달, 더 있을 수 있음)" if len(hits) >= self._LIMIT else ""
        return SkillResult(ok=True, message=f"{len(hits)}개 검색됨{more}", data={"matches": hits})


class WriteTextFile(SkillBase):
    name = "write_text_file"
    description = "텍스트 파일을 만들거나 덮어쓴다."
    parameters = {
        "type": "object",
        "properties": {
            "scope": _SCOPE_PROP,
            "path": {"type": "string", "description": "예: docs/memo.txt"},
            "content": {"type": "string"},
        },
        "required": ["scope", "path", "content"],
    }

    def run(self, args, ctx):
        target = resolve(args["scope"], args["path"], ctx.user, ctx.settings)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(args["content"], encoding="utf-8")
        return SkillResult(ok=True, message=f"저장됨: {args['path']}", data={"path": args["path"]})


class AppendTextFile(SkillBase):
    name = "append_text_file"
    description = "기존 텍스트 파일 끝에 내용을 덧붙인다(없으면 생성)."
    parameters = {
        "type": "object",
        "properties": {
            "scope": _SCOPE_PROP,
            "path": {"type": "string"},
            "content": {"type": "string"},
        },
        "required": ["scope", "path", "content"],
    }

    def run(self, args, ctx):
        target = resolve(args["scope"], args["path"], ctx.user, ctx.settings)
        target.parent.mkdir(parents=True, exist_ok=True)
        prev = target.read_text(encoding="utf-8", errors="replace") if target.exists() else ""
        target.write_text(prev + args["content"], encoding="utf-8")
        return SkillResult(ok=True, message=f"덧붙임: {args['path']}", data={"path": args["path"]})


class DeletePath(SkillBase):
    name = "delete_path"
    description = "파일 또는 폴더(내용 포함)를 휴지통으로 보낸다(웹 휴지통에서 복구 가능)."
    parameters = {
        "type": "object",
        "properties": {"scope": _SCOPE_PROP, "path": {"type": "string"}},
        "required": ["scope", "path"],
    }

    def run(self, args, ctx):
        root = scope_root(args["scope"], ctx.user, ctx.settings)
        target = resolve(args["scope"], args["path"], ctx.user, ctx.settings)
        if target == root:
            return SkillResult(ok=False, message="루트는 삭제할 수 없습니다.", error_code="forbidden")
        if not target.exists():
            return SkillResult(ok=False, message="대상을 찾을 수 없습니다.", error_code="not_found")
        # 웹과 동일하게 휴지통 경유 — AI가 대상을 잘못 짚어도 되돌릴 수 있게.
        rel = to_rel(root, target)
        move_to_trash("file", args["scope"], target, rel, ctx.user, ctx.settings)
        return SkillResult(
            ok=True, message=f"'{rel}'을(를) 휴지통으로 옮겼습니다(복구 가능).", data={"path": rel}
        )


class CreateFolder(SkillBase):
    name = "create_folder"
    description = "새 폴더를 만든다."
    parameters = {
        "type": "object",
        "properties": {"scope": _SCOPE_PROP, "path": {"type": "string"}},
        "required": ["scope", "path"],
    }

    def run(self, args, ctx):
        target = resolve(args["scope"], args["path"], ctx.user, ctx.settings)
        if target.exists():
            return SkillResult(ok=False, message="이미 존재합니다.", error_code="exists")
        target.mkdir(parents=True)
        return SkillResult(ok=True, message=f"폴더 생성: {args['path']}", data={"path": args["path"]})


class MovePath(SkillBase):
    name = "move_path"
    description = "파일/폴더를 이동하거나 이름을 바꾼다(같은 공간 내)."
    parameters = {
        "type": "object",
        "properties": {
            "scope": _SCOPE_PROP,
            "src": {"type": "string"},
            "dst": {"type": "string"},
        },
        "required": ["scope", "src", "dst"],
    }

    def run(self, args, ctx):
        src = resolve(args["scope"], args["src"], ctx.user, ctx.settings)
        dst = resolve(args["scope"], args["dst"], ctx.user, ctx.settings)
        if not src.exists():
            return SkillResult(ok=False, message="원본을 찾을 수 없습니다.", error_code="not_found")
        if dst.exists():
            return SkillResult(ok=False, message="대상이 이미 존재합니다.", error_code="exists")
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        return SkillResult(ok=True, message=f"이동: {args['src']} → {args['dst']}", data={})
