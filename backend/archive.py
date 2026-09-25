"""폴더를 zip 으로 내려보내는 공통 코드.

문서 폴더 받기와 계정 전체 받기가 같은 함수를 쓴다. 예전에는 문서 쪽에만 있었고,
그 안에 이 서버에서 실제로 겪은 것들이 주석으로 쌓여 있었다(메모리 폭발, 한글
파일명, 심볼릭 링크, 1980년 이전 mtime, 이어받기로 깨지는 zip). 두 번째 내보내기를
만들면서 그 지식이 갈라지지 않게 한곳으로 옮긴다.
"""
from __future__ import annotations

import logging
import tempfile
import time
import zipfile
from pathlib import Path

from fastapi.responses import FileResponse

from .config import Settings
from .slots import Slots

logger = logging.getLogger("server.archive")

#: 동시에 **만드는** zip 수 — 사람마다, 서버 전체. 임시 zip 은 크기가 받는 폴더 전체만 하다(계정 전체
#: 받기면 사진·녹음까지)이고 만드는 동안 CPU·디스크를 쓴다. 54차 실측: 전체 받기 여섯을 한꺼번에 부르자
#: 임시 zip 여섯을 동시에 만들었다 — 파이의 외장하드를 몇 배로 채운다.
#: 자리는 **다 만들면** 돌려준다(보내는 동안 쥐지 않는다). 받는 쪽이 읽기를 멈춘 채 연결만 붙들고 있으면
#: (휴대폰이 뒤로 가는 등) 보내기가 끝나지 않는데, 그동안 자리를 쥐면 그 사람은 다시 받을 수도 없었다.
MAX_PER_USER = 1
MAX_TOTAL = 2
#: 이보다 오래된 임시 zip 은 주인이 없다(받기가 끝났거나 서버가 도중에 내려갔다)
STALE_SECONDS = 6 * 3600

_slots = Slots(
    lambda: MAX_PER_USER,
    lambda _n: "이미 내려받기를 만들고 있습니다 — 그것이 끝난 뒤 다시 받아 주세요.",
    total=MAX_TOTAL,
    full="지금 다른 내려받기가 많습니다. 잠시 뒤 다시 해 주세요.",
)


def sweep_stale(settings: Settings, max_age: float = STALE_SECONDS) -> int:
    """주인 없는 임시 zip 을 지운다. 서버가 뜰 때는 max_age=0 — 그때 있는 것은 모두 지난 프로세스의 것이다.
    54차 실측: 내려받는 도중 서버를 죽이자 임시 zip 이 남았고, 예전엔 그것을 치우는 곳이 없었다(배포마다
    서버가 다시 뜬다). 받는 중인 파일을 지워도 리눅스는 열린 손잡이로 끝까지 읽힌다(윈도는 지우기가 실패할 뿐)."""
    tmp_dir = settings.storage_root / ".tmp"
    if not tmp_dir.is_dir():
        return 0
    gone = 0
    now = time.time()
    for p in tmp_dir.glob("*.zip"):
        try:
            if now - p.stat().st_mtime >= max_age:
                p.unlink()
                gone += 1
        except OSError:
            pass
    return gone


class _TempZipResponse(FileResponse):
    """다 보냈든, 받는 쪽이 도중에 끊었든 임시 zip 을 지운다.

    예전엔 BackgroundTask 로 지웠는데, 백그라운드 작업은 응답을 **끝까지 보낸 뒤에만** 돈다. ASGI 2.4 대로
    끊긴 연결에 보내기가 OSError 를 내는 서버에서는 돌지 않아 임시 zip 이 남는다(시험이 그 모양을 흉내 내
    확인한다 — 계정 전체 받기면 그 크기가 사진·녹음까지 전부다). 이 PC 의 uvicorn 은 끊긴 뒤의 보내기를
    조용히 버려 끝까지 돌았으므로 실측에서는 남지 않았다 — 서버가 바뀌어도 남지 않게 finally 로 지운다.
    서버가 보내는 도중 내려가는 것(배포·정전)은 이것으로 못 막는다 — sweep_stale 이 맡는다.
    """

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            Path(self.path).unlink(missing_ok=True)


def zip_dir(target: Path, *, filename: str, settings: Settings, owner: str,
            skip_dirs: frozenset[str] = frozenset()) -> FileResponse:
    """target 아래를 통째로 압축해 내려보낸다.

    임시파일 + FileResponse 로 만든다 —
    - BytesIO 는 라즈베리파이에서 사진·영상 폴더를 통째로 메모리에 올린다.
    - FileResponse 가 RFC 5987(`filename*=UTF-8''`)을 붙여줘 한글 이름이 안 깨진다.
      직접 Content-Disposition 을 만들면 손으로 퍼센트 인코딩해야 한다.

    skip_dirs 에 든 이름의 폴더는 건너뛴다(휴지통·임시 폴더). owner(사용자 이름)마다 동시에 하나,
    서버 전체에 MAX_TOTAL 개까지만 **만든다** — 넘치면 429·503. 자리는 다 만들면 돌려준다.
    """
    release = _slots.claim(owner)
    try:
        return _build(target, filename=filename, settings=settings, skip_dirs=skip_dirs)
    finally:
        release()


def _build(target: Path, *, filename: str, settings: Settings, skip_dirs: frozenset[str]) -> FileResponse:
    # 임시파일을 데이터 볼륨에 만든다 — 컨테이너 기본 /tmp 는 SD카드의 오버레이라
    # 큰 폴더를 압축하면 방금 비운 SD를 다시 채운다.
    tmp_dir = settings.storage_root / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    sweep_stale(settings)
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

    return _TempZipResponse(
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
    )
