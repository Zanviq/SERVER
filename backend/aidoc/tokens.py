"""설정파일(JSON) 기반 AI 토큰 인증 + scope/project 검사."""
from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass

from ..config import Settings

_cache: list[dict] | None = None
_cache_file: str | None = None


@dataclass
class Principal:
    actor: str
    scopes: set[str]
    allowed_projects: list[str]
    name: str = ""

    def can(self, scope: str) -> bool:
        return scope in self.scopes

    def project_ok(self, project: str | None) -> bool:
        if project is None:  # inbox 등 프로젝트 없는 문서
            return True
        return "*" in self.allowed_projects or project in self.allowed_projects


def reload_cache() -> None:
    global _cache, _cache_file
    _cache = None
    _cache_file = None


def _load(settings: Settings) -> list[dict]:
    global _cache, _cache_file
    if _cache is not None and _cache_file == settings.aidoc_tokens_file:
        return _cache
    try:
        with open(settings.aidoc_tokens_file, encoding="utf-8") as f:
            data = json.load(f)
        _cache = data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        _cache = []
    _cache_file = settings.aidoc_tokens_file
    return _cache


def verify_bearer(settings: Settings, token: str) -> Principal | None:
    if not token:
        return None
    h = hashlib.sha256(token.encode("utf-8")).hexdigest()
    for entry in _load(settings):
        stored = str(entry.get("token_sha256", ""))
        if stored and hmac.compare_digest(h, stored):
            return Principal(
                actor=str(entry.get("actor", "ai")),
                scopes=set(entry.get("scopes", [])),
                allowed_projects=list(entry.get("allowed_projects", [])),
                name=str(entry.get("name", "")),
            )
    return None
