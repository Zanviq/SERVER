"""로컬 폴더 연동 API.

브라우저(File System Access API)가 로컬 폴더를 읽고, 이 API로 웹 폴더와 대조·동기화한다.
  - manifest: 웹 폴더의 파일별 해시/크기/수정시각 (로컬과 대조용)
  - upload  : 로컬 → 웹 반영 (기존본은 휴지통 경유)
  - download: 웹 → 로컬 반영용 바이트 전송

동기화 판단(합집합 미러 + 충돌해결)은 프론트에서 수행한다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse

from ..auth import SessionUser, require_session
from ..config import Settings, get_settings
from ..security_paths import safe_join, to_rel
from ..storage import scope_root
from ..trash import move_to_trash

router = APIRouter(prefix="/api/sync", tags=["sync"])


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# 파일 해시 캐시: abspath -> (size, mtime_ns, hash). size/mtime가 그대로면 재해시 생략.
_HASH_CACHE: dict[str, tuple[int, int, str]] = {}


def _sha256_cached(path: Path, st) -> str:
    key = str(path)
    c = _HASH_CACHE.get(key)
    if c and c[0] == st.st_size and c[1] == st.st_mtime_ns:
        return c[2]
    digest = _sha256(path)
    _HASH_CACHE[key] = (st.st_size, st.st_mtime_ns, digest)
    return digest


def _base_dir(scope: str, path: str, user: SessionUser, settings: Settings) -> tuple[Path, Path]:
    """(scope 루트, 동기화 대상 base 디렉토리) 반환. base 없으면 생성."""
    root = scope_root(scope, user, settings)
    base = safe_join(root, path)
    base.mkdir(parents=True, exist_ok=True)
    return root, base


@router.get("/manifest")
def manifest(
    scope: str = Query("me"),
    path: str = Query(""),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    _, base = _base_dir(scope, path, user, settings)
    files = []
    for p in sorted(base.rglob("*")):
        if not p.is_file():
            continue
        try:
            st = p.stat()
            files.append(
                {
                    "rel": p.relative_to(base).as_posix(),
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "hash": _sha256_cached(p, st),  # 변경 없으면 캐시(전체 재해시 생략)
                }
            )
        except OSError:
            continue
    return {"scope": scope, "path": path, "files": files}


@router.post("/upload")
async def upload(
    request: Request,
    scope: str = Query("me"),
    path: str = Query(""),
    rel: str = Query(...),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """로컬 파일 바이트를 웹 base/rel 에 기록. 기존본은 휴지통으로."""
    root, base = _base_dir(scope, path, user, settings)
    dest = safe_join(base, rel)
    data = await request.body()
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="파일이 너무 큽니다.")

    # 기존본이 있으면 덮어쓰기 전에 휴지통으로 보존 (GitHub식 안전 처리)
    if dest.exists() and dest.is_file():
        move_to_trash("file", scope, dest, to_rel(root, dest), user, settings)

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return {"ok": True, "rel": rel, "hash": _sha256_cached(dest, dest.stat())}


@router.get("/download")
def download(
    scope: str = Query("me"),
    path: str = Query(""),
    rel: str = Query(...),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    _, base = _base_dir(scope, path, user, settings)
    target = safe_join(base, rel)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    return FileResponse(
        target, filename=target.name, media_type="application/octet-stream"
    )
