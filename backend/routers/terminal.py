"""웹 터미널 상태 API. 실제 셸(PTY)은 별도 컨테이너(server-terminal)가 담당.

여기서는 프론트가 터미널 UI를 노출할지 판단할 정보만 제공한다:
  - enabled : ENABLE_TERMINAL 환경변수
  - is_admin: 현재 사용자가 TERMINAL_ADMINS 목록에 있는지
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import SessionUser, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/terminal", tags=["terminal"])


@router.get("/status")
def status(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    # 계정 권한과 환경변수 화이트리스트를 둘 다 만족해야 한다(권한 축소 방향)
    is_admin = user.is_admin and user.username in settings.terminal_admins
    return {
        "enabled": settings.terminal_enabled,
        "is_admin": is_admin,
        "available": settings.terminal_enabled and is_admin,
    }
