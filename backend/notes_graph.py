"""노트 위키링크 파싱 + 그래프 빌드 (옵시디언식).

노트는 .md 파일. `[[제목]]` 또는 `[[제목|별칭]]`으로 다른 노트를 참조.
링크는 파일명(확장자 제외, stem)으로 매칭한다.
"""
from __future__ import annotations

import re
from pathlib import Path

_WIKILINK = re.compile(r"\[\[([^\[\]]+?)\]\]")


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


def build_graph(notes_dir: Path) -> dict:
    """노트 디렉토리 전체의 그래프 {nodes, links} 생성.

    nodes: [{id: stem, title: stem, path: rel.md}]
    links: [{source: stem, target: stem}]  (대상 노트가 존재할 때만)
    """
    notes = _iter_notes(notes_dir)
    # stem(소문자) → 실제 stem 매핑 (대소문자 무시 매칭)
    by_key: dict[str, str] = {}
    nodes = []
    for p in notes:
        stem = p.stem
        by_key.setdefault(stem.lower(), stem)
        nodes.append(
            {"id": stem, "title": stem, "path": p.relative_to(notes_dir).as_posix()}
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
    return {"nodes": nodes, "links": links}


def backlinks_for(notes_dir: Path, stem: str) -> list[str]:
    """주어진 노트(stem)를 가리키는 다른 노트들의 stem 목록."""
    graph = build_graph(notes_dir)
    return [
        l["source"]
        for l in graph["links"]
        if l["target"].lower() == stem.lower()
    ]
