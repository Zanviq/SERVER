"""노트 위키링크 파싱 + 그래프 빌드 (옵시디언식).

노트는 .md 파일. `[[제목]]` 또는 `[[제목|별칭]]`으로 다른 노트를 참조.
링크는 파일명(확장자 제외, stem)으로 매칭한다.
"""
from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path

from .storage import walk_all, walk_files

logger = logging.getLogger("server.graph")

_WIKILINK = re.compile(r"\[\[([^\[\]]+?)\]\]")

# (resolved_base, mode) -> (fingerprint, result). 파일시스템 지문으로 자가 무효화.
#
# 열쇠에 요청이 준 folder 문자열을 그대로 쓰면 안 된다. 없는 폴더는 루트로
# 떨어지므로 `?folder=아무거나` 를 바꿔 가며 부르는 것만으로 벌트 전체 그래프
# 사본이 무한히 쌓인다. 해석한 경로로만 잡고, 개수도 묶어 둔다.
_CACHE: dict[tuple, tuple] = {}
_CACHE_MAX = 32


def clear_cache() -> None:
    _CACHE.clear()


def _tree_fingerprint(base: Path) -> tuple:
    """base 하위를 1회 순회한 값싼 지문(.md수·디렉터리수·최대mtime·총크기·이름들).

    본문을 읽지 않으므로 read_text 그래프 빌드보다 훨씬 싸다. 저장 시 mtime이
    바뀌므로 지문이 바뀌어 캐시가 자연히 무효화된다.

    **이름 목록의 해시도 넣는다.** 이름 변경·이동은 개수·크기·mtime 을 하나도
    바꾸지 않아서(옮겨진 파일의 mtime 은 그대로다), 그것만으로는 지문이 같아
    그래프와 백링크가 다음 저장이 있을 때까지 낡은 채로 남았다.

    순회는 walk_all(scandir)로 **한 번만** 한다 — 캐시가 맞아떨어져도 이 지문은
    매번 계산하므로, 여기가 느리면 캐시의 이득이 사라진다.
    """
    if not base.exists():
        return (0, 0, 0, 0, "")
    files, dirs = walk_all(base)
    md = 0
    mx = total = 0
    h = hashlib.blake2b(digest_size=16)
    for f in files:
        if f.rel.endswith(".md"):
            md += 1
            total += f.stat.st_size
            h.update(f.rel.encode("utf-8", "surrogatepass"))
            h.update(b"\0")
        if f.stat.st_mtime_ns > mx:
            mx = f.stat.st_mtime_ns
    for d in dirs:
        h.update(d.encode("utf-8", "surrogatepass"))
        h.update(b"\1")
    return (md, len(dirs), mx, total, h.hexdigest())


#: 코드 울타리(``` 또는 ~~~). 인용·목록 앞머리를 떼고 본다.
_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
#: 인라인 코드 — 백틱 개수가 맞는 구간
_INLINE_CODE = re.compile(r"(`+)(?:.*?)\1", re.S)


def _without_code(text: str) -> str:
    """코드 울타리·인라인 코드를 지운다(길이는 유지하지 않아도 된다).

    편집기·읽기 뷰(wikiTransform)는 코드 안의 `[[제목]]` 을 링크로 보지 않는다.
    여기만 세면 그래프·백링크가 화면과 어긋난다.
    """
    out: list[str] = []
    fence: str | None = None
    for line in text.split("\n"):
        stripped = line.lstrip("> \t")
        m = _FENCE.match(stripped)
        if fence is None and m:
            fence = m.group(1)[0] * 3
            continue
        if fence is not None:
            if m and m.group(1)[0] * 3 == fence:
                fence = None
            continue
        out.append(line)
    return _INLINE_CODE.sub(" ", "\n".join(out))


def parse_wikilinks(text: str) -> list[str]:
    """본문에서 위키링크 대상(제목)들을 추출. 별칭/헤더앵커는 제거."""
    out: list[str] = []
    for raw in _WIKILINK.findall(_without_code(text)):
        target = raw.split("|", 1)[0]  # [[제목|별칭]] → 제목
        target = target.split("#", 1)[0]  # [[제목#섹션]] → 제목
        target = target.strip()
        if target and target not in out:
            out.append(target)
    return out


def _resolve_base(notes_dir: Path, folder: str | None) -> Path:
    """folder(상대경로)로 하위 트리 루트 결정. 벗어나거나 없으면 notes_dir."""
    if not folder:
        return notes_dir
    base = (notes_dir / folder).resolve()
    if base.is_dir() and (base == notes_dir or notes_dir in base.parents):
        return base
    return notes_dir


