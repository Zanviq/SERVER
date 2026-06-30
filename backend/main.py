"""TwoEMS 홈서버 백엔드 진입점.

FastAPI 단일 게이트웨이: 파일 관리 + 시스템 모니터링 (+ 향후 AI).
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import get_settings
from .routers import ai, files, system

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("twoems")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 시작 시 저장소 루트 보장.
    settings = get_settings()
    settings.ensure_storage()
    yield


app = FastAPI(
    title="TwoEMS Home Server API",
    description="라즈베리파이 5 홈서버 통합 API (파일·시스템·AI)",
    version="0.1.0",
    lifespan=lifespan,
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(files.router)
app.include_router(system.router)
app.include_router(ai.router)


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception):
    """미처리 예외를 traceback과 함께 로깅하고, 실제 원인을 JSON으로 반환.

    기본 핸들러는 'Internal Server Error' 문자열만 주어 디버깅이 어렵다.
    """
    logger.exception("미처리 예외 @ %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": f"{exc.__class__.__name__}: {exc}"},
    )


@app.get("/api/health", tags=["meta"])
def health():
    """헬스 체크 + 저장소 상태."""
    s = get_settings()
    return {
        "ok": True,
        "storage_root": str(s.storage_root),
        "storage_exists": s.storage_root.exists(),
    }
