"""브라우저로 직접 확인할 때 쓰는 백엔드 — 격리된 저장소와 시험 계정으로만 뜬다.

진짜 데이터·진짜 구글 캘린더에 닿지 않게 STORAGE_ROOT 를 저장소 안의
devdata-local/ 로, 계정을 구글 자격증명이 없는 이름으로 못 박는다.

파일 이름이 `_` 로 시작하지 않는 이유: 이 저장소에서 `_*` 는 "지워도 되는
임시 파일" 규약이고, 실제로 정리하다 개발용 데이터가 통째로 날아간 적이 있다.
"""
import json
import os
import pathlib

BASE = pathlib.Path(__file__).parent / "devdata-local"
BASE.mkdir(exist_ok=True)

os.environ["STORAGE_ROOT"] = str(BASE)
os.environ["AUTH_USERS"] = json.dumps(
    [{"username": "tester", "password": "pw123456", "display_name": "검증"}]
)
os.environ["SESSION_SECRET"] = "browser-verify-secret"
os.environ["SESSION_TTL_SECONDS"] = "7200"
os.environ["COOKIE_SECURE"] = "false"
os.environ["CORS_ORIGINS"] = "http://localhost:5173"
os.environ["DEBUG"] = "true"
os.environ["ENABLE_TERMINAL"] = "false"
# 구글 연동 자격증명이 실수로 쓰이지 않게 지운다
for k in list(os.environ):
    if "GOOGLE" in k:
        del os.environ[k]

import uvicorn  # noqa: E402

if __name__ == "__main__":
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, log_level="warning")