def build_graph(
    notes_dir: Path, folder: str | None = None, mode: str = "links"
) -> dict:
    """노트 그래프 {nodes, links} 생성.

    - mode="links": folder 하위 노트들의 위키링크 그래프.
        nodes: [{id: stem, title, path, type:"note"}]
    - mode="folders": folder의 직속 하위 폴더를 노드로 (드릴다운).
        nodes: 폴더 [{id: rel, title, path, type:"folder", count}]
             + folder 직속 노트 [{id: stem, ..., type:"note"}]
        links: 그룹(폴더/노트) 간 위키링크 집계.
    """
    base = _resolve_base(notes_dir, folder)
    # 열쇠는 **해석한 경로**로. 요청이 준 folder 문자열을 쓰면 없는 폴더 이름을
    # 바꿔 가며 부르는 것만으로 같은 그래프 사본이 무한히 쌓인다.
    cache_key = (str(notes_dir), str(base), mode)
    fp = _tree_fingerprint(base)
    cached = _CACHE.get(cache_key)
    if cached and cached[0] == fp:
        return cached[1]  # 변경 없음 → 캐시 반환(전체 파일 읽기·파싱 스킵)

    if mode == "folders":
        result = _folder_graph(notes_dir, base)
        _remember(cache_key, fp, result)
        return result

    notes = [f.path for f in walk_files(base) if f.rel.endswith(".md")]
    by_key: dict[str, str] = {}
    nodes = []
    for p in notes:
        stem = p.stem
        by_key.setdefault(stem.lower(), stem)
        nodes.append(
            {
                "id": stem,
                "title": stem,
                "path": p.relative_to(notes_dir).as_posix(),
                "type": "note",
            }
        )

    links = []
    seen = set()
    for p in notes:
        src = p.stem
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for target in parse_wikilinks(text):
            tgt = by_key.get(target.lower())
            if tgt and tgt != src:
                key = (src, tgt)
                if key not in seen:
                    seen.add(key)
                    links.append({"source": src, "target": tgt})
    result = {"nodes": nodes, "links": links}
    _remember(cache_key, fp, result)
    return result


def _remember(key: tuple, fp: tuple, result: dict) -> None:
    """캐시에 담되 개수를 묶어 둔다(가장 오래된 것부터 버린다)."""
    _CACHE.pop(key, None)
    _CACHE[key] = (fp, result)
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)))


def _usable_name(p: Path) -> bool:
    """이름을 UTF-8 로 실어 보낼 수 있는가.

    storage._walk 은 이런 이름을 건너뛰지만 iterdir 은 그대로 준다. 하나만
    있어도 응답을 만들 때 터져서 폴더 모드 그래프가 통째로 500 이 됐다.
    """
    try:
        p.name.encode("utf-8")
        return True
    except UnicodeEncodeError:
        logger.warning("이름을 다룰 수 없어 건너뜀: %r", p)
        return False


def _folder_graph(notes_dir: Path, base: Path) -> dict:
    """base의 직속 하위 폴더(+직속 노트)를 노드로 하는 그래프."""
    try:
        entries = sorted(p for p in base.iterdir() if _usable_name(p))
    except OSError:
        entries = []
    subdirs = [d for d in entries if d.is_dir()]
    loose_notes = [p for p in entries if p.is_file() and p.suffix == ".md"]

    nodes: list[dict] = []
    for d in subdirs:
        rel = d.relative_to(notes_dir).as_posix()
        count = sum(1 for f in walk_files(d, sort=False) if f.rel.endswith(".md"))
        nodes.append(
            {"id": f"f:{rel}", "title": d.name, "path": rel,
             "type": "folder", "count": count}
        )
    for p in loose_notes:
        nodes.append(
            {
                # 폴더 id 와 이름공간을 나눈다. 루트에 `X` 폴더와 `X.md` 가 함께
                # 있으면 id 가 겹쳐 간선이 엉뚱한 데 붙거나 사라졌다.
                "id": f"n:{p.stem}",
                "title": p.stem,
                "path": p.relative_to(notes_dir).as_posix(),
                "type": "note",
            }
        )

    # 노트 → 소속 그룹(직속 하위폴더 rel 또는 직속 노트 stem) 매핑
    def group_of(note: Path) -> str | None:
        try:
            rel_parts = note.relative_to(base).parts
        except ValueError:
            return None
        if len(rel_parts) == 1:  # base 직속 노트
            return f"n:{note.stem}"
        return "f:" + (base / rel_parts[0]).relative_to(notes_dir).as_posix()

    # 전체 스템 → 경로 (base 하위만) 로 위키링크 대상 해석
    all_notes = [f.path for f in walk_files(base, sort=False) if f.rel.endswith(".md")]
    by_key: dict[str, Path] = {}
    for p in all_notes:
        by_key.setdefault(p.stem.lower(), p)

    valid_ids = {n["id"] for n in nodes}
    links = []
    seen = set()
    for p in all_notes:
        g_src = group_of(p)
        if g_src not in valid_ids:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for target in parse_wikilinks(text):
            tp = by_key.get(target.lower())
            if not tp:
                continue
            g_tgt = group_of(tp)
            if g_tgt in valid_ids and g_tgt != g_src:
                key = (g_src, g_tgt)
                if key not in seen:
                    seen.add(key)
                    links.append({"source": g_src, "target": g_tgt})
    return {"nodes": nodes, "links": links}


def backlinks_for(notes_dir: Path, stem: str) -> list[str]:
    """주어진 노트(stem)를 가리키는 다른 노트들의 stem 목록."""
    graph = build_graph(notes_dir)
    return [
        l["source"]
        for l in graph["links"]
        if l["target"].lower() == stem.lower()
    ]
