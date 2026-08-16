"""Google 캘린더 연동 라우터 — 동의 URL 발급, 콜백, 해제."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse

from .. import google_oauth
from ..auth import SessionUser, require_owner, require_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/google", tags=["google"])


@router.get("/status")
def status(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    # status는 모두에게 연다 — 가입 사용자에게 "연동은 관리자 전용"임을 보여주려면
    # 상태 조회가 되어야 한다. 대신 주인이 아니면 연동을 시작할 수 없음을 알린다.
    st = google_oauth.status(user.username, settings)
    st["owner_only"] = True
    if not user.is_owner:
        st["server_ready"] = False
    return st


@router.get("/auth-url")
def auth_url(
    user: SessionUser = Depends(require_owner),
    settings: Settings = Depends(get_settings),
):
    """구글 동의 화면 URL. 프런트가 이 주소로 이동시킨다."""
    return {"url": google_oauth.auth_url(user.username, settings)}


@router.get("/callback")
def callback(
    code: str = Query("", description="구글이 돌려주는 인가 코드"),
    state: str = Query("", description="발급 시 서명한 state"),
    error: str = Query("", description="사용자가 동의를 거부한 경우"),
    user: SessionUser = Depends(require_owner),
    settings: Settings = Depends(get_settings),
):
    """코드를 토큰으로 교환하고 설정 화면으로 돌려보낸다."""
    if error:
        return RedirectResponse(url=f"/settings?google=denied", status_code=303)
    if not code or not state:
        raise HTTPException(status_code=400, detail="잘못된 콜백 요청입니다.")

    # state에 서명된 사용자와 현재 세션이 같아야 한다 —
    # 남의 계정에 내 구글 계정을 붙이는 CSRF를 막는다.
    signed_user = google_oauth.verify_state(state, settings)
    if signed_user != user.username:
        raise HTTPException(status_code=403, detail="다른 계정에서 시작된 연동 요청입니다.")

    google_oauth.exchange_code(code, user.username, settings)
    return RedirectResponse(url="/settings?google=connected", status_code=303)


@router.post("/disconnect")
def disconnect(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """저장된 토큰 삭제 → 내부 캘린더로 복귀.

    연동 '시작'은 주인만이지만 해제는 본인이면 누구나 가능해야 한다 —
    이 변경 전에 연동한 가입 사용자가 영영 못 끊는 상태가 되면 안 된다(권한 축소).
    """
    google_oauth.disconnect(user.username, settings)
    return {"ok": True}
