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
            logger.exception("스킬 실행 오류: %s", name)
            return SkillResult(ok=False, message=str(e), error_code="internal")


def default_registry() -> SkillRegistry:
    """기본 스킬 묶음 등록 (도메인 모듈 집계)."""
    from .skills import ALL_SKILLS

    reg = SkillRegistry()
    for s in ALL_SKILLS:
        reg.register(s)
    return reg
