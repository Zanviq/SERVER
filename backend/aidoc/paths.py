"""DOCUMENT_ROOT 하위 안전 경로 + 폴더 구조 + 프로젝트 검증."""
from __future__ import annotations

from pathlib import Path

from ..config import Settings
from ..security_paths import safe_join
from .errors import BadRequest

TOP_FOLDERS = ("inbox", "projects", "knowledge", "templates", "archive", "trash", ".history")


def ensure_layout(settings: Settings) -> None:
    root = settings.document_root
    root.mkdir(parents=True, exist_ok=True)
    for f in TOP_FOLDERS:
        (root / f).mkdir(parents=True, exist_ok=True)
    for p in settings.aidoc_projects:
        (root / "projects" / p).mkdir(parents=True, exist_ok=True)


def resolve_rel(settings: Settings, rel: str) -> Path:
    """상대경로를 DOCUMENT_ROOT 하위로만 해석(심볼릭 탈출까지 재검증)."""
    target = safe_join(settings.document_root, rel)  # '..'·루트탈출 차단
    real = target.resolve()
    root = settings.document_root.resolve()
    if real != root and root not in real.parents:
        raise BadRequest("문서 루트를 벗어난 경로입니다.")
    return target


def new_doc_dir(settings: Settings, project: str | None) -> str:
    if not project:
        return "inbox"
    if project not in settings.aidoc_projects:
        raise BadRequest(f"등록되지 않은 프로젝트: {project}")
    return f"projects/{project}"


def list_existing_names(settings: Settings, dir_rel: str) -> set[str]:
    d = resolve_rel(settings, dir_rel)
    if not d.is_dir():
        return set()
    return {p.name for p in d.iterdir() if p.is_file()}
