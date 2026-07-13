"""AI 문서 임베딩 — Gemini 임베딩 계산 + SQLite 벡터 저장 + 코사인 유사도.

- 키(GEMINI_API_KEY)나 SDK가 없으면 자동 비활성(embed_text→None). 문서 저장은 절대 막지 않음.
- 벡터는 정규화(단위길이)해 float32 BLOB로 저장 → 코사인 = 내적(dot). 소규모라 브루트포스.
- `embed_text`는 주입/모킹 가능(테스트는 네트워크 없이 결정론적).
"""
from __future__ import annotations

import array
import logging
import math

from ..config import Settings
from . import db, store

logger = logging.getLogger("server.aidoc.embed")


# ── 벡터 직렬화/수학 ──
def pack(vec: list[float]) -> bytes:
    return array.array("f", vec).tobytes()


def unpack(blob: bytes) -> list[float]:
    a = array.array("f")
    a.frombytes(blob)
    return list(a)


def normalize(vec: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in vec))
    if n <= 0:
        return list(vec)
    return [x / n for x in vec]


def dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


# ── Gemini 임베딩 ──
def embed_text(settings: Settings, text: str, task_type: str | None = None) -> list[float] | None:
    """텍스트 임베딩(정규화 전 원본). 키/SDK 없거나 실패 시 None.

    task_type: 검색 품질을 위해 문서는 'RETRIEVAL_DOCUMENT', 질의는 'RETRIEVAL_QUERY'.
    """
    if not settings.gemini_api_key or not (text and text.strip()):
        return None
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        return None  # SDK 미설치 → 임베딩 비활성(조용히)
    try:
        client = genai.Client(api_key=settings.gemini_api_key)
        resp = client.models.embed_content(
            model=settings.aidoc_embed_model,
            contents=text[: settings.aidoc_embed_max_chars],
            config=types.EmbedContentConfig(
                output_dimensionality=settings.aidoc_embed_dim, task_type=task_type),
        )
        embs = getattr(resp, "embeddings", None)
        if not embs:
            return None
        vals = list(embs[0].values or [])
        return vals or None
    except Exception:  # noqa: BLE001 - SDK 미설치/네트워크/쿼터 등 모두 비활성 처리
        logger.exception("임베딩 계산 실패(best-effort, 무시)")
        return None


# ── 저장/조회 ──
def index_document(settings: Settings, doc_id: str, title: str, content: str,
                   content_hash: str) -> bool:
    """문서 임베딩을 계산해 upsert. best-effort — 실패해도 예외를 전파하지 않음."""
    try:
        text = f"{title}\n\n{content}" if title else content
        vec = embed_text(settings, text, task_type="RETRIEVAL_DOCUMENT")
        if not vec:
            return False
        nvec = normalize(vec)
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        conn = db.connect(settings)
        try:
            conn.execute(
                "INSERT INTO document_embeddings(doc_id,model,dim,vector,content_hash,updated_at) "
                "VALUES (?,?,?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET "
                "model=excluded.model,dim=excluded.dim,vector=excluded.vector,"
                "content_hash=excluded.content_hash,updated_at=excluded.updated_at",
                (doc_id, settings.aidoc_embed_model, len(nvec), pack(nvec), content_hash, now),
            )
            conn.commit()
        finally:
            conn.close()
        return True
    except Exception:  # noqa: BLE001
        logger.exception("임베딩 저장 실패(best-effort, 무시)")
        return False


def load_vectors(settings: Settings, *, project=None, include_trashed=False) -> list[tuple[str, list[float]]]:
    """(doc_id, 정규화벡터) 목록. documents와 JOIN해 프로젝트/휴지통 필터."""
    where = ["e.dim > 0"]
    vals: list = []
    if not include_trashed:
        where.append("d.trashed=0")
    if project is not None:
        where.append("d.project=?"); vals.append(project)
    sql = ("SELECT e.doc_id AS doc_id, e.vector AS vector FROM document_embeddings e "
           "JOIN documents d ON d.id=e.doc_id WHERE " + " AND ".join(where))
    conn = db.connect(settings)
    try:
        rows = conn.execute(sql, vals).fetchall()
    finally:
        conn.close()
    return [(r["doc_id"], unpack(r["vector"])) for r in rows]


def reindex(settings: Settings, projects: list[str] | None = None) -> dict:
    """임베딩 누락/본문 변경(content_hash 불일치) 문서를 일괄 임베딩.

    projects 지정 시 그 프로젝트들만(토큰 권한 격리). None이면 전체(세션/‘*’ 토큰).
    """
    if projects is not None and not projects:
        return {"indexed": 0, "skipped": 0, "failed": 0}
    conn = db.connect(settings)
    try:
        sql = ("SELECT d.id, d.title, d.storage_path, d.content_hash, e.content_hash AS emb_hash "
               "FROM documents d LEFT JOIN document_embeddings e ON e.doc_id=d.id WHERE d.trashed=0")
        vals: list = []
        if projects is not None:
            sql += f" AND d.project IN ({','.join('?' * len(projects))})"
            vals = list(projects)
        rows = conn.execute(sql, vals).fetchall()
    finally:
        conn.close()
    indexed = skipped = failed = 0
    for r in rows:
        if r["emb_hash"] == r["content_hash"]:
            skipped += 1
            continue
        try:
            content = store.read(settings, r["storage_path"])
        except Exception:  # noqa: BLE001 - 파일 없음 등
            failed += 1
            continue
        ok = index_document(settings, r["id"], r["title"], content, r["content_hash"])
        if ok:
            indexed += 1
        else:
            failed += 1
    return {"indexed": indexed, "skipped": skipped, "failed": failed}
