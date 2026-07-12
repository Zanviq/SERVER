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
    duplicate_check_query: str | None = None


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
