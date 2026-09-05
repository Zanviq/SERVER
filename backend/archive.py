"""폴더를 zip 으로 내려보내는 공통 코드.

문서 폴더 받기와 계정 전체 받기가 같은 함수를 쓴다. 예전에는 문서 쪽에만 있었고,
그 안에 이 서버에서 실제로 겪은 것들이 주석으로 쌓여 있었다(메모리 폭발, 한글
파일명, 심볼릭 링크, 1980년 이전 mtime, 이어받기로 깨지는 zip). 두 번째 내보내기를
만들면서 그 지식이 갈라지지 않게 한곳으로 옮긴다.
"""
from __future__ import annotations

import logging
import tempfile
import zipfile
from pathlib import Path

from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .config import Settings

logger = logging.getLogger("server.archive")


def zip_dir(target: Path, *, filename: str, settings: Settings,
            skip_dirs: frozenset[str] = frozenset()) -> FileResponse:
    """target 아래를 통째로 압축해 내려보낸다.

    임시파일 + FileResponse 로 만든다 —
    - BytesIO 는 라즈베리파이에서 사진·영상 폴더를 통째로 메모리에 올린다.
    - FileResponse 가 RFC 5987(`filename*=UTF-8''`)을 붙여줘 한글 이름이 안 깨진다.
      직접 Content-Disposition 을 만들면 손으로 퍼센트 인코딩해야 한다.

    skip_dirs 에 든 이름의 폴더는 건너뛴다(휴지통·임시 폴더).
    """
    # 임시파일을 데이터 볼륨에 만든다 — 컨테이너 기본 /tmp 는 SD카드의 오버레이라
    # 큰 폴더를 압축하면 방금 비운 SD를 다시 채운다.
    tmp_dir = settings.storage_root / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(dir=tmp_dir, suffix=".zip", delete=False)
    tmp.close()
    tmp_path = Path(tmp.name)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in sorted(target.rglob("*")):
                # 심볼릭 링크는 건너뛴다 — 경로 검증은 '요청 경로'만 보므로
                # 루트 밖을 가리키는 링크를 따라가면 그 내용이 통째로 나간다.
                if p.is_symlink() or not p.is_file():
                    continue
                rel = p.relative_to(target)
                if skip_dirs and any(part in skip_dirs for part in rel.parts[:-1]):
                    continue
                try:
                    zf.write(p, arcname=rel.as_posix())
                except (OSError, ValueError) as e:
                    # 1980년 이전 mtime 이나 인코딩 불가 파일명은 zipfile 이 ValueError 를
                    # 낸다. 한 파일 때문에 전체 내보내기를 실패시키지 않고 건너뛴다.
                    logger.warning("압축 제외: %s (%s)", p, e)
    except BaseException:
        # OSError 만 잡으면 ValueError 등이 새어나가 임시파일이 영구히 남는다.
        tmp_path.unlink(missing_ok=True)
        raise

    return FileResponse(
        tmp_path,
        filename=filename,
        media_type="application/zip",
        headers={
            "X-Content-Type-Options": "nosniff",
            # 요청마다 새로 만드는 아카이브라 이어받기를 허용하면 서로 다른 zip 이
            # 이어 붙어 조용히 깨진다(오류도 안 난다).
            "Accept-Ranges": "none",
            "Cache-Control": "no-store",
        },
        background=BackgroundTask(tmp_path.unlink, True),
    )
