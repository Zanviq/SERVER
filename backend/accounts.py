"""계정 저장소 — 가입·승인·권한.

개편 전에는 `.env`의 AUTH_USERS(JSON)에 **평문 비밀번호**가 들어 있었고, 계정을
추가하려면 SSH로 .env를 고치고 재시작해야 했다. 가입 기능이 붙으면 계정이
늘어나므로 저장소로 옮기고 해시로 바꾼다.

- 저장: STORAGE_ROOT/accounts.json (json_store의 원자적 쓰기 + 락)
- 해시: PBKDF2-HMAC-SHA256 (표준 라이브러리만 — 라즈베리파이에서 빌드 부담 없음)
- 상태: pending(승인 대기) | active | rejected | disabled
- 권한: admin | user
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException

from .config import Settings
from .json_store import lock_for, read_json, write_atomic

logger = logging.getLogger("server.accounts")

_ALGO = "pbkdf2_sha256"
_ITERATIONS = 600_000

USERNAME_RE = re.compile(r"^[a-z0-9_-]{3,32}$")
MIN_PASSWORD = 8
# 승인 대기 줄의 상한 — 가입은 인증 없이 부를 수 있어서 막지 않으면 무한히 쌓인다.
MAX_PENDING = 50

ORIGIN_BOOTSTRAP = "bootstrap"   # .env AUTH_USERS로 만들어진 서버 주인
ORIGIN_SIGNUP = "signup"         # 웹 회원가입

STATUS_PENDING = "pending"
STATUS_ACTIVE = "active"
STATUS_REJECTED = "rejected"
STATUS_DISABLED = "disabled"


@dataclass
class Account:
    username: str
    display_name: str
    role: str = "user"
    status: str = STATUS_PENDING
    # 계정이 어떻게 생겼는지. role과 직교한다 —
    # role의 세 번째 값으로 만들면 _admin_count 기반 "마지막 관리자" 가드가 깨진다.
    origin: str = ORIGIN_SIGNUP

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_owner(self) -> bool:
        """.env로 만들어진 서버 주인. 관리 화면·Google 연동은 이 계정만."""
        return self.origin == ORIGIN_BOOTSTRAP and self.role == "admin"

    @property
    def can_login(self) -> bool:
        return self.status == STATUS_ACTIVE


# ── 비밀번호 해시 ──

def hash_password(password: str) -> str:
    """`알고리즘$반복수$salt$hash` — 나중에 반복수를 올려도 옛 해시를 계속 검증한다."""
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return f"{_ALGO}${_ITERATIONS}${b64(salt)}${b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    """상수시간 비교. 형식이 깨졌으면 False."""
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
        if algo != _ALGO:
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), base64.b64decode(salt_b64), int(iters)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, base64.b64decode(hash_b64))


# ── 저장소 ──

def _path(settings: Settings) -> Path:
    return settings.storage_root / "accounts.json"


def _load(settings: Settings) -> list[dict]:
    """계정 목록. 저장소가 아직 없으면 부트스트랩 시드를 먼저 만든다.

    lifespan에서도 시드하지만, 여기서 한 번 더 보장해 기동 순서에 의존하지 않게 한다
    (시드는 멱등이며 파일이 없을 때만 동작한다).
    """
    rows = read_json(_path(settings), None)
    if rows is not None:
        # origin 이 없던 시절의 행을 여기서도 채운다. 예전에는 기동(lifespan)에서만
        # 했는데, 그 한 번을 놓치면(테스트·다른 진입점) 주인이 signup 으로 읽혀
        # 관리 화면이 잠긴다. 이 함수는 멱등이고 채울 게 없으면 쓰지 않는다.
        _backfill_origin(rows, _path(settings), settings)
        return rows
    if rows is None:
        # **파일이 없는 것**과 **읽지 못하는 것**을 구분해야 한다. read_json 은 깨진
        # JSON 에도 기본값을 주므로, 구분하지 않으면 파일이 한 번 잘렸을 때 로그인
        # 한 번으로 .env 계정만 담은 파일을 덮어써 가입 계정이 전부 사라진다.
        if _path(settings).exists():
            raise HTTPException(
                status_code=503,
                detail="계정 파일을 읽을 수 없습니다. 손상됐을 수 있어 아무것도 덮어쓰지 않았습니다.",
            )
        ensure_seed(settings)
        rows = read_json(_path(settings), [])
    return rows


def _save(rows: list[dict], settings: Settings) -> None:
    write_atomic(_path(settings), rows)


def _to_account(row: dict) -> Account:
    return Account(
        username=row["username"],
        display_name=row.get("display_name") or row["username"],
        role=row.get("role", "user"),
        status=row.get("status", STATUS_ACTIVE),
        origin=row.get("origin", ORIGIN_SIGNUP),
    )


def ensure_seed(settings: Settings) -> None:
    """저장소가 비어 있으면 .env의 AUTH_USERS를 해시로 변환해 1회 이관.

    이관 후에도 .env는 지우지 않는다(파일을 지우면 롤백된다). 이관되는 계정은
    내가 직접 넣은 것뿐이므로 admin·active로 둔다.
    """
    p = _path(settings)
    with lock_for(p):
        existing = read_json(p, None)
        if existing is not None:
            _backfill_origin(existing, p, settings)
            return
        if p.exists():
            # 있는데 못 읽는다 = 손상. 여기서 새로 쓰면 계정이 전부 날아간다.
            return
        now = time.time()
        rows = [
            {
                "username": u.username,
                "display_name": u.display_name,
                "password_hash": hash_password(u.password),
                "role": "admin",
                "status": STATUS_ACTIVE,
                "origin": ORIGIN_BOOTSTRAP,
                "created_at": now,
                "approved_at": now,
                "approved_by": "system(.env 이관)",
            }
            for u in settings.users
        ]
        if not rows:
            # 빈 파일을 쓰면 안 된다. 다음 부팅부터는 `existing is not None` 에
            # 걸려 early-return 하므로, .env 를 고쳐 재시작해도 주인 계정이
            # 영영 생기지 않는다(가입은 승인해 줄 사람이 없어 무의미).
            logger.error(
                "AUTH_USERS 에서 이관할 계정이 없다 — accounts.json 을 만들지 않는다."
                " .env 의 AUTH_USERS 를 고치고 다시 시작하면 그때 이관된다."
            )
            return
        write_atomic(p, rows)


def _backfill_origin(rows: list[dict], p: Path, settings: Settings) -> None:
    """origin이 없던 시절에 만들어진 행에 origin을 채운다.

    이 백필이 없으면 실제 배포된 주인 계정이 signup으로 읽혀, 주인 전용 게이트를
    켜는 순간 본인이 잠긴다(ensure_seed가 파일이 있으면 early-return하므로).
    판정 근거는 .env 이관 흔적과 현재 AUTH_USERS 목록 둘 다 본다.
    """
    # 대소문자를 가리지 않는다 — .env 에 `Zanviq`, 계정 파일에 `zanviq` 처럼
    # 다르게 적혀 있으면 주인을 못 알아보고 **본인이 관리 화면에서 잠긴다**.
    seeded = {str(u.username).lower() for u in settings.users}
    changed = False
    for row in rows:
        if row.get("origin"):
            continue
        looks_bootstrap = (
            str(row.get("approved_by", "")).startswith("system(")
            or str(row.get("username", "")).lower() in seeded
        )
        row["origin"] = ORIGIN_BOOTSTRAP if looks_bootstrap else ORIGIN_SIGNUP
        changed = True
    if changed:
        write_atomic(p, rows)


def _match(rows: list[dict], username: str) -> dict | None:
    """아이디로 계정 행을 찾는다. **대소문자를 가리지 않는다.**

    가입은 아이디를 소문자로 낮춰 저장하는데(signup) 조회는 정확히 일치해야 했다.
    그래서 가입할 때 `Jaemin` 이라고 친 사람은 저장된 계정이 `jaemin` 인 줄 모른 채
    같은 문자열로 로그인해 계속 401을 받았고, 시도 제한(소문자 기준으로 센다)까지
    걸려 **올바른 비밀번호로도 자기 계정에 못 들어갔다**. 휴대폰 자판의 자동
    대문자화까지 겹치면 더 잘 일어난다.

    정확히 일치하는 것을 먼저 본다 — .env(AUTH_USERS)로 만든 주인 계정은 대문자를
    쓸 수 있고, 그런 계정이 둘 있을 때 엉뚱한 쪽을 고르면 안 된다.
    """
    key = (username or "").strip()
    for row in rows:
        if row.get("username") == key:
            return row
    low = key.lower()
    for row in rows:
        if str(row.get("username", "")).lower() == low:
            return row
    return None


def find(username: str, settings: Settings) -> Account | None:
    """저장된 이름과 **정확히** 같은 계정. 세션 검증이 쓰는 길이다.

    대소문자를 봐주는 것은 '로그인 편의'이지 신원 규칙이 아니다. 여기까지
    느슨하게 두면, 대소문자만 다른 계정이 둘 있다가 하나가 지워졌을 때 그
    사람의 살아 있는 쿠키가 남은 계정(주인일 수 있다)으로 해석된다.
    실제로 그렇게 주인 전용 화면까지 열렸다.
    """
    for row in _load(settings):
        if row.get("username") == username:
            return _to_account(row)
    return None


def find_for_login(username: str, settings: Settings) -> Account | None:
    """로그인·관리 화면용 — 대소문자를 가리지 않고 찾는다."""
    row = _match(_load(settings), username)
    return _to_account(row) if row else None


def authenticate(username: str, password: str, settings: Settings) -> Account | None:
    """비밀번호가 맞으면 Account(상태 무관), 아니면 None.

    상태 판정은 호출자가 한다 — 승인 대기와 비밀번호 오류를 다르게 안내하기 위해.
    """
    row = _match(_load(settings), username)
    if row is None:
        # 타이밍 차이로 아이디 존재 여부가 새지 않도록 더미 해시를 한 번 계산
        verify_password(password, f"{_ALGO}${_ITERATIONS}$AAAA$AAAA")
        return None
    if not verify_password(password, row.get("password_hash", "")):
        return None
    return _to_account(row)


def list_all(settings: Settings) -> list[dict]:
    """관리 화면용 — 비밀번호 해시는 절대 내보내지 않는다."""
    return [
        {k: v for k, v in row.items() if k != "password_hash"}
        for row in sorted(_load(settings), key=lambda r: r.get("created_at", 0))
    ]


def signup(username: str, password: str, display_name: str, settings: Settings) -> Account:
    """가입 신청 — 승인 전까지 로그인할 수 없다."""
    username = (username or "").strip().lower()
    if not USERNAME_RE.match(username):
        raise HTTPException(
            status_code=400,
            detail="아이디는 영문 소문자·숫자·_·- 3~32자여야 합니다.",
        )
    if len(password or "") < MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"비밀번호는 {MIN_PASSWORD}자 이상이어야 합니다.")

    p = _path(settings)
    # 저장소가 비어 있을 때 가입이 먼저 들어오면, 아래에서 계정 파일을 **새 사용자
    # 한 명만 담아** 만들어 버린다. 그 뒤로는 파일이 있으니 ensure_seed 가 아무 일도
    # 하지 않아 .env(AUTH_USERS)의 주인 계정이 영영 생기지 않는다 — 아무도 서버를
    # 관리할 수 없게 된다. 그래서 먼저 시드를 보장한다(멱등).
    # 락 **밖에서** 부른다 — ensure_seed 가 같은 락을 잡으므로 안에서 부르면 교착이다.
    ensure_seed(settings)
    with lock_for(p):
        # read_json 은 깨진 JSON 에도 기본값([])을 준다. 그대로 쓰면 손상된 계정
        # 파일 위에 **새 신청자 한 명만 담아** 덮어쓰면서 201 "접수되었습니다"를
        # 돌려준다 — 모든 계정이 사라진다. 로그인 경로(_load)는 같은 상황을
        # 503 으로 막는데, 여기만 그 방어를 안 쓰고 있었다.
        rows = read_json(p, None)
        if rows is None:
            if p.exists():
                raise HTTPException(
                    status_code=503,
                    detail="계정 파일을 읽을 수 없습니다. 손상됐을 수 있어 아무것도 덮어쓰지 않았습니다.",
                )
            rows = []
        elif not isinstance(rows, list):
            raise HTTPException(
                status_code=503,
                detail="계정 파일을 읽을 수 없습니다. 손상됐을 수 있어 아무것도 덮어쓰지 않았습니다.",
            )
        # 대소문자만 다른 아이디는 같은 것으로 본다 — 조회가 그렇게 찾기 때문이다.
        if _match(rows, username) is not None:
            raise HTTPException(status_code=409, detail="이미 사용 중인 아이디입니다.")
        # 가입은 로그인 없이 누구나 부를 수 있다. 상한이 없으면 승인 대기 줄만
        # 무한히 쌓여서, 계정 파일이 커지고 그걸 매 요청마다 읽는 인증이 같이
        # 느려진다. 개인 서버라 대기 인원이 이만큼 될 일도 없다.
        if sum(1 for r in rows if r.get("status") == STATUS_PENDING) >= MAX_PENDING:
            raise HTTPException(
                status_code=429,
                detail="승인 대기 중인 가입 신청이 많습니다. 관리자 처리 후 다시 시도해 주세요.",
            )
        rows.append(
            {
                "username": username,
                "display_name": (display_name or "").strip() or username,
                "password_hash": hash_password(password),
                "role": "user",
                "status": STATUS_PENDING,
                "origin": ORIGIN_SIGNUP,
                "created_at": time.time(),
                "approved_at": None,
                "approved_by": None,
            }
        )
        write_atomic(p, rows)
    return Account(username=username, display_name=display_name or username, status=STATUS_PENDING)


def _admin_count(rows: list[dict]) -> int:
    return sum(1 for r in rows if r.get("role") == "admin" and r.get("status") == STATUS_ACTIVE)


def _owner_count(rows: list[dict]) -> int:
    """로그인 가능한 주인 수.

    admin 수만 세면 부족하다 — 가입 사용자를 admin으로 올리는 순간 admin은 2명이
    되지만, 관리 화면·시스템 상태는 origin=bootstrap인 주인만 볼 수 있다. 그 상태로
    주인이 자기를 지우면 아무도 관리 화면에 못 들어가고, ensure_seed는 파일이 있으면
    early-return하므로 재기동해도 복구되지 않는다(SSH로 손봐야 한다).
    """
    return sum(
        1
        for r in rows
        if r.get("origin") == ORIGIN_BOOTSTRAP
        and r.get("role") == "admin"
        and r.get("status") == STATUS_ACTIVE
    )


def _is_last_owner(row: dict, rows: list[dict]) -> bool:
    return (
        row.get("origin") == ORIGIN_BOOTSTRAP
        and row.get("role") == "admin"
        and row.get("status") == STATUS_ACTIVE
        and _owner_count(rows) <= 1
    )


def set_status(username: str, status: str, actor: str, settings: Settings) -> dict:
    """상태 변경. 마지막 관리자를 잠그는 변경은 막는다."""
    if status not in (STATUS_ACTIVE, STATUS_REJECTED, STATUS_DISABLED, STATUS_PENDING):
        raise HTTPException(status_code=400, detail="알 수 없는 상태입니다.")
    p = _path(settings)
    with lock_for(p):
        rows = read_json(p, [])
        row = _match(rows, username)
        if row is None:
            raise HTTPException(status_code=404, detail="계정을 찾을 수 없습니다.")
        # 마지막 관리자를 비활성화하면 아무도 승인할 수 없게 된다
        if (
            row.get("role") == "admin"
            and row.get("status") == STATUS_ACTIVE
            and status != STATUS_ACTIVE
            and _admin_count(rows) <= 1
        ):
            raise HTTPException(status_code=400, detail="마지막 관리자는 비활성화할 수 없습니다.")
        if status != STATUS_ACTIVE and _is_last_owner(row, rows):
            raise HTTPException(status_code=400, detail="마지막 서버 관리자는 비활성화할 수 없습니다.")
        row["status"] = status
        if status == STATUS_ACTIVE:
            row["approved_at"] = time.time()
            row["approved_by"] = actor
        write_atomic(p, rows)
    return {k: v for k, v in row.items() if k != "password_hash"}


def set_role(username: str, role: str, settings: Settings) -> dict:
    if role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="알 수 없는 권한입니다.")
    p = _path(settings)
    with lock_for(p):
        rows = read_json(p, [])
        row = _match(rows, username)
        if row is None:
            raise HTTPException(status_code=404, detail="계정을 찾을 수 없습니다.")
        if row.get("role") == "admin" and role != "admin" and _admin_count(rows) <= 1:
            raise HTTPException(status_code=400, detail="마지막 관리자는 강등할 수 없습니다.")
        if role != "admin" and _is_last_owner(row, rows):
            raise HTTPException(status_code=400, detail="마지막 서버 관리자는 강등할 수 없습니다.")
        row["role"] = role
        write_atomic(p, rows)
    return {k: v for k, v in row.items() if k != "password_hash"}


def delete(username: str, settings: Settings) -> None:
    """계정 삭제. 문서는 남긴다(실수 복구 여지)."""
    p = _path(settings)
    with lock_for(p):
        rows = read_json(p, [])
        row = _match(rows, username)
        if row is None:
            raise HTTPException(status_code=404, detail="계정을 찾을 수 없습니다.")
        if row.get("role") == "admin" and row.get("status") == STATUS_ACTIVE and _admin_count(rows) <= 1:
            raise HTTPException(status_code=400, detail="마지막 관리자는 삭제할 수 없습니다.")
        if _is_last_owner(row, rows):
            raise HTTPException(status_code=400, detail="마지막 서버 관리자는 삭제할 수 없습니다.")
        # 입력 문자열이 아니라 **찾은 행**을 지운다. 대소문자가 다르면
        # 200 OK 를 돌려주면서 계정이 그대로 남아 있었다.
        write_atomic(p, [r for r in rows if r is not row])
