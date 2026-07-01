"""SERVER 홈서버 백엔드 진입점.

FastAPI 단일 게이트웨이. 인증 미들웨어로 전 API 보호.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .auth import require_session
from .config import get_settings
from .routers import ai, auth, calendar, files, notes, settings as settings_router, system

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.ensure_storage()
    if not settings.session_secret:
        logger.warning("SESSION_SECRET 미설정 — 로그인이 503으로 거부됩니다.")
    if not settings.users:
        logger.warning("AUTH_USERS 미설정 — 로그인 가능한 계정이 없습니다.")
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
app.include_router(files.router, dependencies=_PROTECTED)
app.include_router(system.router, dependencies=_PROTECTED)
app.include_router(notes.router, dependencies=_PROTECTED)
app.include_router(calendar.router, dependencies=_PROTECTED)
app.include_router(settings_router.router, dependencies=_PROTECTED)
app.include_router(ai.router, dependencies=_PROTECTED)


@app.get("/api/health", tags=["meta"])
def health():
    """헬스 체크 (인증 불필요)."""
    s = get_settings()
    return {"ok": True, "storage_exists": s.storage_root.exists()}


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception):
    """미처리 예외 로깅. DEBUG일 때만 상세 노출, 운영은 일반 메시지."""
    logger.exception("미처리 예외 @ %s %s", request.method, request.url.path)
    s = get_settings()
    detail = f"{exc.__class__.__name__}: {exc}" if s.debug else "internal server error"
    return JSONResponse(status_code=500, content={"detail": detail})
