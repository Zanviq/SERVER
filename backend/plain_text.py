"""마크다운 한 덩이 → 한 줄 평문. 목록 미리보기·검색 발췌처럼 **한 줄 요약**을 사람에게 보일 때 쓴다(디자인 25·26차).

원문을 그대로 한 줄로 이으면 `## 시험51 제목 - **굵게** 와 \\`코드\\` - [ ] 할 일 > 인용 | 가 | 나` 처럼 기호가 글보다
먼저 보였다 — 좁은 줄에서는 기호만 남고 잘렸다. 뜻을 가진 글만 남긴다. 화면의 frontend/src/lib/plainLine.ts 와 **같은
규칙**이고, 두 벌은 표본 하나(frontend/test/plainLineCases.json)를 두 시험이 함께 읽어 맞춘다.

모델에게 넘기는 글에는 쓰지 않는다 — 모델은 원문의 짜임(제목·목록)을 읽는다.
"""
from __future__ import annotations

import re

_LINE_RULES = [
    (re.compile(r"^\s*```.*$"), ""),                                   # 코드 울타리 줄(안의 코드는 남긴다)
    (re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$"), ""),  # 표 구분 줄
    (re.compile(r"^\s*(?:>\s?)+"), ""),                                # 인용
    (re.compile(r"^\s*#{1,6}\s+"), ""),                                # 제목
    (re.compile(r"^\s*(?:[-*+]|\d{1,9}[.)])\s+"), ""),                 # 목록 표시
    (re.compile(r"^\s*\[[ xX]\]\s+"), ""),                             # 체크 표시
]
_INLINE_RULES = [
    (re.compile(r"!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]"), r"\1"),       # 위키링크·임베드 → 제목
    (re.compile(r"!\[([^\]]*)\]\([^)]*\)"), r"\1"),                    # 그림 → 대체 글
    (re.compile(r"\[([^\]]+)\]\((?:[^)(]|\([^)]*\))*\)"), r"\1"),      # 링크 → 보이는 글
    (re.compile(r"\*\*|__|~~|=="), ""),                                # 굵게·취소·형광
    (re.compile(r"(^|[^\w*])[*_](?=\S)([^*_]*?\S)[*_](?![\w*])"), r"\1\2"),  # 기울임
    (re.compile(r"`+"), ""),                                           # 코드 기호
    (re.compile(r"\s*\|\s*"), " "),                                    # 표 세로줄
    (re.compile(r"\s+"), " "),
]


def plain_line(md: str) -> str:
    """마크다운 → 한 줄 평문(모듈 설명 참조)."""
    lines = []
    for line in (md or "").splitlines():
        for pat, rep in _LINE_RULES:
            line = pat.sub(rep, line)
        lines.append(line)
    out = " ".join(lines)
    for pat, rep in _INLINE_RULES:
        out = pat.sub(rep, out)
    return out.strip()
