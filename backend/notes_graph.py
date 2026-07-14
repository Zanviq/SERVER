"""노트 위키링크 파싱 + 그래프 빌드 (옵시디언식).

노트는 .md 파일. `[[제목]]` 또는 `[[제목|별칭]]`으로 다른 노트를 참조.
링크는 파일명(확장자 제외, stem)으로 매칭한다.
"""
from __future__ import annotations

import re
import stat as _stat
from pathlib import Path

_WIKILINK = re.compile(r"\[\[([^\[\]]+?)\]\]")

# (notes_dir, folder, mode) -> (fingerprint, result). 파일시스템 지문으로 자가 무효화.
_CACHE: dict[tuple, tuple] = {}


def clear_cache() -> None:
    _CACHE.clear()


def _tree_fingerprint(base: Path) -> tuple:
    """base 하위를 stat만으로 1회 순회한 값싼 지문(.md수·디렉터리수·최대mtime·총크기).

    본문을 읽지 않으므로 read_text 그래프 빌드보다 훨씬 싸다. 저장 시 mtime이
    바뀌므로 지문이 바뀌어 캐시가 자연히 무효화된다.
    """
    if not base.exists():
        return (0, 0, 0, 0)
    md = dirs = 0
    mx = total = 0
    for p in base.rglob("*"):
        try:
            st = p.stat()
        except OSError:
            continue
        if _stat.S_ISDIR(st.st_mode):
            dirs += 1
            continue
        if p.name.endswith(".md"):
            md += 1
            total += st.st_size
        if st.st_mtime_ns > mx:
            mx = st.st_mtime_ns
    return (md, dirs, mx, total)


def parse_wikilinks(text: str) -> list[str]:
    """본문에서 위키링크 대상(제목)들을 추출. 별칭/헤더앵커는 제거."""
    out: list[str] = []
    for raw in _WIKILINK.findall(text):
        target = raw.split("|", 1)[0]  # [[제목|별칭]] → 제목
        target = target.split("#", 1)[0]  # [[제목#섹션]] → 제목
        target = target.strip()
        if target and target not in out:
            out.append(target)
    return out


def _iter_notes(notes_dir: Path) -> list[Path]:
    if not notes_dir.exists():
        return []
    return sorted(p for p in notes_dir.rglob("*.md") if p.is_file())


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
    cache_key = (str(notes_dir), folder or "", mode)
    fp = _tree_fingerprint(base)
    cached = _CACHE.get(cache_key)
    if cached and cached[0] == fp:
        return cached[1]  # 변경 없음 → 캐시 반환(전체 파일 읽기·파싱 스킵)

    if mode == "folders":
        result = _folder_graph(notes_dir, base)
        _CACHE[cache_key] = (fp, result)
        return result

    notes = sorted(p for p in base.rglob("*.md") if p.is_file())
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
    _CACHE[cache_key] = (fp, result)
    return result


def _folder_graph(notes_dir: Path, base: Path) -> dict:
    """base의 직속 하위 폴더(+직속 노트)를 노드로 하는 그래프."""
    subdirs = sorted(d for d in base.iterdir() if d.is_dir())
    loose_notes = sorted(p for p in base.iterdir() if p.is_file() and p.suffix == ".md")

    nodes: list[dict] = []
    for d in subdirs:
        rel = d.relative_to(notes_dir).as_posix()
        count = sum(1 for p in d.rglob("*.md") if p.is_file())
        nodes.append(
            {"id": rel, "title": d.name, "path": rel, "type": "folder", "count": count}
        )
    for p in loose_notes:
        nodes.append(
            {
                "id": p.stem,
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
            return note.stem
        return (base / rel_parts[0]).relative_to(notes_dir).as_posix()

    # 전체 스템 → 경로 (base 하위만) 로 위키링크 대상 해석
    all_notes = [p for p in base.rglob("*.md") if p.is_file()]
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
