"""문서 id 생성 + 안전 파일명."""
from __future__ import annotations

import re
import secrets
import time

_B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford, ULID 계열


def _encode(n: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_B32[n & 31])
        n >>= 5
    return "".join(reversed(out))


def new_document_id() -> str:
    """doc_ + 10자(타임스탬프ms) + 16자(랜덤) = 시간정렬 26자."""
    ts = int(time.time() * 1000)
    return "doc_" + _encode(ts, 10) + _encode(secrets.randbits(80), 16)


_ILLEGAL = re.compile(r"[^0-9a-z가-힣._-]+")


def safe_slug(title: str, fallback: str = "untitled") -> str:
    s = (title or "").strip().lower().replace(" ", "-")
    s = _ILLEGAL.sub("-", s).strip("-._")
    s = re.sub(r"-{2,}", "-", s)
    return s[:80] or fallback


def unique_filename(dir_rel: str, slug: str, existing: set[str]) -> str:
    name = f"{slug}.md"
    if name not in existing:
        return name
    i = 2
    while f"{slug}-{i}.md" in existing:
        i += 1
    return f"{slug}-{i}.md"
