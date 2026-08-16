"""기본 스킬 모음. 도메인별 모듈에서 집계.

모든 스킬은 SkillContext의 세션 사용자 문서 공간에서만 동작한다
(users/<username>/data). 다른 사용자의 문서에는 접근할 수 없다.
"""
from __future__ import annotations

from .calendar import (
    CreateCalendarEvent,
    DeleteCalendarEvent,
    FindFreeSlots,
    ListCalendarEvents,
    UpdateCalendarEvent,
)
from .documents import (
    AppendDocument,
    CreateFolder,
    DeleteDocument,
    DocumentBacklinks,
    ListDocuments,
    MoveDocument,
    ReadDocument,
    RenameDocument,
    SearchDocuments,
    WriteDocument,
)
from .system import GetSystemStatus
from .think import ThinkSkill

# 등록 순서 = LLM에 노출되는 카탈로그 순서
ALL_SKILLS = [
    ThinkSkill(),
    # 문서(파일·노트 통합)
    ListDocuments(),
    ReadDocument(),
    SearchDocuments(),
    WriteDocument(),
    AppendDocument(),
    DeleteDocument(),
    RenameDocument(),
    MoveDocument(),
    CreateFolder(),
    DocumentBacklinks(),
    # 캘린더
    ListCalendarEvents(),
    CreateCalendarEvent(),
    UpdateCalendarEvent(),
    DeleteCalendarEvent(),
    FindFreeSlots(),
    # 시스템
    GetSystemStatus(),
]

__all__ = [
    "ALL_SKILLS",
    "ThinkSkill",
    "ListDocuments", "ReadDocument", "SearchDocuments", "WriteDocument",
    "AppendDocument", "DeleteDocument", "RenameDocument", "MoveDocument",
    "CreateFolder", "DocumentBacklinks",
    "ListCalendarEvents", "CreateCalendarEvent", "UpdateCalendarEvent",
    "DeleteCalendarEvent", "FindFreeSlots", "GetSystemStatus",
]
