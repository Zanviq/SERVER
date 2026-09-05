"""기본 스킬 모음. 도메인별 모듈에서 집계.

모든 스킬은 SkillContext의 세션 사용자 문서 공간에서만 동작한다
(users/<username>/data). 다른 사용자의 문서에는 접근할 수 없다.
"""
from __future__ import annotations

from .context import CONTEXT_SKILLS
from .diary import DIARY_SKILLS
from .calendar import (
    BulkCreateCalendarEvents,
    BulkDeleteCalendarEvents,
    BulkUpdateCalendarEvents,
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
    ListFolders,
    MoveDocument,
    ReadDocument,
    RenameDocument,
    SearchDocuments,
    WriteDocument,
)
from .meetings import MEETING_SKILLS
from .papers import PAPER_SKILLS
from .search import SearchEverything
from .system import GetSystemStatus
from .todo import (
    BulkCompleteTodos,
    BulkDeleteTodos,
    CompleteTodo,
    CreateTodo,
    CreateTodoCategory,
    DeleteTodo,
    ListTodoCategories,
    ListTodos,
    UpdateTodo,
)
from .trash import ListTrash, RestoreFromTrash
from .think import ThinkSkill
from .vocab import VOCAB_SKILLS

# 등록 순서 = LLM에 노출되는 카탈로그 순서
ALL_SKILLS = [
    ThinkSkill(),
    # 문서(파일·노트 통합)
    ListDocuments(),
    ListFolders(),
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
    BulkCreateCalendarEvents(),
    BulkUpdateCalendarEvents(),
    BulkDeleteCalendarEvents(),
    DeleteCalendarEvent(),
    FindFreeSlots(),
    # 할 일(내부 전용 — 구글과 동기화하지 않는다)
    ListTodos(),
    ListTodoCategories(),
    CreateTodo(),
    UpdateTodo(),
    CompleteTodo(),
    DeleteTodo(),
    BulkCompleteTodos(),
    BulkDeleteTodos(),
    CreateTodoCategory(),
    # 단어장(영어 학습·논문 화면과 공유)
    *VOCAB_SKILLS,
    # 논문
    *PAPER_SKILLS,
    # 회의 녹음
    *MEETING_SKILLS,
    # 기록(상태·일기) — 캘린더의 '기록' 보기와 같은 저장소
    *DIARY_SKILLS,
    # 지난 대화(컨텍스트) — 어디의 언제 대화를 꺼낼지 모델이 고른다
    *CONTEXT_SKILLS,
    # 화면을 가로지르는 검색 — 어느 화면인지 모를 때 먼저 부른다
    SearchEverything(),
    # 휴지통(되돌리기)
    ListTrash(),
    RestoreFromTrash(),
    # 시스템
    GetSystemStatus(),
]

__all__ = [
    "ALL_SKILLS",
    "ThinkSkill",
    "SearchEverything",
    "ListDocuments", "ReadDocument", "SearchDocuments", "WriteDocument",
    "AppendDocument", "DeleteDocument", "RenameDocument", "MoveDocument",
    "CreateFolder", "DocumentBacklinks",
    "ListCalendarEvents", "CreateCalendarEvent", "UpdateCalendarEvent",
    "DeleteCalendarEvent", "FindFreeSlots", "GetSystemStatus",
    "ListTodos", "ListTodoCategories", "CreateTodo", "UpdateTodo",
    "CompleteTodo", "DeleteTodo", "BulkCompleteTodos", "BulkDeleteTodos",
    "CreateTodoCategory",
]
