"""Google 캘린더 연동 라우터 — 동의 URL 발급, 콜백, 해제."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse

from .. import google_oauth
from ..auth import SessionUser, require_owner, require_session
from ..config import Settings, get_settings

logger = logging.getLogger("server.google")

router = APIRouter(prefix="/api/google", tags=["google"])

#: 콜백만 세션 의존성 **밖**에 둔다. main 이 이 라우터를 require_session 없이
#: 붙인다 — 동의 화면에 머무는 동안 세션이 만료되면 라우터 의존성이 401 JSON
#: 페이지를 띄워, 사용자가 앱으로 돌아갈 길이 없어지기 때문이다. 권한은 아래
#: 핸들러가 직접 확인하고, 실패하면 화면으로 돌려보낸다.
callback_router = APIRouter(prefix="/api/google", tags=["google"])


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


def _back(reason: str) -> RedirectResponse:
    """설정 화면으로 돌려보낸다.

    이 엔드포인트는 **브라우저 주소창**이 오는 곳이다. 여기서 HTTPException 을
    올리면 사용자는 `{"detail": "..."}` 라는 원시 JSON 페이지에 남겨지고
    앱으로 돌아갈 링크조차 없다. 어떤 실패든 화면으로 돌려보내고 이유를 붙인다.
    """
    return RedirectResponse(url=f"/settings?google={reason}", status_code=303)


@callback_router.get("/callback")
def callback(
    request: Request,
    code: str = Query("", description="구글이 돌려주는 인가 코드"),
    state: str = Query("", description="발급 시 서명한 state"),
    error: str = Query("", description="사용자가 동의를 거부한 경우"),
    settings: Settings = Depends(get_settings),
):
    """코드를 토큰으로 교환하고 설정 화면으로 돌려보낸다."""
    if error:
        return _back("denied")
    if not code or not state:
        return _back("bad_request")

    # 권한 검사를 의존성이 아니라 **여기서** 한다. 의존성이 올린 401/403 은
    # 그대로 JSON 페이지가 되는데, 동의 화면에 머무는 동안 세션이 만료되는 것은
    # 흔한 일이라 그 길로 빠지는 사용자가 실제로 생긴다.
    try:
        user = require_owner(require_session(request, settings))
    except HTTPException:
        return _back("session")

    # state에 서명된 사용자와 현재 세션이 같아야 한다 —
    # 남의 계정에 내 구글 계정을 붙이는 CSRF를 막는다.
    try:
        signed_user = google_oauth.verify_state(state, settings)
    except HTTPException:
        return _back("bad_state")
    if signed_user != user.username:
        return _back("other_account")

    try:
        google_oauth.exchange_code(code, user.username, settings)
    except HTTPException:
        return _back("exchange_failed")
    except Exception:  # noqa: BLE001
        logger.exception("구글 토큰 교환에 실패했다: %s", user.username)
        return _back("exchange_failed")
    return _back("connected")


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
