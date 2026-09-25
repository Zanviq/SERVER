"""화면이 본 값(base)과 지금 값이 다르면 덮지 않는다 — 모아 보내는 긴 글 저장의 충돌 규칙 하나.

긴 글 칸(논문 메모·할 일 설명)은 치는 동안 모아 보낸다(42차). 그러면 화면이 목록을 다시 받기 전에
저장이 나가, 그 사이 다른 기기나 AI 가 바꾼 글을 말없이 덮는다(실측: 다른 기기의 메모가 1.5초 만에
사라졌다). 저장에 화면이 고치기 시작한 값을 실어 보내고, 저장소가 **자기 잠금 안에서** 지금 값과
대조해 다르면 409 로 돌려보낸다. 화면은 그것을 알리거나(논문 메모) 두 글을 합친다(할 일 설명 — 일기와
같은 lib/textMerge). base 를 주지 않는 쪽(AI 스킬 등)은 예전처럼 곧바로 쓴다.

일기는 글 대신 시각(text_at)을 기준으로 삼는다(diary_store.TextConflict) — 모양이 달라 여기로 오지 않는다.
"""
from __future__ import annotations

from fastapi import HTTPException


def refuse_if_changed(current: object, base: object, message: str) -> None:
    """base 가 있고 지금 값과 다르면 409(message). **저장소의 잠금 안에서** 불러야 한다 — 밖에서
    대조하면 대조와 쓰기 사이에 다른 저장이 끼어든다."""
    if base is not None and str(current or "") != str(base):
        raise HTTPException(status_code=409, detail=message)
