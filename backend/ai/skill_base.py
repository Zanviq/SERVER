"""스킬 기반 클래스 — Plant-Counselor 패턴.

모든 스킬은 SkillContext(세션 사용자 + 설정)만으로 동작한다.
파일/노트/캘린더 접근은 storage/calendar_store를 통해 항상 그 사용자의
스코프(common | 본인 me)로만 해석되므로, 다른 사용자 데이터엔 접근 불가.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from ..auth import SessionUser
from ..config import Settings


@dataclass
class SkillResult:
    ok: bool
    message: str
    data: dict = field(default_factory=dict)
    error_code: str = ""


@dataclass
class SkillContext:
    user: SessionUser
    settings: Settings
    today: str = ""  # 요청 기준 오늘(YYYY-MM-DD). 일정 기본 조회창 계산에 사용.


class SkillBase(ABC):
    name: str = ""
    description: str = ""
    parameters: dict = {}

    @abstractmethod
    def run(self, args: dict, ctx: SkillContext) -> SkillResult: ...

    def to_tool_spec(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }
