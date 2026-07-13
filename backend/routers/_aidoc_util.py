"""aidoc 라우터 공용 헬퍼 — 도메인 예외/DB 잠금을 HTTP 응답으로 매핑."""
from __future__ import annotations

import sqlite3

from fastapi import HTTPException

from ..aidoc.errors import AidocError


def mapped(fn):
    """서비스 호출을 감싸 AidocError→상태코드, DB 잠금→503으로 매핑한다."""
    try:
        return fn()
    except AidocError as e:
        raise HTTPException(status_code=e.status, detail={"error": e.code, "message": e.message, **e.extra})
    except sqlite3.OperationalError:
        raise HTTPException(status_code=503,
                            detail={"error": "STORAGE_BUSY", "message": "저장소가 잠시 바쁩니다. 다시 시도하세요."})
