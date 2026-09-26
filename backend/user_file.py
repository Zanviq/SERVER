"""사용자가 올린 바이트를 되돌려 주는 응답 하나.

올린 파일은 믿을 수 없다. 앱과 **같은 출처**에서 나가므로, 브라우저가 그것을 문서로 열어
스크립트를 돌리면 그 스크립트는 사용자의 모든 API 를 대신 부를 수 있다(세션 쿠키가
httpOnly 라 값을 못 읽어도). /api 응답에는 앱 화면의 CSP 도 붙지 않는다(PDF 내장 뷰어 때문).

그래서 파일을 내보내는 곳은 모두 여기를 지난다:
  - nosniff: 선언한 형식과 다르게 재해석하지 않게. 대신 **선언이 곧 판정**이 되므로
    형식은 서버가 정한 값이어야 한다(40차: 회의 녹음이 올린 쪽이 밝힌 text/html 을 그대로
    선언해 스크립트가 돌았다 — meeting_store.audio_mime 참고).
  - 스크립트를 돌릴 수 있는 형식(SVG)에는 sandbox CSP. 모든 응답에 붙이지 않는 것은 PDF
    내장 뷰어가 sandbox 에서 깨지기 때문이다.

  - 캐시: 브라우저는 보관하되 **쓸 때마다 서버에 묻는다**(private, no-cache + 우리 ETag → 그대로면
    304). 예전엔 Cache-Control 이 없거나(문서 원본) `max-age=3600`(녹음·PDF)이라, 브라우저가 서버에
    묻지 않고 캐시를 썼다 — 파일을 바꿔도 옛 내용이 나왔고, **로그아웃한 뒤에도** 그 주소가 열렸다
    (62차 실측). Starlette 의 FileResponse 는 ETag 를 붙이기만 하고 If-None-Match 는 보지 않는다
    (운영의 1.7 도) — 여기서 304 를 하지 않으면 묻는 것이 곧 통째로 다시 받기가 된다.

예전엔 문서 원본·회의 녹음·논문 PDF 가 이 머리글을 제각각 손으로 적었고, 위의 규칙들은
문서 원본에만 적혀 있었다. (폴더 zip 은 서버가 만든 내려받기 전용이라 archive.py 가 따로 준다.)
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import Request
from fastapi.responses import FileResponse, Response

#: 문서로 열면 스크립트가 도는 형식 — sandbox 를 씌운다
SCRIPTABLE_MEDIA = {"image/svg+xml"}
_SANDBOX = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
#: 보관은 이 브라우저에만(공유 캐시 금지), 쓸 때마다 서버에 묻기 — 로그아웃하면 묻는 순간 401 이다
FILE_CACHE = "private, no-cache"


def _etag(st: os.stat_result) -> str:
    """바뀌면 달라지는 값(수정 시각·크기). 같은 자리에 다른 내용을 써도 시각이 바뀐다."""
    return f'"{st.st_mtime_ns:x}-{st.st_size:x}"'


def _still_fresh(if_none_match: str, tag: str) -> bool:
    """브라우저가 가진 것이 지금 것과 같은가(If-None-Match — 여럿·약한 표시 W/ 도 온다)."""
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True
    return any(t.strip().removeprefix("W/") == tag for t in if_none_match.split(","))


def user_file(request: Request, path: Path, media_type: str, *, filename: str | None = None,
              headers: dict[str, str] | None = None) -> Response:
    """`media_type` 은 서버가 정한 값만 넘긴다(올린 쪽이 밝힌 Content-Type 을 넘기지 말 것).
    `filename` 을 주면 내려받기(attachment)가 된다. request 는 304 판단(If-None-Match)에 쓴다."""
    h = {"X-Content-Type-Options": "nosniff"}
    if media_type in SCRIPTABLE_MEDIA:
        h["Content-Security-Policy"] = _SANDBOX
    h.update({k: v for k, v in (headers or {}).items() if k.lower() != "cache-control"})
    # 캐시 규칙은 부르는 쪽이 바꾸지 못한다 — 녹음·PDF 가 max-age=3600 을 손으로 적어 로그아웃 뒤에도
    # 한 시간 열렸다(62차). 누가 다시 적어도 여기서 이긴다.
    h["Cache-Control"] = FILE_CACHE
    st = path.stat()
    h["ETag"] = _etag(st)
    if _still_fresh(request.headers.get("if-none-match", ""), h["ETag"]):
        return Response(status_code=304, headers=h)
    return FileResponse(path, filename=filename, media_type=media_type, headers=h, stat_result=st)
