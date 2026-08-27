"""쓸 수 있는 Gemini 모델 목록 — 설정 화면의 드롭다운 재료.

목록을 코드에 박아두지 않고 API에서 받아온다. 새 모델이 나올 때마다 코드를
고쳐야 하고, 없는 모델 id를 박아두면 비서가 통째로 죽기 때문이다.
(실제로 조회해 보니 2.5 계열 말고도 3.x 계열이 여럿 있었다.)

다만 계정에 보이는 것을 전부 주면 안 된다. 이미지 생성·TTS·전사·로봇 제어용
모델도 generateContent를 지원한다고 나오지만, 비서로 고르면 도구 호출이
안 되거나 엉뚱한 출력이 나온다. 그래서 대화용이 아닌 것은 걸러낸다.
"""
from __future__ import annotations

import logging
import time

from ..config import Settings

logger = logging.getLogger("server.ai.models")

# 이름에 이 조각이 들어가면 대화용이 아니다 — 이미지/음성/전사/로봇/컴퓨터 제어
_NOT_CHAT = ("-image", "-tts", "transcribe", "robotics", "computer-use", "omni")

# API를 못 부를 때 쓸 최소 목록(키가 없거나 네트워크가 막힌 경우)
_FALLBACK = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]

_CACHE: dict[str, object] = {"at": 0.0, "items": []}
_TTL_SEC = 600  # 10분 — 설정 화면을 열 때마다 외부 호출을 하지 않도록


def _is_chat_model(name: str) -> bool:
    return name.startswith("gemini") and not any(t in name for t in _NOT_CHAT)


def _sort_key(item: dict) -> tuple:
    """최신·상위 모델이 위로 오도록. 버전 내림차순, 그다음 pro > flash > lite."""
    name = item["id"]
    ver = 0.0
    head = name.replace("gemini-", "").split("-")[0]
    try:
        ver = float(head)
    except ValueError:
        ver = 0.0  # gemini-pro-latest 처럼 버전이 없는 별칭
    tier = 0 if "pro" in name else (1 if "flash-lite" not in name else 2)
    preview = 1 if "preview" in name else 0
    return (-ver, preview, tier, name)


def list_models(settings: Settings) -> list[dict]:
    """[{id, label}] — 비서로 쓸 수 있는 모델만."""
    now = time.time()
    if _CACHE["items"] and now - float(_CACHE["at"]) < _TTL_SEC:
        return list(_CACHE["items"])  # type: ignore[arg-type]

    items: list[dict] = []
    if settings.gemini_api_key:
        try:
            from google import genai

            client = genai.Client(api_key=settings.gemini_api_key)
            for m in client.models.list():
                actions = list(getattr(m, "supported_actions", None) or [])
                if actions and "generateContent" not in actions:
                    continue
                name = (getattr(m, "name", "") or "").replace("models/", "")
                if not _is_chat_model(name):
                    continue
                items.append({"id": name, "label": getattr(m, "display_name", "") or name})
        except Exception as e:  # noqa: BLE001 - 외부 API
            logger.warning("모델 목록 조회 실패, 기본 목록 사용: %s", e)

    if not items:
        items = [{"id": n, "label": n} for n in _FALLBACK]

    # 현재 설정된 모델이 목록에 없으면 넣어 준다 — 드롭다운이 빈칸으로 보이면 안 된다
    if settings.gemini_model and not any(i["id"] == settings.gemini_model for i in items):
        items.append({"id": settings.gemini_model, "label": settings.gemini_model})

    items.sort(key=_sort_key)
    _CACHE["at"] = now
    _CACHE["items"] = items
    return list(items)


def is_allowed(settings: Settings, model: str) -> bool:
    """설정에 저장해도 되는 값인가(빈 값 = 서버 기본)."""
    if not model:
        return True
    return any(i["id"] == model for i in list_models(settings))
