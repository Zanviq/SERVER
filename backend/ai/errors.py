"""AI 호출이 실패했을 때 사람에게 뭐라고 할지.

대화(orchestrator)·논문 추출·회의 받아쓰기·단어장 채우기가 **모두 같은 모델을
같은 키로** 부른다. 그런데 실패했을 때 하는 말은 저마다 달랐다 — 대화만
"사용량 한도를 넘었습니다"라고 구분해 말하고, 나머지 셋은 무슨 일이든
"AI 호출에 실패했습니다." 한 줄이었다.

같은 원인에 서로 다른 말을 하면 그중 하나는 거짓이 된다. 판단은 여기 한 곳에만
둔다.
"""
from __future__ import annotations

#: 사용자가 손쓸 수 있는 실패에만 이름을 붙인다. 예전에는 전부 "잠시 후 다시
#: 시도해 주세요."였는데, 무료 한도를 다 쓴 것도·키가 틀린 것도·설정에서 고른
#: 모델이 없는 것도 같은 말이라 **기다려도 영영 되지 않는 것을 기다리게 했다**.
#: 원문은 절대 내보내지 않는다(경로·키·요청 본문이 섞여 온다).
TROUBLE: tuple[tuple[tuple[str, ...], str], ...] = (
    (("RESOURCE_EXHAUSTED", "429", "quota"),
     "AI 사용량 한도를 넘었습니다. 잠시 뒤에 다시 하거나 설정에서 다른 모델을 골라 보세요."),
    (("API_KEY_INVALID", "API key not valid", "API_KEY_SERVICE_BLOCKED"),
     "AI 키가 올바르지 않습니다. 서버 .env 의 GEMINI_API_KEY 를 확인해 주세요."),
    (("PERMISSION_DENIED", "403"),
     "이 AI 키로는 지금 고른 모델을 쓸 수 없습니다. 설정에서 다른 모델을 골라 보세요."),
    (("NOT_FOUND", "404", "is not found for API version"),
     "고른 AI 모델을 찾을 수 없습니다. 설정에서 다른 모델을 골라 주세요."),
    (("UNAVAILABLE", "503", "overloaded"),
     "AI 서버가 지금 붐빕니다. 잠시 뒤에 다시 시도해 주세요."),
    (("DEADLINE_EXCEEDED", "504", "timed out", "timeout"),
     "AI 응답이 너무 오래 걸려 끊었습니다. 다시 시도해 주세요."),
)

#: 한 번 더 부르면 대개 되는 것들. 한도 초과·키 오류는 다시 불러도 같다.
_TRANSIENT = ("UNAVAILABLE", "503", "overloaded", "DEADLINE_EXCEEDED", "504",
              "timed out", "timeout", "connection reset", "ServerError")

#: 다시 불러도 같은 결과인 것들. 재시도 판단에서 먼저 걸러 낸다.
_PERMANENT = ("RESOURCE_EXHAUSTED", "429", "quota")


def _has(raw: str, keys: tuple[str, ...]) -> bool:
    low = (raw or "").lower()
    return any(k.lower() in low for k in keys)


def message(raw: str, debug: bool = False) -> str:
    """실패 원문 → 사용자에게 보일 한 줄. 모르는 것은 감춘다."""
    for keys, msg in TROUBLE:
        if _has(raw, keys):
            return msg
    return raw if debug else "잠시 후 다시 시도해 주세요."


def is_transient(raw: str) -> bool:
    """한 번 더 불러 볼 가치가 있는가."""
    if _has(raw, _PERMANENT):
        return False
    return _has(raw, _TRANSIENT)
