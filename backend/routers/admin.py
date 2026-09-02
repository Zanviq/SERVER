"""관리자 라우터 — 가입 승인 대기열과 계정 관리.

개인 서버이므로 가입은 신청만 가능하고, 여기서 승인해야 로그인할 수 있다.
모든 엔드포인트는 require_admin으로 보호된다.
"""
from __future__ import annotations

import logging
import shutil
import time

from fastapi import APIRouter, Depends, HTTPException

from .. import accounts
from ..auth import SessionUser, require_admin
from ..config import Settings, get_settings

logger = logging.getLogger("server.admin")
router = APIRouter(prefix="/api/admin", tags=["admin"])


def _not_self(target: str, admin: SessionUser) -> None:
    """자기 자신을 잠그는 조작은 UI 클릭 두 번이면 되므로 서버에서 막는다."""
    if target == admin.username:
        raise HTTPException(status_code=400, detail="자기 계정에는 할 수 없습니다.")


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
    _not_self(username, admin)
    return accounts.set_status(username, accounts.STATUS_REJECTED, admin.username, settings)


@router.post("/users/{username}/disable")
def disable(
    username: str,
    admin: SessionUser = Depends(require_admin),
    settings: Settings = Depends(get_settings),
):
    """비활성화 — 세션도 즉시 무효가 된다(auth._verify가 상태를 본다)."""
    _not_self(username, admin)
    return accounts.set_status(username, accounts.STATUS_DISABLED, admin.username, settings)


@router.post("/users/{username}/role")
def change_role(
    username: str,
    role: str,
    admin: SessionUser = Depends(require_admin),
    settings: Settings = Depends(get_settings),
):
    _not_self(username, admin)
    return accounts.set_role(username, role, settings)


def _archive_user_data(username: str, settings: Settings) -> str:
    """사용자 폴더를 물려받을 수 없는 이름으로 옮긴다. 옮길 게 없으면 빈 문자열."""
    src = settings.user_root(username)
    if not src.exists():
        return ""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = src.with_name(f"_deleted-{src.name}-{stamp}")
    try:
        shutil.move(str(src), str(dest))
    except OSError:
        logger.exception("삭제한 계정의 데이터를 옮기지 못했다: %s", src)
        return ""
    return dest.name


@router.delete("/users/{username}")
def delete_user(
    username: str,
    admin: SessionUser = Depends(require_admin),
    settings: Settings = Depends(get_settings),
):
    """계정을 삭제한다. 데이터는 남기되 **다른 사람이 물려받지 못하게** 치운다.

    예전에는 users/<id>/ 를 그대로 뒀는데, 같은 아이디로 다시 가입할 수 있어서
    새로 가입한 사람이 지워진 사람의 문서·할 일·설정·구글 토큰을 그대로 이어받았다.
    실수 복구 여지는 남겨야 하므로 지우지 않고 `_deleted-<id>-<시각>` 으로 옮긴다.
    """
    _not_self(username, admin)
    acc = accounts.find_for_login(username, settings)
    accounts.delete(username, settings)
    moved = ""
    if acc:
        moved = _archive_user_data(acc.username, settings)
    return {"ok": True, "data_moved_to": moved}
