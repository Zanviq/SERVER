"""로그아웃한 세션 토큰인가 — 백엔드(backend/session_revoke.py)가 쓴 목록을 읽는다.

웹 터미널은 세션 쿠키를 스스로 검증한다(별도 컨테이너). 백엔드가 로그아웃한 토큰을 거절하게
된 뒤에도 이곳이 목록을 보지 않으면, 로그아웃 전에 복사된 토큰으로 **호스트 셸**이 열린다.
열려 있는 셸은 1분마다 다시 확인하므로(RECHECK_SECONDS) 로그아웃하면 곧 닫힌다.

형식은 백엔드와 같아야 한다: {sha256(토큰): 만료 epoch}. 시험(test_smoke)이 백엔드가 쓴
파일을 이 함수로 읽어 확인한다. 서버 코드(pty·fcntl)와 떼어 둔 것은 그 시험 때문이다.
"""
from __future__ import annotations

import hashlib
import json
import time


def is_revoked(token: str, path: str) -> bool:
    """path 의 목록에 이 토큰이 아직 살아 있게 올라 있는가.

    파일이 없으면 로그아웃한 토큰이 없는 것이다. **있는데 못 읽으면 막는다** — 이곳은 호스트
    셸의 문이라, 모르는 채로 들여보내느니 닫는다(계정 파일을 못 읽을 때와 같은 규칙).
    """
    try:
        with open(path, encoding="utf-8") as f:
            rows = json.load(f)
    except FileNotFoundError:
        return False
    except Exception:  # noqa: BLE001
        return True
    if not isinstance(rows, dict):
        return True
    until = rows.get(hashlib.sha256(token.encode("utf-8")).hexdigest())
    return isinstance(until, (int, float)) and until > time.time()
