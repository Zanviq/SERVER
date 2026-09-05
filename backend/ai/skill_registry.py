"""스킬 레지스트리 — 등록·카탈로그·디스패치."""
from __future__ import annotations

import logging

from fastapi import HTTPException

from .skill_base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("server.ai")


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, SkillBase] = {}

    def register(self, skill: SkillBase) -> None:
        self._skills[skill.name] = skill

    def get(self, name: str) -> SkillBase | None:
        return self._skills.get(name)

    def build_catalog(self) -> list[dict]:
        return [s.to_tool_spec() for s in self._skills.values()]

    def dispatch(self, name: str, args: dict, ctx: SkillContext) -> SkillResult:
        skill = self.get(name)
        if skill is None:
            return SkillResult(ok=False, message=f"스킬 '{name}' 없음", error_code="not_found")
        try:
            return skill.run(args or {}, ctx)
        except HTTPException as e:
            # 404/409 같은 의미 있는 실패를 "internal"로 뭉개면 모델이 스스로
            # 고칠 수 없다(메시지에 상태코드가 섞여 나가기도 했다).
            code = {400: "invalid", 403: "forbidden", 404: "not_found",
                    409: "conflict", 410: "gone", 415: "unsupported"}.get(e.status_code, "error")
            return SkillResult(ok=False, message=str(e.detail), error_code=code)
        except Exception as e:  # noqa: BLE001
            # 예상 못 한 예외의 문자열에는 경로·키·요청 본문이 섞일 수 있다. 이 값은
            # 화면의 스킬 칩에 보이고, 대화 기록(감사 로그)에 남고, 다음 차례에 모델
            # 에게도 들어간다 — 세 곳 모두로 새어 나간다. 자세한 내용은 서버 로그에만
            # 남기고(위 logger.exception), 밖으로는 갈래만 알린다.
            # HTTPException 은 우리가 직접 쓴 문구라 그대로 내보낸다(위 분기).
            logger.exception("스킬 실행 오류: %s", name)
            detail = str(e) if getattr(ctx.settings, "debug", False) else ""
            msg = f"'{name}' 실행 중 오류가 났습니다." + (f" ({detail[:300]})" if detail else "")
            return SkillResult(ok=False, message=msg, error_code="internal")


def default_registry() -> SkillRegistry:
    """기본 스킬 묶음 등록 (도메인 모듈 집계)."""
    from .skills import ALL_SKILLS

    reg = SkillRegistry()
    for s in ALL_SKILLS:
        reg.register(s)
    return reg
