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
    #: 어느 화면에서 부른 대화인가("" | "english" | "paper" | "meeting"). 스킬 묶음·프롬프트를 고른다.
    mode: str = ""
    #: 논문 화면이면 지금 보고 있는 논문 id. 논문 스킬이 "이 논문"을 해석하는 기준.
    paper_id: str = ""
    #: 회의 화면이면 지금 보고 있는 회의 id. 회의 스킬이 "이 회의"를 해석하는 기준.
    meeting_id: str = ""
    #: 이 화면에서 단어장에 넣는 단어에 무조건 붙는 태그(논문 제목 등).
    vocab_tags: list[str] = field(default_factory=list)
    #: 이번 차례에 사용자가 실제로 친 말. 스킬이 "사용자가 이걸 시켰나"를 스스로
    #: 확인해야 할 때 쓴다(단어장 자동 추가처럼, 프롬프트만으로는 새는 자리).
    #: 모델의 말이 아니라 **사람의 말**이다.
    user_message: str = ""


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

    #: 결과 data 를 화면(SSE tool_result)에도 실어 보낼지. 기본은 모델에게만 준다 —
    #: 목록 조회 결과를 매번 브라우저로 흘리면 스트림이 무거워진다. 화면이 결과로
    #: 무언가를 그려야 하는 스킬(단어 후보 체크 목록)만 켠다.
    expose_data: bool = False

    @abstractmethod
    def run(self, args: dict, ctx: SkillContext) -> SkillResult: ...

    def to_tool_spec(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }
