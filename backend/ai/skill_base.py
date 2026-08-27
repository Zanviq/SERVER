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
    #: 실행해 봐야 무엇이 바뀌는지 아는 경우의 덮어쓰기(예: 휴지통 복원은
    #: 항목에 따라 문서일 수도 일정일 수도 있다). 비면 스킬의 mutates를 쓴다.
    #: 스킬 인스턴스는 싱글턴이라 self.mutates를 바꾸면 동시 요청끼리 섞인다.
    mutates: str = ""


@dataclass
class SkillContext:
    user: SessionUser
    settings: Settings
    today: str = ""  # 요청 기준 오늘(YYYY-MM-DD). 일정 기본 조회창 계산에 사용.


class SkillBase(ABC):
    name: str = ""
    description: str = ""
    parameters: dict = {}

    #: 이 스킬이 성공하면 무엇이 바뀌는가. 프런트가 그 화면을 새로고침하는 데 쓴다.
    #: 예: "calendar" | "documents". 조회 전용 스킬은 빈 문자열.
    #:
    #: 프런트가 스킬 이름 목록을 들고 판단하면, 새 스킬을 추가할 때마다 그 목록을
    #: 같이 고쳐야 하고 빠뜨리면 "고쳐졌는데 화면이 안 바뀌는" 증상이 된다
    #: (실제로 bulk_update_calendar_events에서 그랬다). 바뀌는 쪽이 선언한다.
    mutates: str = ""

    @abstractmethod
    def run(self, args: dict, ctx: SkillContext) -> SkillResult: ...

    def to_tool_spec(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }
