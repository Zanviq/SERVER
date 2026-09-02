"""문서 본문 캐시 — 같은 파일을 반복해서 다시 읽지 않는다.

검색은 문서를 하나도 빼놓지 않고 전부 읽는다. 그런데 검색창은 타자를 칠
때마다(300ms 디바운스) 다시 호출되므로, 한 단어를 찾는 동안 벌트 전체를
서너 번 읽게 된다. 실측으로도 검색만 145ms로 다른 API(30ms)보다 다섯 배
느렸고, 그 시간의 대부분은 파싱이 아니라 **파일 읽기 자체**였다
(200건 1.5MB: 읽기 90ms, 디코딩 24ms, 대소문자·검색 4ms).

그래서 본문을 들고 있는다. 무효화는 그래프 캐시와 같은 방식이다 —
mtime과 크기가 그대로면 같은 내용으로 본다. 저장은 os.replace로 갈아
끼우므로 내용이 바뀌면 반드시 mtime이 바뀐다.

원본 그대로 담는다(소문자로 미리 바꿔 두지 않는다). 검색 결과에 보여줄
발췌는 원문이어야 하고, 소문자 변환은 200건에 4ms라 아낄 값어치가 없다.
"""
from __future__ import annotations

import os
import threading
from collections import OrderedDict
from pathlib import Path

# 담아 둘 본문의 총 글자 수 상한. 4KB 문서 기준 2000건쯤 된다.
# 넘으면 오래 안 쓴 것부터 버린다(벌트가 커도 메모리는 이 선에서 멈춘다).
MAX_CHARS = 8_000_000
# 이보다 큰 파일 하나가 상한을 다 차지하지 않게 한다.
MAX_FILE_CHARS = 1_000_000

_lock = threading.Lock()
# 경로 -> (mtime_ns, size, text). OrderedDict를 LRU로 쓴다.
_cache: "OrderedDict[str, tuple[int, int, str]]" = OrderedDict()
_chars = 0


def _key(path: Path) -> str:
    """캐시 열쇠. 같은 파일이면 반드시 같은 문자열이어야 한다.

    담을 때는 순회가 만든 경로(root/rel), 버릴 때는 저장 코드가 만든 경로
    (safe_join 결과)가 온다. 둘이 문자열로 다르면 무효화가 조용히 아무 일도
    하지 않는다. abspath 로 형태를 맞추고, Windows 는 대소문자까지 맞춘다
    (realpath 는 심볼릭 링크를 따라가느라 파일마다 시스템 호출이 붙어서 쓰지 않는다).
    """
    return os.path.normcase(os.path.abspath(str(path)))


def text_of(path: Path, st) -> str | None:
    """문서 본문. 읽을 수 없으면 None.

    `st`는 순회하면서 이미 받아 둔 stat 결과다 — DirEntry.stat()은 디렉터리를
    읽을 때 함께 온 값이라 공짜다. 여기서 다시 stat 하면 그게 비용이 된다.
    """
    key = _key(path)
    fp = (st.st_mtime_ns, st.st_size)
    with _lock:
        hit = _cache.get(key)
        if hit is not None and (hit[0], hit[1]) == fp:
            _cache.move_to_end(key)
            return hit[2]

    try:
        # read_text 는 `\r\n` 을 `\n` 으로 바꿔 읽는다(범용 줄바꿈). 검색에는
        # 큰 차이가 없지만, 같은 캐시를 다른 곳에서 쓰게 되면 원문과 어긋난다.
        text = path.read_bytes().decode("utf-8", errors="replace")
    except OSError:
        with _lock:
            _drop(key)
        return None

    if len(text) > MAX_FILE_CHARS:
        # 큰 파일은 담지 않는다. 담으면 그 하나로 캐시가 다 밀려난다.
        with _lock:
            _drop(key)
        return text

    with _lock:
        _drop(key)
        _cache[key] = (fp[0], fp[1], text)
        global _chars
        _chars += len(text)
        while _chars > MAX_CHARS and len(_cache) > 1:
            old_key, _ = next(iter(_cache.items()))
            _drop(old_key)
    return text


def _drop(key: str) -> None:
    """호출 전에 _lock을 잡고 있어야 한다."""
    global _chars
    old = _cache.pop(key, None)
    if old is not None:
        _chars -= len(old[2])


def invalidate(path: Path) -> None:
    """이 파일의 담아 둔 본문을 버린다(쓰기 직후에 부른다)."""
    with _lock:
        _drop(_key(path))


def clear() -> None:
    """테스트용 — 담아 둔 것을 모두 비운다."""
    global _chars
    with _lock:
        _cache.clear()
        _chars = 0


def stats() -> dict:
    with _lock:
        return {"files": len(_cache), "chars": _chars}
