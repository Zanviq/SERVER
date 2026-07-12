"""AI 토큰(Principal) 권한 검사 — REST 라우터와 MCP가 공유.

핵심: 문서 접근 권한은 **문서의 실제 project**로 판정한다(호출자 힌트 불신 →
교차 프로젝트 IDOR 방지). 실패 시 도메인 예외 Forbidden(=AidocError 403)을 던지므로
각 전송계층(REST `_mapped` / MCP dispatch)이 알맞게 매핑한다.
"""
from __future__ import annotations

from .errors import Forbidden
from .tokens import Principal


def need_scope(p: Principal, scope: str) -> None:
    if not p.can(scope):
        raise Forbidden(f"scope 없음: {scope}")


def need_create(p: Principal, project) -> None:
    """생성/이동 대상 권한: '*' 또는 project 미지정(inbox/공유) 또는 allowed 포함."""
    if not p.project_ok(project):
        raise Forbidden(f"프로젝트 권한 없음: {project}")


def need_resource(p: Principal, project) -> None:
    """기존 문서 접근 권한: 문서의 실제 project로 판정.

    '*'가 아니면 project 미지정(inbox) 문서는 접근 불가(정보 노출 방지).
    """
    if "*" in p.allowed_projects:
        return
    if project is None or project not in p.allowed_projects:
        raise Forbidden(f"프로젝트 권한 없음: {project}")


def filter_allowed(p: Principal, docs: list[dict]) -> list[dict]:
    """'*'가 아니면 결과를 allowed project로 강제 축소(inbox/타 프로젝트 제외)."""
    if "*" in p.allowed_projects:
        return docs
    allowed = set(p.allowed_projects)
    return [d for d in docs if d.get("project") in allowed]


def allowed_projects(p: Principal, all_projects: list[str]) -> list[str]:
    if "*" in p.allowed_projects:
        return all_projects
    return [pr for pr in all_projects if pr in p.allowed_projects]
