"""관리자 라우터 — 가입 승인 대기열과 계정 관리.

개인 서버이므로 가입은 신청만 가능하고, 여기서 승인해야 로그인할 수 있다.
모든 엔드포인트는 require_admin으로 보호된다.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import accounts
from ..auth import SessionUser, require_admin
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/users")
def list_users(
    _: SessionUser = Depends(require_admin),
    settings: Settings = Depends(get_settings),
):
    """전체 계정. 비밀번호 해시는 포함하지 않는다."""
    rows = accounts.list_all(settings)
    return {
        "pending": [r for r in rows if r.get("status") == accounts.STATUS_PENDING],
        "users": [r for r in rows if r.get("status") != accounts.STATUS_PENDING],
    }


@router.post("/users/{username}/approve")
def approve(
    username: str,
    admin: SessionUser = Depends(require_admin),
    settings: Settings = Depends(get_settings),
):
    """승인 — 이때 문서 폴더 골격을 만든다(승인 전에는 만들지 않는다)."""
    row = accounts.set_status(username, accounts.STATUS_ACTIVE, admin.username, settings)
    base = settings.user_root(username)
    for sub in ("data", "calendar", "ai/logs"):
        (base / sub).mkdir(parents=True, exist_ok=True)
    return row


@router.post("/users/{username}/reject")
def reject(
    username: str,
    admin: SessionUser = Depends(require_admin),
    settings: Settings = Depends(get_settings),
):
    return accounts.set_status(username, accounts.STATUS_REJECTED, admin.username, settings)


@router.post("/users/{username}/disable")
def disable(
    username: str,
    admin: SessionUser = Depends(require_admin),
    settings: Settings = Depends(get_settings),
):
    """비활성화 — 세션도 즉시 무효가 된다(verify_token이 상태를 본다)."""
    return accounts.set_status(username, accounts.STATUS_DISABLED, admin.username, settings)


@router.post("/users/{username}/role")
def change_role(
    username: str,
    role: str,
    _: SessionUser = Depends(require_admin),
    settings: Settings = Depends(get_settings),
):
    return accounts.set_role(username, role, settings)


@router.delete("/users/{username}")
def delete_user(
    username: str,
    _: SessionUser = Depends(require_admin),
    settings: Settings = Depends(get_settings),
):
    """계정만 삭제한다. 문서는 남겨 실수를 되돌릴 수 있게 한다."""
    accounts.delete(username, settings)
    return {"ok": True}
