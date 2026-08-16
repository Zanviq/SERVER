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
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException

from .config import Settings
from .json_store import lock_for, read_json, write_atomic

_ALGO = "pbkdf2_sha256"
_ITERATIONS = 600_000

USERNAME_RE = re.compile(r"^[a-z0-9_-]{3,32}$")
MIN_PASSWORD = 8

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
    if rows is None:
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
        write_atomic(p, rows)


def _backfill_origin(rows: list[dict], p: Path, settings: Settings) -> None:
    """origin이 없던 시절에 만들어진 행에 origin을 채운다.

    이 백필이 없으면 실제 배포된 주인 계정이 signup으로 읽혀, 주인 전용 게이트를
    켜는 순간 본인이 잠긴다(ensure_seed가 파일이 있으면 early-return하므로).
    판정 근거는 .env 이관 흔적과 현재 AUTH_USERS 목록 둘 다 본다.
    """
    seeded = {u.username for u in settings.users}
    changed = False
    for row in rows:
        if row.get("origin"):
            continue
        looks_bootstrap = (
            str(row.get("approved_by", "")).startswith("system(")
            or row.get("username") in seeded
        )
        row["origin"] = ORIGIN_BOOTSTRAP if looks_bootstrap else ORIGIN_SIGNUP
        changed = True
    if changed:
        write_atomic(p, rows)


def find(username: str, settings: Settings) -> Account | None:
    for row in _load(settings):
        if row["username"] == username:
            return _to_account(row)
    return None


def authenticate(username: str, password: str, settings: Settings) -> Account | None:
    """비밀번호가 맞으면 Account(상태 무관), 아니면 None.

    상태 판정은 호출자가 한다 — 승인 대기와 비밀번호 오류를 다르게 안내하기 위해.
    """
    row = next((r for r in _load(settings) if r["username"] == username), None)
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
    with lock_for(p):
        rows = read_json(p, [])
        if any(r["username"] == username for r in rows):
            raise HTTPException(status_code=409, detail="이미 사용 중인 아이디입니다.")
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
        row = next((r for r in rows if r["username"] == username), None)
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
        row = next((r for r in rows if r["username"] == username), None)
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
        row = next((r for r in rows if r["username"] == username), None)
        if row is None:
            raise HTTPException(status_code=404, detail="계정을 찾을 수 없습니다.")
        if row.get("role") == "admin" and row.get("status") == STATUS_ACTIVE and _admin_count(rows) <= 1:
            raise HTTPException(status_code=400, detail="마지막 관리자는 삭제할 수 없습니다.")
        if _is_last_owner(row, rows):
            raise HTTPException(status_code=400, detail="마지막 서버 관리자는 삭제할 수 없습니다.")
        write_atomic(p, [r for r in rows if r["username"] != username])
