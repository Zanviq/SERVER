"""SERVER 홈서버 백엔드 진입점.

FastAPI 단일 게이트웨이. 인증 미들웨어로 전 API 보호.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api_cache import NoStoreApi
from .auth import COOKIE_NAME, require_owner, require_session, signed_in
from .body_limit import BodyLimit
from .config import get_settings
from .disk_errors import disk_trouble
from .same_origin import SameOriginWrites
from .routers import (
    admin,
    ai,
    auth,
    calendar,
    context,
    diary,
    google,
    links as links_router,
    meetings,
    notes,
    papers,
    search,
    settings as settings_router,
    system,
    terminal,
    todo,
    trash,
    usage,
    vocab,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("server")


def _log_to_disk() -> None:
    """경고·오류를 **파일에도** 남긴다.

    지금까지는 stdout 뿐이었다. 그런데 이 서버는 main 에 푸시할 때마다 컨테이너가
    새로 뜬다 — 그때 `docker logs` 가 통째로 비워진다. 사용자가 "안 돼요"라고
    말할 즈음이면 이미 몇 번 배포된 뒤라, 무슨 일이 있었는지 볼 방법이 없다.
    실제로 신규 사용자의 논문 추출이 실패했을 때 로그가 없어 추측으로 좁혔다.

    저장소 볼륨에 두므로 재시작·배포에도 남는다. 4MB × 3 으로 묶어 디스크를
    잠식하지 않게 한다(라즈베리파이의 SD 카드다).
    """
    from logging.handlers import RotatingFileHandler

    try:
        path = get_settings().storage_root / "logs"
        path.mkdir(parents=True, exist_ok=True)
        h = RotatingFileHandler(path / "server.log", maxBytes=4_000_000, backupCount=3,
                                encoding="utf-8")
        # 경고 이상만. INFO 까지 담으면 접속 기록으로 금세 차서 정작 오류가 밀려 나간다.
        h.setLevel(logging.WARNING)
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        logging.getLogger().addHandler(h)
    except OSError as e:
        # 로그를 못 남기는 것으로 서버가 안 뜨면 안 된다
        logger.warning("로그 파일을 열지 못했습니다(계속 진행): %s", e)


_log_to_disk()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.ensure_storage()
    # 계정 저장소 초기화 — 비어 있으면 .env의 AUTH_USERS를 해시로 1회 이관
    from . import accounts

    # **기동은 계정 파일 때문에 막히지 않는다.** 파일이 깨졌거나 UTF-8 이 아니면
    # 여기서 예외가 올라가 `Application startup failed` 로 끝나고, compose 의
    # `restart: unless-stopped` 때문에 컨테이너가 재시작만 반복한다 — 로그인뿐
    # 아니라 문서·캘린더·할 일·/api/health 까지 전부 내려가고, 무엇이 문제인지
    # 볼 방법도 없다. 손상은 로그인 경로가 503 으로 이미 막고 있으므로(덮어쓰지
    # 않는다), 여기서는 크게 남기고 서버는 띄운다.
    try:
        accounts.ensure_seed(settings)
        empty = not accounts.list_all(settings)
    except Exception:  # noqa: BLE001
        logger.exception(
            "계정 저장소를 읽지 못했습니다 — 로그인은 503 으로 막히지만 서버는 뜹니다. "
            "accounts.json 이 올바른 JSON 목록인지 확인하세요."
        )
        empty = False
    if not settings.session_secret:
        logger.warning("SESSION_SECRET 미설정 — 로그인이 503으로 거부됩니다.")
    if empty:
        logger.warning(
            "계정이 없습니다 — .env의 AUTH_USERS로 최초 관리자를 만들거나 가입 후 승인이 필요합니다."
        )
    _warm_note_graphs(settings)
    # 지난 프로세스가 내려보내다 만 임시 zip — 이 프로세스에서는 아무도 받고 있지 않다(54차)
    from . import archive

    try:
        archive.sweep_stale(settings, max_age=0)
    except Exception:  # noqa: BLE001 - 청소 실패로 서버가 안 뜨면 안 된다
        logger.exception("임시 zip 을 치우지 못했습니다")
    yield


def _warm_note_graphs(settings) -> None:
    """활성 사용자의 문서 그래프를 뒤에서 미리 만든다(notes_graph.warm_up — 첫 문서 열기가 늦지 않게).

    열쇠는 문서 화면과 같은 **해석한** 문서 루트여야 캐시가 맞는다(storage.user_data_root 가 resolve 한다).
    폴더가 없는 사용자는 건너뛴다(여기서 만들지 않는다). 기동을 막지 않는다.
    """
    import threading

    from . import accounts, notes_graph

    try:
        roots = []
        for a in accounts.list_all(settings):
            d = settings.user_root(a["username"]) / "data"
            if a.get("status") == "active" and d.is_dir():
                roots.append(d.resolve())
    except Exception:  # noqa: BLE001 - 계정 파일 문제는 위에서 이미 알렸다
        return
    if roots:
        threading.Thread(target=notes_graph.warm_up, args=(roots[:20],),
                         name="graph-warmup", daemon=True).start()


app = FastAPI(
    title="SERVER Home Server API",
    description="라즈베리파이 5 홈서버 통합 API (멀티유저)",
    version="0.2.0",
    lifespan=lifespan,
)

settings = get_settings()

# 이 앱 밖에서 쿠키를 싣고 부를 수 있는 출처. CORS 와 CSRF 막기가 **같은 목록**을 쓴다 —
# 따로 적으면 한쪽만 고쳐 "읽기는 되는데 쓰기는 403" 같은 어긋남이 생긴다.
# 자격증명(쿠키)을 쓰므로 와일드카드는 뺀다.
if "*" in settings.cors_origins:
    logger.warning("CORS_ORIGINS에 '*'는 자격증명과 함께 쓸 수 없어 무시됩니다.")
_ALLOWED_ORIGINS = [o for o in settings.cors_origins if o != "*"] or ["http://localhost:5173"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    allow_headers=["Content-Type", "Authorization"],
)
# CSRF: 쓰기 요청은 같은 출처(또는 위에서 연 출처)에서 온 것만. SameSite=Lax 쿠키는
# 형제 서브도메인(*.zanviq.dev)의 요청에도 실린다 — 자세한 까닭은 same_origin.py.
# 가장 바깥에 둔다(마지막에 더한 미들웨어가 가장 먼저 받는다).
app.add_middleware(SameOriginWrites, allowed_origins=_ALLOWED_ORIGINS)
# 본문 크기 한도 — FastAPI 는 본문을 인증보다 먼저 통째로 읽는다. 로그인하지 않은 누구나 큰
# 본문으로 서버 메모리를 비울 수 있었다(90MB × 6 → +1.2GB). 무엇보다 먼저 받는다(body_limit.py).
app.add_middleware(BodyLimit, cookie_name=COOKIE_NAME,
                   upload_limit=lambda: get_settings().max_upload_bytes, signed_in=signed_in)
# /api 응답을 브라우저 캐시에 남기지 않는다(파일은 user_file 이 '늘 묻기'로 따로 정한다 — api_cache.py).
# 가장 바깥 — 위 둘이 거절한 응답(403·413)에도 붙는다.
app.add_middleware(NoStoreApi)

# 공개 라우터(인증 불필요)
app.include_router(auth.router)

# 보호 라우터: 모든 엔드포인트가 유효 세션 요구
_PROTECTED = [Depends(require_session)]
# 시스템 상태·계정 관리는 서버 주인 전용 — 클라이언트에서 숨기는 것만으론 막히지 않는다
_OWNER_ONLY = [Depends(require_owner)]
app.include_router(system.router, dependencies=_OWNER_ONLY)
app.include_router(notes.router, dependencies=_PROTECTED)
app.include_router(calendar.router, dependencies=_PROTECTED)
app.include_router(settings_router.router, dependencies=_PROTECTED)
app.include_router(ai.router, dependencies=_PROTECTED)
app.include_router(todo.router, dependencies=_PROTECTED)
app.include_router(trash.router, dependencies=_PROTECTED)
app.include_router(vocab.router, dependencies=_PROTECTED)
app.include_router(papers.router, dependencies=_PROTECTED)
app.include_router(diary.router, dependencies=_PROTECTED)
app.include_router(meetings.router, dependencies=_PROTECTED)
app.include_router(context.router, dependencies=_PROTECTED)
app.include_router(search.router, dependencies=_PROTECTED)
app.include_router(links_router.router, dependencies=_PROTECTED)
app.include_router(usage.router, dependencies=_PROTECTED)
app.include_router(terminal.router, dependencies=_PROTECTED)
app.include_router(admin.router, dependencies=_OWNER_ONLY)
app.include_router(google.router, dependencies=_PROTECTED)
# 구글 콜백은 브라우저 주소창이 오는 곳이라 의존성이 올리는 401/403 JSON 페이지에
# 사용자를 남기면 안 된다. 권한은 핸들러가 직접 보고, 실패해도 화면으로 돌려보낸다.
app.include_router(google.callback_router)


@app.get("/api/health", tags=["meta"])
def health():
    """헬스 체크 (인증 불필요)."""
    s = get_settings()
    return {"ok": True, "storage_exists": s.storage_root.exists()}


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, exc: RequestValidationError):
    """422 — 무엇이 틀렸는지(자리·까닭)만 돌려준다. **받은 값은 되읊지 않는다.**

    FastAPI 기본 처리는 오류마다 받은 값(input)을 통째로 실어 보낸다. 로그인 창구에 90MB 본문을
    보내면 그 90MB 를 응답에 다시 담아 이벤트 루프에서 JSON 으로 바꿨고(25차: 6개에 12초·
    +2.5GB), 비밀번호 칸의 형식이 틀리면 비밀번호를 응답에 되돌려 줬다. 화면은 loc·msg 만 쓴다.
    """
    errors = [{k: e[k] for k in ("type", "loc", "msg") if k in e} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception):
    """미처리 예외 로깅. DEBUG일 때만 상세 노출, 운영은 일반 메시지."""
    logger.exception("미처리 예외 @ %s %s", request.method, request.url.path)
    s = get_settings()
    # 디스크 문제는 이름을 붙여 준다 — 사용자가 스스로 고칠 수 있는 몇 안 되는 오류다(disk_errors).
    if (named := disk_trouble(exc)) is not None:
        return JSONResponse(status_code=named.status_code, content={"detail": named.detail})
    detail = f"{exc.__class__.__name__}: {exc}" if s.debug else "internal server error"
    return JSONResponse(status_code=500, content={"detail": detail})
