"""AI 문서 의미 그래프 — 노드(문서) + 엣지(임베딩 유사도 + [[제목]] 링크)."""
from __future__ import annotations

import json

from ..config import Settings
from ..notes_graph import parse_wikilinks
from . import db, embeddings, store


def build_graph(settings: Settings, *, project=None, threshold=None, max_edges=None) -> dict:
    threshold = settings.aidoc_graph_edge_threshold if threshold is None else float(threshold)
    max_edges = settings.aidoc_graph_max_edges if max_edges is None else int(max_edges)

    conn = db.connect(settings)
    try:
        where = ["trashed=0"]; vals: list = []
        if project:
            where.append("project=?"); vals.append(project)
        rows = conn.execute(
            f"SELECT id,title,project,tags,version,storage_path FROM documents WHERE {' AND '.join(where)}",
            vals,
        ).fetchall()
    finally:
        conn.close()

    nodes = [
        {"id": r["id"], "title": r["title"], "project": r["project"],
         "tags": json.loads(r["tags"] or "[]"), "version": r["version"]}
        for r in rows
    ]
    links: list[dict] = []

    # ── 임베딩 유사도 엣지(무방향, 노드당 상위 max_edges·threshold 이상) ──
    vecs = dict(embeddings.load_vectors(settings, project=project))
    ids = list(vecs.keys())
    seen_sim: set = set()
    for a in ids:
        sims = sorted(
            ((embeddings.dot(vecs[a], vecs[b]), b) for b in ids if b != a),
            reverse=True,
        )[: max(0, max_edges)]
        for score, b in sims:
            if score < threshold:
                break
            key = tuple(sorted((a, b)))
            if key in seen_sim:
                continue
            seen_sim.add(key)
            links.append({"source": a, "target": b, "weight": round(float(score), 3), "kind": "similar"})

    # ── [[제목]] 링크 엣지(방향, 제목 매칭) ──
    title_to_id: dict[str, str] = {}
    for r in rows:
        title_to_id.setdefault((r["title"] or "").lower(), r["id"])
    seen_link: set = set()
    for r in rows:
        try:
            content = store.read(settings, r["storage_path"])
        except Exception:  # noqa: BLE001 - 파일 없음 등
            continue
        for t in parse_wikilinks(content):
            tid = title_to_id.get((t or "").lower())
            if tid and tid != r["id"] and (r["id"], tid) not in seen_link:
                seen_link.add((r["id"], tid))
                links.append({"source": r["id"], "target": tid, "weight": 1.0, "kind": "link"})

    return {"nodes": nodes, "links": links}
