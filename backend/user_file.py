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

예전엔 문서 원본·회의 녹음·논문 PDF 가 이 머리글을 제각각 손으로 적었고, 위의 두 규칙은
문서 원본에만 적혀 있었다. (폴더 zip 은 서버가 만든 내려받기 전용이라 archive.py 가 따로 준다.)
"""
from __future__ import annotations

from pathlib import Path

from fastapi.responses import FileResponse

#: 문서로 열면 스크립트가 도는 형식 — sandbox 를 씌운다
SCRIPTABLE_MEDIA = {"image/svg+xml"}
_SANDBOX = "sandbox; default-src 'none'; style-src 'unsafe-inline'"


def user_file(path: Path, media_type: str, *, filename: str | None = None,
              headers: dict[str, str] | None = None) -> FileResponse:
    """`media_type` 은 서버가 정한 값만 넘긴다(올린 쪽이 밝힌 Content-Type 을 넘기지 말 것).
    `filename` 을 주면 내려받기(attachment)가 된다."""
    h = {"X-Content-Type-Options": "nosniff"}
    if media_type in SCRIPTABLE_MEDIA:
        h["Content-Security-Policy"] = _SANDBOX
    h.update(headers or {})
    return FileResponse(path, filename=filename, media_type=media_type, headers=h)
