"""Cloudflare Access JWT 검증(선택적 방어 계층).

Cloudflare Access 뒤에 두면 오리진 요청에 `Cf-Access-Jwt-Assertion` 헤더(RS256 JWT)가
실린다. 이 JWT를 팀 도메인의 공개 인증서로 검증해, 토큰을 아는 것만으로는 부족하고
Cloudflare Access 정책까지 통과해야 접근되도록 이중화한다.

- 설정(`AIDOC_ACCESS_TEAM_DOMAIN`, `AIDOC_ACCESS_AUD`)이 둘 다 있을 때만 활성화.
- 서명 검증은 `google.auth.jwt`(선언된 의존성) 사용 → 새 pip 의존성 없음.
- 인증서는 `https://<team>/cdn-cgi/access/certs`에서 받아 TTL 캐시.
"""
from __future__ import annotations

import json
import time
from urllib.request import urlopen

from google.auth import jwt as gjwt

from ..config import Settings

_CERTS_TTL = 3600  # 초. Cloudflare 인증서는 드물게 회전.
_cache: dict[str, tuple[float, dict[str, str]]] = {}  # team_domain -> (fetched_at, {kid: cert_pem})


def enabled(settings: Settings) -> bool:
    return bool(settings.aidoc_access_team_domain and settings.aidoc_access_aud)


def reset_cache() -> None:
    _cache.clear()


def _fetch_certs(team_domain: str) -> dict[str, str]:
    url = f"https://{team_domain}/cdn-cgi/access/certs"
    with urlopen(url, timeout=5) as resp:  # noqa: S310 - 고정 https 팀 도메인
        data = json.loads(resp.read().decode("utf-8"))
    certs: dict[str, str] = {}
    for item in data.get("public_certs", []):
        kid, cert = item.get("kid"), item.get("cert")
        if kid and cert:
            certs[kid] = cert
    return certs


def _get_certs(team_domain: str, now: float) -> dict[str, str]:
    ent = _cache.get(team_domain)
    if ent and (now - ent[0]) < _CERTS_TTL:
        return ent[1]
    certs = _fetch_certs(team_domain)
    _cache[team_domain] = (now, certs)
    return certs


def verify(settings: Settings, token: str, certs: dict[str, str] | None = None) -> dict | None:
    """Access JWT 검증. 성공 시 claims, 실패 시 None.

    certs를 넘기면 네트워크 조회를 건너뛴다(테스트/사전주입용).
    """
    if not token:
        return None
    now = time.time()
    try:
        pool = certs if certs is not None else _get_certs(settings.aidoc_access_team_domain, now)
        claims = gjwt.decode(token, certs=pool, audience=settings.aidoc_access_aud)
    except Exception:  # noqa: BLE001 - 서명/aud/exp 오류는 모두 인증 실패
        return None
    if claims.get("iss") != f"https://{settings.aidoc_access_team_domain}":
        return None
    return claims
