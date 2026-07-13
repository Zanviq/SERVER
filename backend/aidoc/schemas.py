"""AI 문서 API 스키마."""
from __future__ import annotations

from pydantic import BaseModel, Field


class CreateDoc(BaseModel):
    title: str
    content: str = ""
    project: str | None = None
    category: str | None = None
    tags: list[str] = Field(default_factory=list)
    status: str = "draft"
    folder: str | None = None  # 프로젝트/인박스 하위 폴더(선택). 없으면 자동 생성.
    duplicate_check_query: str | None = None


class CreateFolder(BaseModel):
    project: str | None = None  # None → inbox 하위
    path: str  # 하위 폴더 경로(예: "설계/초안")


class UpdateDoc(BaseModel):
    expected_version: int
    title: str | None = None
    content: str | None = None
    change_summary: str = ""


class AppendDoc(BaseModel):
    content: str
    change_summary: str = ""


class MoveDoc(BaseModel):
    target_project: str | None = None  # None → inbox
    target_folder: str | None = None   # knowledge/... 등 (등록 폴더만)


class RestoreDoc(BaseModel):
    version: int | None = None  # None → 휴지통 복원, 값 → 해당 버전으로 복원


class DocMeta(BaseModel):
    id: str
    title: str
    project: str | None
    category: str | None
    tags: list[str]
    status: str
    version: int
    created_by: str | None
    updated_by: str | None
    created_at: str
    updated_at: str
    trashed: bool


class DocDetail(DocMeta):
    content: str


class SearchHit(DocMeta):
    snippet: str
