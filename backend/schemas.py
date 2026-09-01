"""API 응답 Pydantic 스키마.

여기 있던 FileEntry/ListResponse/MakeDirRequest/RenameRequest/MessageResponse는
아무도 쓰지 않아 지웠다(파일·폴더 API는 라우터가 dict를 그대로 돌려준다).
"""
from __future__ import annotations

from pydantic import BaseModel


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
