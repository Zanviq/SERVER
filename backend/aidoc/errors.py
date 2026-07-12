"""aidoc 도메인 예외 (라우터에서 HTTP로 매핑)."""
from __future__ import annotations


class AidocError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, extra: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra or {}


class NotFound(AidocError):
    def __init__(self, message="문서를 찾을 수 없습니다."):
        super().__init__("NOT_FOUND", message, 404)


class Forbidden(AidocError):
    def __init__(self, message="권한이 없습니다."):
        super().__init__("FORBIDDEN", message, 403)


class BadRequest(AidocError):
    def __init__(self, message="잘못된 요청입니다."):
        super().__init__("BAD_REQUEST", message, 400)


class StorageError(AidocError):
    def __init__(self, message="저장소 오류."):
        super().__init__("STORAGE_ERROR", message, 503)


class VersionConflict(AidocError):
    def __init__(self, expected: int, current: int):
        super().__init__(
            "DOCUMENT_VERSION_CONFLICT",
            f"버전 충돌: expected {expected}, current {current}",
            409,
            {"expected_version": expected, "current_version": current},
        )
