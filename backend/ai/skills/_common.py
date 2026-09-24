"""스킬 공용 상수/헬퍼."""
from __future__ import annotations

# 민감 문서 판정은 backend/sensitive.py 한 곳에 있다(링크·검색도 같은 것을 쓴다).
from ...sensitive import SENSITIVE_KEYWORDS, is_sensitive as _is_sensitive  # noqa: F401

_MAX_READ = 20000
