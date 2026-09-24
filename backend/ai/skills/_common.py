"""스킬 공용 상수/헬퍼."""
from __future__ import annotations

import re

# 민감 문서 판정은 backend/sensitive.py 한 곳에 있다(링크·검색도 같은 것을 쓴다).
from ...sensitive import SENSITIVE_KEYWORDS, is_sensitive as _is_sensitive  # noqa: F401

_MAX_READ = 20000


#: "문서로 남겨 달라"고 실제로 말했는가.
#:
#: 프롬프트가 "정리한 결과는 문서로 남깁니다"라고 무조건 시키고 있어서, 그냥
#: "요약해 줘"에도 2번 중 2번 문서를 만들었다(실측). 문구를 고쳤더니 이번에는
#: 반대로 **"'요약' 문서로 만들어줘"라는 분명한 요청을 2번 중 1번 무시**했다.
#: 프롬프트로 양쪽에 실패했으므로 서버가 직접 본다(단어장 71차와 같은 교훈).
ASK_TO_SAVE = re.compile(
    r"문서|파일|저장|남겨|남기|남겨둬|작성|기록해|기록으로|정리해서 .*(만들|남)"
    r"|만들어 ?줘|만들어 ?주|만들자|추가해|붙여|이어 ?써|덮어"
    r"|\bdoc\b|\bsave\b|\bwrite\b|\bfile\b"
)


def asked_to_save(ctx) -> bool:
    """이번 차례에 사람이 '문서로 남겨 달라'고 했는가.

    안 했으면 만들지 않고 **본문을 그대로 돌려준다** — 모델은 그것을 말로 답하면
    된다. 잘못 판단해도 손해가 다르다: 안 만들면 사용자가 한 번 더 말하면 되고,
    잘못 만들면 만든 적 없는 문서가 쌓이고 같은 이름이면 앞의 것을 덮어쓴다.

    화면이 부른 것(user_message 가 비어 있는 경우)은 사용자가 단추를 눌러
    시킨 일이므로 막지 않는다.
    """
    msg = str(getattr(ctx, "user_message", "") or "")
    return not msg.strip() or bool(ASK_TO_SAVE.search(msg))
