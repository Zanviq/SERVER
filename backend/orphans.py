"""색인에 없는데 디스크에 남은 항목 폴더를 치운다.

논문·회의는 **폴더 하나가 곧 항목 하나**다(`papers/<id>/`, `meetings/<id>/`).
지우면 폴더째 휴지통으로 옮겨지고 색인에서도 빠진다. 그런데 몇 분씩 걸리는
백그라운드 작업(받아쓰기·추출)이 그 뒤에 결과를 쓰면, 원자적 쓰기가 부모 폴더를
`mkdir(parents=True)` 로 되살려 **목록에도 휴지통에도 없는 폴더**가 생겼다.
실측: 받아쓰기 도중 지운 회의 4건이 transcript.json 하나만 든 폴더로 남아 있었다.
사용자가 지운 회의의 내용이, 사용자가 지울 방법이 없는 채로 디스크에 남는다.

이제 그 쓰기들은 폴더를 만들지 않는다(`json_store.write_atomic(create_parents=False)`).
여기 있는 것은 **이미 생긴 미아**를 치우는 청소부다.

지우는 것은 사용자 자료라 조건을 좁게 잡는다. 하나라도 어긋나면 손대지 않는다.
  - 이름이 우리 id 모양(32자리 16진수)일 것 — 사람이 만든 폴더는 건드리지 않는다
  - 색인에 없을 것
  - **실물이 없을 것**(논문은 paper.pdf, 회의는 audio.*). 실물이 있으면 색인이
    잠깐 어긋난 것일 수 있으므로 두고 본다 — 놓치는 쪽이 지우는 쪽보다 낫다.
  - 만들어진 지 오래됐을 것 — 올리는 중인 폴더는 아직 실물이 없다(임시 파일로
    받는다). 갓 만든 폴더를 지우면 **업로드 중인 논문을 삼킨다.**
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import threading
import time
from pathlib import Path

logger = logging.getLogger("server.orphans")

ID_RE = re.compile(r"[0-9a-f]{32}")
MIN_AGE = 3600.0        # 1시간. 업로드가 아무리 느려도 이보다 오래 걸리지 않는다
EVERY = 600.0           # 목록을 볼 때마다 훑을 일은 아니다

_last: dict[str, float] = {}
_guard = threading.Lock()


def _due(key: str, every: float) -> bool:
    now = time.time()
    with _guard:
        if now - _last.get(key, 0.0) < every:
            return False
        _last[key] = now
        return True


def sweep(base: Path, known: set[str], primary: str, *,
          key: str = "", every: float = EVERY, min_age: float = MIN_AGE) -> list[str]:
    """`base` 아래 미아 폴더를 지운다. 지운 이름들을 돌려준다.

    `primary` 는 실물 파일 이름의 앞부분("paper.pdf", "audio.").
    `key` 를 주면 그 이름으로 `every` 초에 한 번만 실제로 훑는다.
    """
    if key and not _due(key, every):
        return []
    removed: list[str] = []
    now = time.time()
    try:
        entries = list(os.scandir(base))
    except OSError:
        return removed
    for e in entries:
        try:
            if not e.is_dir(follow_symlinks=False) or not ID_RE.fullmatch(e.name):
                continue
            if e.name in known:
                continue
            names = os.listdir(e.path)
            if any(n.startswith(primary) for n in names):
                continue
            if now - e.stat().st_mtime < min_age:
                continue
        except OSError:
            continue
        try:
            shutil.rmtree(e.path)
            removed.append(e.name)
        except OSError:
            logger.warning("미아 폴더를 지우지 못했다: %s", e.path)
    if removed:
        logger.info("미아 폴더 %d개를 치웠다: %s", len(removed), ", ".join(removed[:5]))
    return removed
