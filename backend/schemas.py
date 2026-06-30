"""API 요청/응답 Pydantic 스키마."""
from __future__ import annotations

from pydantic import BaseModel, Field


class FileEntry(BaseModel):
    """파일/폴더 한 항목."""

    name: str
    path: str = Field(description="저장소 루트 기준 상대경로")
    is_dir: bool
    size: int = Field(description="바이트 (폴더는 0)")
    modified: float = Field(description="수정 시각 epoch seconds")


class ListResponse(BaseModel):
    path: str
    entries: list[FileEntry]


class MakeDirRequest(BaseModel):
    path: str = Field(description="생성할 폴더 경로 (저장소 루트 기준)")


class RenameRequest(BaseModel):
    src: str
    dst: str


class MessageResponse(BaseModel):
    ok: bool = True
    message: str


class SystemStats(BaseModel):
    cpu_percent: float
    cpu_count: int
    mem_total: int
    mem_used: int
    mem_percent: float
    disk_total: int
    disk_used: int
    disk_percent: float
    temperature_c: float | None
    uptime_seconds: float
    load_avg: list[float] | None
