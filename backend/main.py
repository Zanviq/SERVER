"""SERVER 홈서버 백엔드 진입점.

FastAPI 단일 게이트웨이. 인증 미들웨어로 전 API 보호.
"""
from __future__ import annotations

import errno
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .auth import require_owner, require_session
from .config import get_settings
from .routers import (
    admin,
    ai,
    auth,
    calendar,
    context,
    diary,
    google,
    meetings,
    notes,
    papers,
    search,
    settings as settings_router,
    system,
    terminal,
    todo,
    trash,
    vocab,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.ensure_storage()
    # 계정 저장소 초기화 — 비어 있으면 .env의 AUTH_USERS를 해시로 1회 이관
    from . import accounts

    # **기동은 계정 파일 때문에 막히지 않는다.** 파일이 깨졌거나 UTF-8 이 아니면
    # 여기서 예외가 올라가 `Application startup failed` 로 끝나고, compose 의
    # `restart: unless-stopped` 때문에 컨테이너가 재시작만 반복한다 — 로그인뿐
    # 아니라 문서·캘린더·할 일·/api/health 까지 전부 내려가고, 무엇이 문제인지
    # 볼 방법도 없다. 손상은 로그인 경로가 503 으로 이미 막고 있으므로(덮어쓰지
    # 않는다), 여기서는 크게 남기고 서버는 띄운다.
    try:
        accounts.ensure_seed(settings)
        empty = not accounts.list_all(settings)
    except Exception:  # noqa: BLE001
        logger.exception(
            "계정 저장소를 읽지 못했습니다 — 로그인은 503 으로 막히지만 서버는 뜹니다. "
            "accounts.json 이 올바른 JSON 목록인지 확인하세요."
        )
        empty = False
    if not settings.session_secret:
        logger.warning("SESSION_SECRET 미설정 — 로그인이 503으로 거부됩니다.")
    if empty:
        logger.warning(
            "계정이 없습니다 — .env의 AUTH_USERS로 최초 관리자를 만들거나 가입 후 승인이 필요합니다."
        )
    yield


app = FastAPI(
    title="SERVER Home Server API",
    description="라즈베리파이 5 홈서버 통합 API (멀티유저)",
    version="0.2.0",
    lifespan=lifespan,
)

settings = get_settings()

# CORS: 자격증명(쿠키)을 쓰므로 와일드카드 금지.
_origins = [o for o in settings.cors_origins if o != "*"]
if "*" in settings.cors_origins:
    logger.warning("CORS_ORIGINS에 '*'는 자격증명과 함께 쓸 수 없어 무시됩니다.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    allow_headers=["Content-Type", "Authorization"],
)

# 공개 라우터(인증 불필요)
app.include_router(auth.router)

# 보호 라우터: 모든 엔드포인트가 유효 세션 요구
_PROTECTED = [Depends(require_session)]
# 시스템 상태·계정 관리는 서버 주인 전용 — 클라이언트에서 숨기는 것만으론 막히지 않는다
_OWNER_ONLY = [Depends(require_owner)]
app.include_router(system.router, dependencies=_OWNER_ONLY)
app.include_router(notes.router, dependencies=_PROTECTED)
app.include_router(calendar.router, dependencies=_PROTECTED)
app.include_router(settings_router.router, dependencies=_PROTECTED)
app.include_router(ai.router, dependencies=_PROTECTED)
app.include_router(todo.router, dependencies=_PROTECTED)
app.include_router(trash.router, dependencies=_PROTECTED)
app.include_router(vocab.router, dependencies=_PROTECTED)
app.include_router(papers.router, dependencies=_PROTECTED)
app.include_router(diary.router, dependencies=_PROTECTED)
app.include_router(meetings.router, dependencies=_PROTECTED)
app.include_router(context.router, dependencies=_PROTECTED)
app.include_router(search.router, dependencies=_PROTECTED)
app.include_router(terminal.router, dependencies=_PROTECTED)
app.include_router(admin.router, dependencies=_OWNER_ONLY)
app.include_router(google.router, dependencies=_PROTECTED)
# 구글 콜백은 브라우저 주소창이 오는 곳이라 의존성이 올리는 401/403 JSON 페이지에
# 사용자를 남기면 안 된다. 권한은 핸들러가 직접 보고, 실패해도 화면으로 돌려보낸다.
app.include_router(google.callback_router)


@app.get("/api/health", tags=["meta"])
def health():
    """헬스 체크 (인증 불필요)."""
    s = get_settings()
    return {"ok": True, "storage_exists": s.storage_root.exists()}


#: 저장이 실패하는 흔한 이유들. 그냥 500 "internal server error" 로 내보내면
#: 사용자는 "왜 저장이 안 되지"만 알고, 정작 할 일(공간 비우기·권한 고치기)을 모른다.
#: 라즈베리파이에서 실제로 마주칠 수 있는 것들이다(외장하드가 빠지거나 가득 찬다).
_DISK_TROUBLE = {
    errno.ENOSPC: "저장 공간이 가득 찼습니다. 휴지통을 비우거나 큰 파일을 지워 주세요.",
    errno.EDQUOT: "저장 공간 할당량을 넘었습니다.",
    errno.EROFS: "저장소가 읽기 전용입니다(디스크가 잘못 붙었을 수 있습니다).",
    errno.EACCES: "저장소에 쓸 권한이 없습니다.",
    errno.EPERM: "저장소에 쓸 권한이 없습니다.",
    errno.ENOENT: "저장 폴더를 찾을 수 없습니다(외장하드가 빠졌는지 확인하세요).",
    errno.EIO: "저장소를 읽고 쓰는 중 오류가 났습니다(디스크를 확인하세요).",
}


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception):
    """미처리 예외 로깅. DEBUG일 때만 상세 노출, 운영은 일반 메시지."""
    logger.exception("미처리 예외 @ %s %s", request.method, request.url.path)
    s = get_settings()
    # 디스크 문제는 이름을 붙여 준다 — 사용자가 스스로 고칠 수 있는 몇 안 되는 오류다.
    if isinstance(exc, OSError) and exc.errno in _DISK_TROUBLE:
        return JSONResponse(status_code=507 if exc.errno == errno.ENOSPC else 500,
                            content={"detail": _DISK_TROUBLE[exc.errno]})
    detail = f"{exc.__class__.__name__}: {exc}" if s.debug else "internal server error"
    return JSONResponse(status_code=500, content={"detail": detail})
