"""스킬 레지스트리 — 등록·카탈로그·디스패치."""
from __future__ import annotations

import logging

from .skill_base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("twomes.ai")


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
        except Exception as e:  # noqa: BLE001
            logger.exception("스킬 실행 오류: %s", name)
            return SkillResult(ok=False, message=str(e), error_code="internal")


def default_registry() -> SkillRegistry:
    """기본 스킬 묶음 등록 (도메인 모듈 집계)."""
    from .skills import ALL_SKILLS

    reg = SkillRegistry()
    for s in ALL_SKILLS:
        reg.register(s)
    return reg
