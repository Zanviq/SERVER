"""기본 동작 스모크 테스트. 인증 + 파일 + 시스템 검증."""
import io
import json
import os
import tempfile
import time

os.environ["STORAGE_ROOT"] = tempfile.mkdtemp(prefix="server_test_")
os.environ["AUTH_USERS"] = json.dumps(
    [
        {"username": "tester", "password": "pw123", "display_name": "Tester"},
        {"username": "tester2", "password": "pw456", "display_name": "Tester2"},
    ]
)
os.environ["SESSION_SECRET"] = "test-secret-please-change"
os.environ["SESSION_TTL_SECONDS"] = "3600"
os.environ["DEBUG"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

from backend import accounts, login_guard  # noqa: E402
from backend.config import get_settings  # noqa: E402
from backend.main import app  # noqa: E402

client = TestClient(app)


def _login():
    r = client.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    assert r.status_code == 200, r.text
    return r


# ── 인증 ──
def test_unauthenticated_blocked():
    fresh = TestClient(app)
    assert fresh.get("/api/notes/list").status_code == 401
    assert fresh.get("/api/system").status_code == 401


def test_login_and_session():
    r = _login()
    body = r.json()
    assert body["username"] == "tester"
    assert body["remaining"] > 0
    s = client.get("/api/auth/session")
    assert s.status_code == 200
    assert s.json()["display_name"] == "Tester"


def test_wrong_password():
    bad = TestClient(app)
    r = bad.post("/api/auth/login", json={"username": "tester", "password": "nope"})
    assert r.status_code == 401
    login_guard.reset()


def test_login_throttled_after_repeated_failures():
    """무차별 대입은 몇 번 만에 막혀야 한다 — 401만 계속 돌려주면 제한이 없는 것."""
    login_guard.reset()
    c = TestClient(app)
    wrong = {"username": "tester", "password": "nope"}
    codes = [c.post("/api/auth/login", json=wrong).status_code
             for _ in range(login_guard.FREE_TRIES + 1)]
    assert codes[:login_guard.FREE_TRIES] == [401] * login_guard.FREE_TRIES
    assert codes[-1] == 429

    # 잠긴 동안에는 확인 기회가 하나뿐이다. 그 하나는 위 6번째 시도가 이미 썼다.
    r = c.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) > 0

    login_guard.reset()
    assert c.post("/api/auth/login", json={"username": "tester", "password": "pw123"}).status_code == 200


def test_lockout_cannot_shut_the_owner_out_of_their_own_server():
    """아이디만 아는 사람이 주인을 자기 서버에서 몰아낼 수 없어야 한다.

    아이디만으로 세면 방어 수단이 그대로 공격 수단이 된다 — 잠금이 풀릴 때마다
    5번씩 틀리는 것을 반복하면 대기시간이 상한(10분)에 눌러앉고, 잠긴 동안에는
    올바른 비밀번호도 거절되므로 주인이 영영 못 들어온다(실측으로 재현했다).
    아이디+IP 로 세면 공격자는 자기 IP 만 잠근다.
    """
    login_guard.reset()
    c = TestClient(app)
    attacker = {"X-Client-IP": "203.0.113.9"}
    owner = {"X-Client-IP": "198.51.100.7"}

    for _ in range(login_guard.FREE_TRIES + 1):
        c.post("/api/auth/login", json={"username": "tester", "password": "nope"},
               headers=attacker)
    # 공격자는 자기 IP 에서 막혔다
    assert c.post("/api/auth/login", json={"username": "tester", "password": "nope"},
                  headers=attacker).status_code == 429
    assert login_guard.retry_after("tester", client_ip="203.0.113.9") > 0
    # 주인은 다른 회선에서 그대로 들어온다
    assert login_guard.retry_after("tester", client_ip="198.51.100.7") == 0
    r = c.post("/api/auth/login", json={"username": "tester", "password": "pw123"},
               headers=owner)
    assert r.status_code == 200, r.text
    login_guard.reset()


def test_a_locked_out_person_still_gets_one_check(monkeypatch):
    """같은 회선에서 잠겼어도 **잠금당 한 번은** 올바른 비밀번호가 통해야 한다.

    집에서 오타를 다섯 번 낸 사람이 30초를 꼬박 기다려야 할 이유는 없다.
    확인은 잠금당 한 번뿐이라 공격자가 얻는 추측은 오히려 줄어든다.
    """
    login_guard.reset()
    c = TestClient(app)
    me = {"X-Client-IP": "198.51.100.7"}
    for _ in range(login_guard.FREE_TRIES):
        assert c.post("/api/auth/login", json={"username": "tester", "password": "nope"},
                      headers=me).status_code == 401
    # 여기서 잠긴다. 그래도 올바른 비밀번호는 이번 한 번 통한다.
    r = c.post("/api/auth/login", json={"username": "tester", "password": "pw123"},
               headers=me)
    assert r.status_code == 200, r.text

    # 반대로 잠긴 뒤 틀린 비밀번호를 넣으면 그 한 번을 써 버리고, 그다음은 막힌다
    login_guard.reset()
    for _ in range(login_guard.FREE_TRIES + 1):
        c.post("/api/auth/login", json={"username": "tester", "password": "nope"}, headers=me)
    assert c.post("/api/auth/login", json={"username": "tester", "password": "pw123"},
                  headers=me).status_code == 429
    login_guard.reset()


def test_login_guard_counts_per_account_and_forgets():
    login_guard.reset()
    t0 = 1_000_000.0

    def attempt(who, at):
        """한 번의 로그인 시도(실패)를 흉내낸다. 막혔으면 대기 초를 돌려준다."""
        wait = login_guard.begin_attempt(who, at)
        if wait:
            return wait
        login_guard.end_attempt(who)
        login_guard.record_failure(who, at)
        return 0

    for _ in range(login_guard.FREE_TRIES):
        assert attempt("갑", t0) == 0
    assert attempt("갑", t0) == login_guard.FIRST_DELAY  # 6번째부터 막힌다
    # 다른 아이디는 말려들지 않는다
    assert login_guard.retry_after("을", t0) == 0

    # **잠금이 풀리면 다시 들어올 수 있어야 한다**(안 그러면 영구 잠금이다)
    t1 = t0 + login_guard.FIRST_DELAY + 1
    assert login_guard.retry_after("갑", t1) == 0
    assert attempt("갑", t1) == 0
    # 그다음 잠금은 더 길다 — 무차별 대입은 계속 느려진다
    for _ in range(login_guard.FREE_TRIES - 1):
        attempt("갑", t1)
    assert attempt("갑", t1) == login_guard.FIRST_DELAY * 2

    # 성공하면 기록이 사라진다
    login_guard.record_success("갑")
    assert login_guard.retry_after("갑", t1) == 0
    # 창이 지나면 처음부터 다시 센다
    for _ in range(login_guard.FREE_TRIES):
        attempt("병", t0)
    assert attempt("병", t0 + login_guard.WINDOW + 1) == 0
    login_guard.reset()


def test_login_is_case_insensitive_about_username():
    """가입은 아이디를 소문자로 낮춰 저장한다 — 조회가 대소문자를 가리면 본인이 못 들어온다."""
    login_guard.reset()
    anon = TestClient(app)
    r = anon.post("/api/auth/signup",
                  json={"username": "CaseUser", "password": "pw-long-enough"})
    assert r.status_code == 201, r.text
    assert r.json()["username"] == "caseuser"
    try:
        client.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
        client.post("/api/admin/users/caseuser/approve")

        for typed in ("CaseUser", "caseuser", "CASEUSER"):
            login_guard.reset()
            c = TestClient(app)
            got = c.post("/api/auth/login", json={"username": typed, "password": "pw-long-enough"})
            assert got.status_code == 200, f"{typed}: {got.status_code} {got.text}"

        # 대소문자만 다른 아이디로 또 만들 수 없어야 한다(조회가 같은 것으로 보므로)
        dup = TestClient(app).post(
            "/api/auth/signup", json={"username": "CASEuser", "password": "pw-long-enough"})
        assert dup.status_code == 409, dup.text
    finally:
        accounts.delete("caseuser", get_settings())
        login_guard.reset()


def test_login_guard_does_not_hold_huge_usernames():
    """로그인 아이디에는 길이 제한이 없다 — 그대로 열쇠로 쓰면 메모리가 눌러앉는다."""
    login_guard.reset()
    c = TestClient(app)
    huge = "가" * 20_000
    c.post("/api/auth/login", json={"username": huge, "password": "x"})
    held = sum(len(k) for k in login_guard._states)
    assert held <= login_guard.MAX_KEY_CHARS, held
    login_guard.reset()


def test_login_guard_keeps_locked_entries_when_full():
    """아이디를 바꿔 가며 채우는 것만으로 잠금이 풀리면 제한이 무의미하다."""
    login_guard.reset()
    t0 = 1_000_000.0
    for _ in range(login_guard.FREE_TRIES + 1):
        if login_guard.begin_attempt("피해자", t0) == 0:
            login_guard.end_attempt("피해자")
            login_guard.record_failure("피해자", t0)
    assert login_guard.retry_after("피해자", t0) > 0
    # 실제 요청처럼 넣어야 정리(_prune)가 돈다 — record_failure 만으로는 안 돈다
    for i in range(login_guard.MAX_KEYS + 50):
        login_guard.begin_attempt(f"잡음{i}", t0)
        login_guard.end_attempt(f"잡음{i}")
        login_guard.record_failure(f"잡음{i}", t0)
    assert len(login_guard._states) <= login_guard.MAX_KEYS, "상한이 안 지켜졌다"
    assert login_guard.retry_after("피해자", t0) > 0, "잠긴 항목이 축출됐다"
    login_guard.reset()


def test_login_guard_counts_concurrent_attempts():
    """확인과 기록이 따로 놀면 동시에 보낸 요청이 전부 비밀번호를 시험한다.

    HTTP로만 확인하면 안 된다 — TestClient 는 요청을 사실상 줄 세워 보내서,
    확인과 기록이 갈라져 있어도(retry_after 만 쓰던 옛 코드) 이 테스트가 통과했다
    (돌연변이 검사로 드러났다). 그래서 아직 결과를 모르는 시도가 겹친 상태를
    직접 만들어 본다.
    """
    login_guard.reset()
    t0 = 1_000_000.0
    # 결과를 아직 아무도 안 알려 준 채로 계속 들어오는 상황
    allowed = 0
    for _ in range(login_guard.FREE_TRIES + 5):
        if login_guard.begin_attempt("겹침", t0) == 0:
            allowed += 1
    assert allowed <= login_guard.FREE_TRIES, f"{allowed}건이나 비밀번호 검증까지 갔다"
    # 결과가 돌아오면 다시 받아 준다(정상 사용자가 갇히면 안 된다)
    for _ in range(allowed):
        login_guard.end_attempt("겹침")
    login_guard.reset()
    assert login_guard.begin_attempt("겹침", t0) == 0

    login_guard.reset()
    c = TestClient(app)
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=16) as ex:
        codes = list(ex.map(
            lambda i: c.post("/api/auth/login",
                             json={"username": "tester", "password": f"틀림{i}"}).status_code,
            range(16)))
    assert codes.count(401) <= login_guard.FREE_TRIES + 1, codes
    assert 429 in codes, codes
    login_guard.reset()


def test_save_preserves_bytes_exactly():
    """저장은 사용자가 쓴 바이트를 그대로 남겨야 한다.

    파이썬 텍스트 모드는 줄바꿈을 os.linesep 으로 바꿔 쓴다. Windows 에서
    `\\n` 은 `\\r\\n` 이 되고 이미 `\\r\\n` 인 글은 `\\r\\r\\n` 이 되어 **저장할 때마다
    불어났다**(무작위 왕복 검사 300건 중 202건에서 어긋났다).
    """
    _login()
    cases = {
        "줄바꿈LF.md": "첫 줄\n둘째 줄\n",
        "줄바꿈CRLF.md": "첫 줄\r\n둘째 줄\r\n",
        "줄바꿈CR.md": "첫 줄\r둘째 줄\r",
        "줄바꿈섞임.md": "LF\n CRLF\r\n CR\r 끝",
        "특수문자.md": "탭\t제로폭​이모지😀중문中文\n",
    }
    try:
        for path, body in cases.items():
            assert client.put("/api/notes/save",
                              json={"path": path, "content": body}).status_code == 200
            got = client.get("/api/notes/get", params={"path": path})
            assert got.status_code == 200, got.text
            assert got.json()["content"] == body, (path, repr(got.json()["content"]))
            # 두 번 저장해도 늘어나지 않는다(예전에는 저장할 때마다 커졌다)
            client.put("/api/notes/save", json={"path": path, "content": body})
            again = client.get("/api/notes/get", params={"path": path}).json()["content"]
            assert again == body, (path, repr(again))
    finally:
        for path in cases:
            client.delete(f"/api/notes/delete?path={path}")


def test_concurrent_deletes_all_land_in_trash():
    """동시에 지울 때 한 건도 새면 안 된다 — 남아 있거나 미아가 되면 안 된다.

    JSON 저장이 맨 os.replace 였을 때 Windows 에서 동시 접근이 PermissionError 를
    내며 삭제가 500으로 실패했고, 휴지통에는 목록에 안 보이는 실물만 남았다
    (24건 동시 삭제 12회 중 1회 재현).
    """
    from concurrent.futures import ThreadPoolExecutor

    _login()
    for t in client.get("/api/todo/board").json().get("todos", []):
        client.delete(f"/api/todo/{t['id']}")
    n = 16
    for i in range(n):
        client.post("/api/todo/create", json={"title": f"동시삭제{i}"})
    ids = [t["id"] for t in client.get("/api/todo/board").json()["todos"]]
    assert len(ids) == n, len(ids)
    before = len(client.get("/api/trash/list").json())

    with ThreadPoolExecutor(max_workers=8) as ex:
        codes = list(ex.map(lambda i: client.delete(f"/api/todo/{i}").status_code, ids))

    assert set(codes) == {200}, sorted(set(codes))
    assert client.get("/api/todo/board").json()["todos"] == []
    assert len(client.get("/api/trash/list").json()) - before == n

    # 인덱스와 실물이 어긋나지 않아야 한다(미아가 없어야 한다)
    troot = get_settings().storage_root / "users" / "tester" / ".trash"
    listed = {e["id"] for e in json.loads((troot / "index.json").read_text(encoding="utf-8"))}
    on_disk = {p.name for p in (troot / "data").iterdir()} if (troot / "data").exists() else set()
    assert not (on_disk - listed), f"목록에 없는 실물: {on_disk - listed}"


def test_doc_cache_invalidated_even_when_stat_looks_identical():
    """본문 캐시는 mtime·크기로도 무효화하지만, 둘 다 같을 수 있다.

    파일시스템 시각 해상도가 거칠면 짧은 간격의 두 저장이 같은 mtime 을 받는다.
    길이까지 같으면 옛 내용이 그대로 남는다 — 그래서 write_text_atomic 이 직접
    버린다. 그 경로가 살아 있는지 여기서 못 박는다(시각을 강제로 되돌려 확인).
    """
    import tempfile as _tf
    from pathlib import Path as _Path

    from backend import doc_cache
    from backend.json_store import write_text_atomic

    doc_cache.clear()
    d = _Path(_tf.mkdtemp(prefix="cacheinv_"))
    p = d / "메모.md"
    write_text_atomic(p, "사과나무")
    st = p.stat()
    assert doc_cache.text_of(p, st) == "사과나무"

    write_text_atomic(p, "바나나무")  # 글자 수도 바이트 수도 같다
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))  # mtime 까지 같게 되돌린다
    same = p.stat()
    assert (same.st_mtime_ns, same.st_size) == (st.st_mtime_ns, st.st_size), "전제가 안 맞는다"

    assert doc_cache.text_of(p, same) == "바나나무", "옛 내용을 돌려줬다"

    # 캐시가 실제로 담고 있는지도 본다 — 무효화만 확인하면 '아무것도 안 담는'
    # 구현도 통과한다(그러면 캐시가 있으나 마나다).
    held = doc_cache.stats()
    assert held["files"] >= 1 and held["chars"] >= len("바나나무"), held
    doc_cache.clear()
    assert doc_cache.stats() == {"files": 0, "chars": 0}


def test_upload_writes_through_temp_file():
    """업로드는 대상 파일을 직접 열면 안 된다.

    직접 열면 그 순간 기존 파일이 잘리고, 도중에 실패하면 원본이 사라진다.
    끝 상태만 보는 테스트로는 이 차이가 안 드러나서(돌연변이 검사로 확인),
    '임시 이름에 쓰고 갈아 끼운다'는 규약 자체를 확인한다.
    """
    import base64 as _b64

    seen = []
    real_replace = os.replace

    def spy(src, dst, *a, **kw):
        seen.append((str(src), str(dst)))
        return real_replace(src, dst, *a, **kw)

    _login()
    png = _b64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
    import backend.routers.notes as notes_mod

    notes_mod.os.replace = spy
    try:
        r = client.post("/api/notes/upload", params={"path": "임시확인"},
                        files={"file": ("사진.png", png, "image/png")})
        assert r.status_code == 200, r.text
    finally:
        notes_mod.os.replace = real_replace

    moves = [(s, d) for s, d in seen if d.endswith("사진.png")]
    assert moves, f"os.replace 로 갈아 끼우지 않았다: {seen}"
    src, dst = moves[-1]
    assert ".upload" in src and src != dst, (src, dst)
    client.delete("/api/notes/folder?path=임시확인")


def test_non_utf8_document_is_not_opened_for_editing():
    """errors='replace' 로 열어 주면 한 글자만 고쳐 저장해도 원본이 영구히 깨진다."""
    _login()
    root = get_settings().storage_root / "users" / "tester" / "data"
    root.mkdir(parents=True, exist_ok=True)
    raw = "한글 메모입니다".encode("euc-kr")
    (root / "옛날문서.txt").write_bytes(raw)
    try:
        r = client.get("/api/notes/get", params={"path": "옛날문서.txt"})
        assert r.status_code == 415, f"{r.status_code} {r.text[:120]}"
        assert (root / "옛날문서.txt").read_bytes() == raw, "열기만 했는데 원본이 바뀌었다"
    finally:
        (root / "옛날문서.txt").unlink(missing_ok=True)


def test_surrogate_content_is_client_error_not_crash():
    """짝 없는 서로게이트는 사용자 입력 오류다 — 500 + 스택트레이스가 아니라 400."""
    _login()
    body = json.dumps({"path": "서로게이트.md", "content": "앞 \ud800 뒤"})
    r = client.request("PUT", "/api/notes/save",
                       content=body.encode("utf-8", "surrogatepass"),
                       headers={"Content-Type": "application/json"})
    assert r.status_code == 400, f"{r.status_code} {r.text[:120]}"


def test_signup_does_not_erase_bootstrap_owner():
    """빈 저장소에 가입이 먼저 들어와도 .env 주인 계정은 만들어져야 한다."""
    import tempfile as _tf

    from backend.config import Settings

    prev = os.environ.get("STORAGE_ROOT")
    os.environ["STORAGE_ROOT"] = _tf.mkdtemp(prefix="seedtest_")
    try:
        s = Settings()
        s.ensure_storage()
        accounts.signup("firstcomer", "pw-long-enough", "", s)
        names = {r["username"] for r in accounts.list_all(s)}
        assert "tester" in names, names  # AUTH_USERS 주인
        assert "firstcomer" in names, names
    finally:
        if prev is None:
            del os.environ["STORAGE_ROOT"]
        else:
            os.environ["STORAGE_ROOT"] = prev


def test_session_cookie_secure_follows_request_protocol():
    """HTTPS로 들어오면 Secure, 집 안 평문 접속이면 빼야 한다(빼지 않으면 로그인 불가)."""
    login_guard.reset()
    creds = {"username": "tester", "password": "pw123"}
    https = TestClient(app).post("/api/auth/login", json=creds,
                                 headers={"X-Forwarded-Proto": "https"})
    assert "secure" in https.headers["set-cookie"].lower()
    plain = TestClient(app).post("/api/auth/login", json=creds)
    assert "secure" not in plain.headers["set-cookie"].lower()
    for sc in (https.headers["set-cookie"].lower(), plain.headers["set-cookie"].lower()):
        assert "httponly" in sc and "samesite=lax" in sc


def test_signup_pending_queue_is_capped(monkeypatch):
    """가입은 로그인 없이 부를 수 있다 — 승인 대기 줄이 무한히 쌓이면 안 된다."""
    monkeypatch.setattr(accounts, "MAX_PENDING", 2)
    anon = TestClient(app)
    made = []
    try:
        for i in range(2):
            r = anon.post("/api/auth/signup",
                          json={"username": f"대기{i}".replace("대기", "wait"),
                                "password": "pw-long-enough"})
            assert r.status_code == 201, r.text
            made.append(r.json()["username"])
        over = anon.post("/api/auth/signup",
                         json={"username": "waitover", "password": "pw-long-enough"})
        assert over.status_code == 429, over.text
    finally:
        for u in made:
            accounts.delete(u, get_settings())


def test_logout():
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    assert c.get("/api/system").status_code == 200
    c.post("/api/auth/logout")
    assert c.get("/api/system").status_code == 401


# ── 기능 (인증된 client 사용) ──
def test_health():
    assert client.get("/api/health").status_code == 200


def test_system():
    _login()
    r = client.get("/api/system")
    assert r.status_code == 200
    assert "cpu_percent" in r.json()


def test_file_lifecycle():
    """업로드·조회·원본읽기·삭제 — 문서 API 하나로 처리된다(파일 API는 없어짐)."""
    _login()
    assert client.post("/api/notes/folder", json={"path": "docs"}).status_code == 200
    r = client.post(
        "/api/notes/upload?path=docs",
        files={"file": ("hello.txt", io.BytesIO(b"hi server"), "text/plain")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "text" and r.json()["editable"] is True
    tree = client.get("/api/notes/tree").json()
    assert "docs/hello.txt" in [n["path"] for n in tree["notes"]]
    assert client.get("/api/notes/raw?path=docs/hello.txt").content == b"hi server"
    assert client.delete("/api/notes/delete?path=docs/hello.txt").status_code == 200


def test_path_traversal_blocked():
    _login()
    assert client.get("/api/notes/get?path=../../etc/passwd").status_code == 400


def test_upload_illegal_filename_sanitized():
    _login()
    client.post("/api/notes/folder", json={"path": "san"})
    r = client.post(
        "/api/notes/upload?path=san",
        files={"file": ("re*port?.txt", io.BytesIO(b"x"), "text/plain")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "san/re_port_.txt"


def test_save_keeps_extension_verbatim():
    """저장은 준 경로 그대로. 확장자를 지어내지 않는다.

    예전에는 확장자가 없으면 무조건 .md를 붙여서, 사용자가 'todo.txt'가 아닌
    이름을 넣으면 뭘 만들든 마크다운이 됐고 확장자 없는 파일은 다시 열 수도 없었다.
    """
    _login()
    # 1) 확장자를 적으면 그대로
    r = client.put("/api/notes/save", json={"path": "ext/할일.txt", "content": "x"})
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "ext/할일.txt"
    assert client.get("/api/notes/get?path=ext/할일.txt").json()["content"] == "x"

    # 2) 확장자가 없으면 붙이지 않는다 — 그리고 그 이름으로 다시 열린다
    r = client.put("/api/notes/save", json={"path": "ext/확장자없음", "content": "y"})
    assert r.json()["path"] == "ext/확장자없음"
    paths = {n["path"] for n in client.get("/api/notes/tree").json()["notes"]}
    assert "ext/확장자없음" in paths and "ext/확장자없음.md" not in paths
    assert client.get("/api/notes/get?path=ext/확장자없음").json()["content"] == "y"

    # 3) 위키링크용 .md 폴백은 남아 있다 — [[제목]]으로 여는 경로
    client.put("/api/notes/save", json={"path": "ext/링크대상.md", "content": "z"})
    got = client.get("/api/notes/get?path=ext/링크대상")  # 확장자 없이 요청
    assert got.status_code == 200 and got.json()["path"] == "ext/링크대상.md"

    # 4) 정확히 있는 파일이 폴백보다 우선
    client.put("/api/notes/save", json={"path": "ext/둘다", "content": "plain"})
    client.put("/api/notes/save", json={"path": "ext/둘다.md", "content": "markdown"})
    assert client.get("/api/notes/get?path=ext/둘다").json()["content"] == "plain"


def test_notes_wikilinks_and_graph():
    # 노드 '개수'를 단언하므로 **자기 폴더 안**만 본다. tester2 루트를 통째로 보면
    # 같은 벌트에 .md 를 만드는 다른 테스트(휴지통·내보내기)가 먼저 도는 순간 깨진다.
    client = TestClient(app)
    assert client.post("/api/auth/login",
                       json={"username": "tester2", "password": "pw456"}).status_code == 200
    box = "그래프시험"
    client.post("/api/notes/folder", json={"path": box})
    client.put("/api/notes/save", json={"path": f"{box}/A.md", "content": "see [[B]] and [[C|alias]]"})
    client.put("/api/notes/save", json={"path": f"{box}/B.md", "content": "back to [[A]]"})
    client.put("/api/notes/save", json={"path": f"{box}/C.md", "content": "leaf"})
    # A의 outgoing 링크 + backlinks
    a = client.get(f"/api/notes/get?path={box}/A").json()
    assert set(a["links"]) == {"B", "C"}
    assert a["backlinks"] == ["B"]  # B가 A를 가리킴
    # 그래프: 노드 3, 링크 A->B, A->C, B->A
    g = client.get("/api/notes/graph", params={"folder": box}).json()
    assert len(g["nodes"]) == 3, g["nodes"]
    pairs = {(l["source"], l["target"]) for l in g["links"]}
    assert ("A", "B") in pairs and ("A", "C") in pairs and ("B", "A") in pairs
    # 전문 검색: 내용("alias")으로 매칭
    hits = client.get("/api/notes/search?q=alias").json()
    assert any(h["title"] == "A" for h in hits)
    assert all("snippet" in h for h in hits)


def test_graph_ignores_wikilinks_inside_code():
    """코드 안의 `[[제목]]` 은 링크가 아니다 — 편집기·읽기 뷰와 같은 규칙."""
    from backend.notes_graph import parse_wikilinks

    text = (
        "본문 [[진짜]]\n"
        "```\n[[울타리안]]\n```\n"
        "> ```\n> [[인용속울타리]]\n> ```\n"
        "인라인 `[[백틱안]]` 끝\n"
        "~~~md\n[[물결울타리]]\n~~~\n"
        "마지막 [[또진짜]]\n"
    )
    assert parse_wikilinks(text) == ["진짜", "또진짜"], parse_wikilinks(text)

    # 코드 구간은 **한 문단 안**이다. 빈 줄까지 넘게 두면 문서 앞뒤에 흩어진
    # 백틱 두 개가 그 사이 전부를 코드로 만들어 멀쩡한 링크가 통째로 사라진다.
    bt = chr(96)
    same = f"앞 {bt} 열고\n[[한문단속]]\n뒤 {bt} 닫음"
    apart = f"{bt} 첫 문단\n\n[[다른문단]]\n\n{bt} 마지막 문단"
    assert parse_wikilinks(same) == [], parse_wikilinks(same)
    assert parse_wikilinks(apart) == ["다른문단"], parse_wikilinks(apart)

    # 울타리 없는 옛 표기(4칸 들여쓰기)도 코드다 — 프런트가 그렇게 본다
    indented = "본문\n\n    [[들여쓴것]]\n\n[[바깥]]"
    assert parse_wikilinks(indented) == ["바깥"], parse_wikilinks(indented)

    # `![[사진.png]]` 은 링크가 아니라 임베드다(화면은 그림으로 그린다).
    # 여기서 세면 그래프·백링크에만 있는 유령 링크가 생긴다.
    embed = "![[사진.png]] 와 [[문서]]"
    assert parse_wikilinks(embed) == ["문서"], parse_wikilinks(embed)

    # **중첩 목록의 들여쓰기는 코드가 아니다.** 4칸을 무조건 코드로 보면
    # 흔한 2~3단 목록 안의 링크가 통째로 사라진다.
    for nested in ("- 상위\n    - [[하위링크]]\n",
                   "- 하나\n  - 둘\n    - [[하위링크]]\n",
                   "1. 하나\n    1. [[하위링크]]\n"):
        assert parse_wikilinks(nested) == ["하위링크"], (nested, parse_wikilinks(nested))

    # 울타리 길이를 3으로 뭉개면 안 된다 — 4중 울타리 속 3중 줄이 닫아 버린다
    four = f"{bt * 4}\n{bt * 3}\n[[예시속]]\n{bt * 3}\n{bt * 4}\n\n[[바깥]]"
    assert parse_wikilinks(four) == ["바깥"], parse_wikilinks(four)

    # 목록 항목으로 연 울타리도 울타리다(앞머리를 떼고 봐야 한다)
    inlist = f"- {bt * 3}sh\n  [[코드속]]\n- {bt * 3}\n\n[[바깥2]]"
    assert parse_wikilinks(inlist) == ["바깥2"], parse_wikilinks(inlist)


def test_graph_notices_a_rename():
    """이름을 바꾸면 그래프도 바로 따라와야 한다.

    지문이 (개수·폴더수·최대mtime·총크기)뿐이면 이름 변경·이동은 그중 무엇도
    바꾸지 않아, 다음 저장이 있을 때까지 그래프와 백링크가 낡은 채로 남는다.
    """
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester2", "password": "pw456"})
    box = "이름바꾸기시험"
    c.post("/api/notes/folder", json={"path": box})
    c.put("/api/notes/save", json={"path": f"{box}/원래이름.md", "content": "내용"})

    def titles():
        g = c.get("/api/notes/graph", params={"folder": box}).json()
        return sorted(n["title"] for n in g["nodes"])

    assert titles() == ["원래이름"], titles()
    r = c.post("/api/notes/rename", json={"path": f"{box}/원래이름.md", "new_name": "바뀐이름.md"})
    assert r.status_code == 200, r.text
    assert titles() == ["바뀐이름"], titles()


def test_graph_cache_does_not_grow_with_made_up_folders():
    """없는 폴더 이름을 바꿔 가며 불러도 캐시가 무한히 쌓이거나 밀려나면 안 된다.

    없는 폴더는 루트로 떨어지므로 결과가 같다. 그런데 열쇠에 요청 문자열을
    쓰면 같은 그래프 사본이 이름마다 하나씩 쌓이고, 개수를 묶어 둔 뒤에도
    쓸모 있는 항목(루트 그래프)이 쓰레기에 밀려 축출된다.
    """
    from backend import notes_graph

    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester2", "password": "pw456"})
    notes_graph.clear_cache()
    assert c.get("/api/notes/graph").status_code == 200
    assert len(notes_graph._CACHE) == 1, notes_graph._CACHE.keys()

    for i in range(80):
        assert c.get("/api/notes/graph", params={"folder": f"없는폴더{i}"}).status_code == 200
    assert len(notes_graph._CACHE) <= notes_graph._CACHE_MAX, len(notes_graph._CACHE)
    # 전부 같은(루트) 그래프이므로 항목은 하나뿐이어야 한다
    assert len(notes_graph._CACHE) == 1, notes_graph._CACHE.keys()


def test_category_filter_includes_children():
    """카테고리를 지정하면 하위 카테고리의 할 일도 포함해야 한다.

    화면의 개수는 자손까지 세는데 조회만 정확히 일치를 봐서, AI 의 카테고리 지정
    조회·일괄완료·일괄삭제가 자식 카테고리의 할 일을 통째로 빠뜨렸다.
    """
    from backend import todo_store

    _login()
    parent = client.post("/api/todo/categories", json={"name": "공부"}).json()
    child = client.post("/api/todo/categories",
                        json={"name": "수학", "parent_id": parent["id"]}).json()
    client.post("/api/todo/create", json={"title": "부모직속", "category_id": parent["id"]})
    client.post("/api/todo/create", json={"title": "자식것", "category_id": child["id"]})
    try:
        from backend.auth import SessionUser

        me = SessionUser(username="tester", display_name="T", expires_at=0, remaining=0)
        board = todo_store.board(me, get_settings())
        got = todo_store.filter_todos(board["todos"], category_id=parent["id"],
                                      categories=board["categories"])
        titles = {t["title"] for t in got}
        assert titles == {"부모직속", "자식것"}, titles
    finally:
        for t in client.get("/api/todo/board").json()["todos"]:
            client.delete(f"/api/todo/{t['id']}")
        for cid in (child["id"], parent["id"]):
            client.delete(f"/api/todo/categories/{cid}")


def test_new_todo_order_does_not_collide_after_delete():
    """지운 뒤 추가하면 기존 항목과 order 가 겹쳐 목록 중간에 끼어들었다."""
    _login()
    for t in client.get("/api/todo/board").json()["todos"]:
        client.delete(f"/api/todo/{t['id']}")
    ids = [client.post("/api/todo/create", json={"title": f"순서{i}"}).json()["id"]
           for i in range(3)]
    client.delete(f"/api/todo/{ids[0]}")
    client.post("/api/todo/create", json={"title": "나중에추가"})
    todos = client.get("/api/todo/board").json()["todos"]
    orders = [t["order"] for t in todos]
    assert len(set(orders)) == len(orders), orders
    assert todos[-1]["title"] == "나중에추가", [t["title"] for t in todos]
    for t in todos:
        client.delete(f"/api/todo/{t['id']}")


def test_one_bad_filename_does_not_kill_the_listing():
    """이름을 다룰 수 없는 파일 하나로 문서 목록 전체가 죽으면 안 된다.

    리눅스는 파일명을 바이트로 다뤄서 UTF-8이 아닌 이름이 서로게이트 이스케이프로
    들어온다. 그게 응답 JSON에 실리면 인코딩이 실패해 그 사용자의 목록·트리·그래프가
    통째로 500이 됐다.
    """
    _login()
    root = get_settings().storage_root / "users" / "tester" / "data"
    root.mkdir(parents=True, exist_ok=True)
    (root / "멀쩡한문서.md").write_text("보여야 한다", encoding="utf-8")
    weird = None
    try:
        weird = root / "앞\udcff뒤.md"
        weird.write_text("이상한 이름", encoding="utf-8")
    except (OSError, UnicodeEncodeError, ValueError):
        weird = None  # 이 파일시스템에선 만들 수 없다 — 목록만 확인한다
    try:
        for path, params in (("/api/notes/list", {}), ("/api/notes/tree", {}),
                             ("/api/notes/graph", {}), ("/api/notes/search", {"q": "보여야"})):
            r = client.get(path, params=params)
            assert r.status_code == 200, f"{path}: {r.status_code}"
        paths = {n["path"] for n in client.get("/api/notes/list").json()}
        assert "멀쩡한문서.md" in paths
    finally:
        if weird is not None:
            weird.unlink(missing_ok=True)
        (root / "멀쩡한문서.md").unlink(missing_ok=True)


def test_surrogate_path_is_rejected_not_crashed():
    """짝 없는 서로게이트가 든 경로는 400이어야 한다(내부 호출로도 들어올 수 있다)."""
    import tempfile as _tf
    from pathlib import Path as _Path

    from fastapi import HTTPException

    from backend.security_paths import safe_join

    root = _Path(_tf.mkdtemp(prefix="surr_")).resolve()
    for bad in ("앞\ud800뒤.md", "폴더/\udcff.md"):
        try:
            safe_join(root, bad)
        except HTTPException as e:
            assert e.status_code == 400, e.status_code
        else:
            raise AssertionError(f"통과해 버렸다: {bad!r}")


def test_deleted_account_data_is_not_inherited():
    """같은 아이디로 다시 가입한 사람이 지워진 사람의 데이터를 물려받으면 안 된다."""
    login_guard.reset()
    s = get_settings()
    anon = TestClient(app)
    assert anon.post("/api/auth/signup",
                     json={"username": "leaver", "password": "pw-long-enough"}).status_code == 201
    _login()
    client.post("/api/admin/users/leaver/approve")
    gone = TestClient(app)
    gone.post("/api/auth/login", json={"username": "leaver", "password": "pw-long-enough"})
    gone.put("/api/notes/save", json={"path": "사적인메모.md", "content": "남에게 보이면 안 됨"})

    r = client.delete("/api/admin/users/leaver")
    assert r.status_code == 200, r.text
    assert not s.user_root("leaver").exists(), "사용자 폴더가 그대로 남았다"
    # users/ **밖**으로 치워야 한다. 안에 두면 그 이름(`_deleted-leaver-2026...`)이
    # USERNAME_RE(`^[a-z0-9_-]{3,32}$`)를 통과하는 유효한 아이디라, 그 이름으로
    # 가입해 승인받으면 지워진 사람의 벌트를 그대로 물려받는다.
    leftovers = [p.name for p in (s.storage_root / "users").iterdir()
                 if "leaver" in p.name]
    assert leftovers == [], leftovers

    # 같은 아이디로 다시 가입 → 빈 벌트여야 한다
    TestClient(app).post("/api/auth/signup",
                         json={"username": "leaver", "password": "pw-another-one"})
    client.post("/api/admin/users/leaver/approve")
    again = TestClient(app)
    login_guard.reset()
    again.post("/api/auth/login", json={"username": "leaver", "password": "pw-another-one"})
    docs = [n["path"] for n in again.get("/api/notes/list").json()]
    assert "사적인메모.md" not in docs, docs

    # 실수 복구 여지: 데이터 자체는 남아 있다
    grave = s.storage_root / "deleted-users"
    archived = [p.name for p in grave.iterdir()] if grave.exists() else []
    assert any(n.startswith("leaver-") for n in archived), archived

    client.delete("/api/admin/users/leaver")


def test_moving_one_occurrence_splits_it_out():
    """한 회차만 시간을 옮기면 그 회차만 떨어져 나와야 한다.

    예전에는 시리즈 자체의 start 를 고쳐서 전 회차가 따라 옮겨졌고, 새 시작보다
    앞선 회차는 통째로 사라졌다(8회차 → 7회차). 과거 사고와 같은 유형이다.
    """
    _login()
    made = client.post("/api/calendar/events", json={
        "title": "회차분리시험", "start": "2027-03-01T10:00:00", "end": "2027-03-01T11:00:00",
        "recurrence": "weekly", "recur_until": "2027-04-12"})
    assert made.status_code == 200, made.text

    def occurrences():
        r = client.get("/api/calendar/events", params={"from": "2027-03-01", "to": "2027-04-30"})
        return [e for e in r.json() if e["title"] == "회차분리시험"]

    before = occurrences()
    assert len(before) >= 4, before
    target = before[1]
    day = target["start"][:10]

    moved = client.put(f"/api/calendar/events/{target['id']}", json={
        "title": "회차분리시험", "start": f"{day}T14:00:00", "end": f"{day}T15:00:00"})
    assert moved.status_code == 200, moved.text

    after = occurrences()
    assert len(after) == len(before), f"회차 수가 바뀌었다: {len(before)} → {len(after)}"
    assert after[0]["start"] == before[0]["start"], "시리즈 시작이 밀렸다"
    at_two = [e for e in after if e["start"].endswith("14:00:00")]
    assert len(at_two) == 1, [e["start"] for e in after]
    assert at_two[0]["start"][:10] == day

    for e in after:
        client.delete(f"/api/calendar/events/{e['id']}")


def test_editing_one_occurrence_without_moving_it_keeps_the_series():
    """회차 id 로 제목만 바꿔도 이전 회차가 사라지면 안 된다.

    편집창은 바뀌지 않은 start/end 도 함께 보낸다. 그 값을 시리즈에 그대로 쓰면
    시리즈 시작일이 그 회차 날짜로 밀려 **앞선 회차가 전부 사라진다**.
    """
    _login()
    r = client.post("/api/calendar/events", json={
        "title": "제목만시험", "start": "2027-05-03T09:00:00", "end": "2027-05-03T10:00:00",
        "recurrence": "weekly", "recur_until": "2027-06-14"})
    assert r.status_code == 200, r.text

    def occ():
        got = client.get("/api/calendar/events", params={"from": "2027-05-01", "to": "2027-06-30"})
        return [e for e in got.json() if e["title"].endswith("시험")]

    before = occ()
    assert len(before) >= 4, before
    third = before[2]
    up = client.put(f"/api/calendar/events/{third['id']}", json={
        "title": "제목바꾼시험", "start": third["start"], "end": third["end"]})
    assert up.status_code == 200, up.text

    after = occ()
    assert len(after) == len(before), f"회차 수가 바뀌었다: {len(before)} → {len(after)}"
    assert after[0]["start"] == before[0]["start"], "시리즈 시작이 밀렸다"
    assert all(e["title"] == "제목바꾼시험" for e in after), [e["title"] for e in after]
    for e in after:
        client.delete(f"/api/calendar/events/{e['id']}")


def test_splitting_an_occurrence_keeps_its_length():
    """자정을 넘기는 반복 일정도 한 회차를 옮기면 길이가 유지돼야 한다.

    끝을 '회차 날짜 + 시리즈의 끝 시각'으로 만들면 22:00~다음날 02:00 짜리
    일정이 22:00~같은날 02:00 이 되어 길이가 뒤집힌다.
    """
    from datetime import datetime, timedelta

    _login()
    r = client.post("/api/calendar/events", json={
        "title": "밤샘시험", "start": "2027-07-05T22:00:00", "end": "2027-07-06T02:00:00",
        "recurrence": "weekly", "recur_until": "2027-08-10"})
    assert r.status_code == 200, r.text

    def occ():
        got = client.get("/api/calendar/events", params={"from": "2027-07-01", "to": "2027-08-31"})
        return [e for e in got.json() if e["title"] == "밤샘시험"]

    before = occ()
    assert len(before) >= 3, before
    # 회차의 끝은 시작 다음 날이어야 한다(조회부터 이미 그렇다)
    assert before[1]["end"][:10] != before[1]["start"][:10], before[1]

    target = before[1]
    day = target["start"][:10]
    # **시작만** 옮긴다. end 를 함께 주면 그 값이 그대로 쓰여서, 떼어낸 회차의
    # 끝을 어떻게 계산했는지가 결과에 드러나지 않는다(길이 계산이 틀려도 통과).
    moved = client.put(f"/api/calendar/events/{target['id']}", json={
        "title": "밤샘시험", "start": f"{day}T23:00:00"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["end"] == f"{day[:8]}{int(day[8:]) + 1:02d}T03:00:00", moved.json()

    after = occ()
    assert len(after) == len(before), f"회차 수가 바뀌었다: {len(before)} → {len(after)}"
    for e in after:
        assert e["end"] > e["start"], e
        # 4시간짜리 일정이다 — 길이가 줄거나 뒤집히면 안 된다
        s = datetime.fromisoformat(e["start"])
        assert datetime.fromisoformat(e["end"]) - s == timedelta(hours=4), e

    # 같은(낡은) 회차 id 로 또 옮기면 중복을 만들지 않고 거절해야 한다
    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    again = quiet.put(f"/api/calendar/events/{target['id']}", json={
        "title": "밤샘시험", "start": f"{day}T20:00:00", "end": f"{day}T20:30:00"})
    assert again.status_code == 409, again.text
    assert len(occ()) == len(before), occ()

    for e in occ():
        client.delete(f"/api/calendar/events/{e['id']}")


def test_deleting_a_series_also_removes_occurrences_split_out_of_it():
    """시리즈를 통째로 지우면 옮겨 둔 회차도 함께 사라져야 한다.

    떼어낸 회차가 시리즈와의 연결을 남기지 않으면, "이 반복 일정 전부 지워줘"
    뒤에도 그 하나가 유령처럼 남고 사용자는 어디서 왔는지 알 길이 없다.
    """
    _login()
    made = client.post("/api/calendar/events", json={
        "title": "연결시험", "start": "2027-11-01T09:00:00", "end": "2027-11-01T10:00:00",
        "recurrence": "weekly", "recur_until": "2027-12-06"})
    assert made.status_code == 200, made.text
    series_id = made.json()["id"]

    def occ():
        got = client.get("/api/calendar/events", params={"from": "2027-11-01", "to": "2027-12-31"})
        return [e for e in got.json() if e["title"] == "연결시험"]

    before = occ()
    assert len(before) >= 3, before
    target = before[1]
    day = target["start"][:10]
    moved = client.put(f"/api/calendar/events/{target['id']}", json={
        "title": "연결시험", "start": f"{day}T15:00:00"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["id"] != series_id
    assert len(occ()) == len(before), occ()

    assert client.delete(f"/api/calendar/events/{series_id}").status_code == 200
    assert occ() == [], occ()


def test_deleting_a_series_puts_the_split_occurrence_in_the_trash_too():
    """시리즈를 지우면 떼어낸 회차도 함께 사라진다 — 그것도 되돌릴 수 있어야 한다.

    저장소 안에서 조용히 일어나는 삭제라, 담지 않으면 사용자가 따로 시간을
    고쳐 둔 그 회차를 되찾을 방법이 아예 없다.
    """
    _login()
    client.delete("/api/trash/empty")
    made = client.post("/api/calendar/events", json={
        "title": "회차보관시험", "start": "2028-04-03T09:00:00", "end": "2028-04-03T10:00:00",
        "recurrence": "weekly", "recur_until": "2028-05-08"})
    sid = made.json()["id"]

    def occ():
        got = client.get("/api/calendar/events", params={"from": "2028-04-01", "to": "2028-05-31"})
        return [e for e in got.json() if e["title"] == "회차보관시험"]

    target = occ()[1]
    day = target["start"][:10]
    moved = client.put(f"/api/calendar/events/{target['id']}", json={"start": f"{day}T16:00:00"})
    assert moved.status_code == 200, moved.text
    split_id = moved.json()["id"]

    assert client.delete(f"/api/calendar/events/{sid}").status_code == 200
    assert occ() == [], occ()

    # 떼어낸 회차도 휴지통에 있어야 한다
    items = [e for e in client.get("/api/trash/list").json() if e["kind"] == "event"]
    names = [e["name"] for e in items]
    assert names.count("회차보관시험") >= 2, names
    starts = [str(e.get("event_start", "")) for e in items]
    assert any(s.startswith(day) and "16:00" in s for s in starts), starts
    assert split_id, split_id
    client.delete("/api/trash/empty")


def test_restoring_a_series_keeps_the_occurrences_you_deleted():
    """휴지통에서 반복 일정을 복원할 때 낱개로 지운 회차가 되살아나면 안 된다."""
    _login()
    made = client.post("/api/calendar/events", json={
        "title": "예외복원시험", "start": "2028-02-07T09:00:00", "end": "2028-02-07T10:00:00",
        "recurrence": "weekly", "recur_until": "2028-03-13"})
    assert made.status_code == 200, made.text
    sid = made.json()["id"]

    def occ():
        got = client.get("/api/calendar/events", params={"from": "2028-02-01", "to": "2028-03-31"})
        return [e for e in got.json() if e["title"] == "예외복원시험"]

    before = occ()
    assert len(before) >= 4, before
    # 회차 하나만 지운다
    gone = before[1]
    assert client.delete(f"/api/calendar/events/{gone['id']}").status_code == 200
    assert len(occ()) == len(before) - 1, occ()

    # 시리즈를 통째로 지웠다가 휴지통에서 되살린다
    assert client.delete(f"/api/calendar/events/{sid}").status_code == 200
    entry = next(e for e in client.get("/api/trash/list").json()
                 if e["name"] == "예외복원시험" and e["kind"] == "event")
    assert client.post(f"/api/trash/restore?id={entry['id']}").status_code == 200

    after = occ()
    assert len(after) == len(before) - 1, [e["start"] for e in after]
    assert gone["start"] not in [e["start"] for e in after], "지웠던 회차가 되살아났다"
    for e in after:
        client.delete(f"/api/calendar/events/{e['id']}")
    client.delete("/api/trash/empty")


def test_legacy_timezoned_series_is_not_split_by_a_plain_edit():
    """타임존이 붙은 채 저장된 옛 반복 일정도 제목 수정으로 쪼개지면 안 된다."""
    from backend import calendar_store

    series = {"id": "x", "title": "옛일정", "recurrence": "weekly",
              "start": "2027-09-06T10:00:00+09:00", "end": "2027-09-06T11:00:00+09:00"}
    eid = "x@2027-09-20"
    payload = {"title": "새이름", "start": "2027-09-20T10:00:00", "end": "2027-09-20T11:00:00"}
    assert calendar_store._moves_this_occurrence(eid, payload, series) is False

    # 초를 뺀 표기도 같은 시각이다. 글자로 비교하면 '옮겼다'고 오판해 쪼갠다.
    loose = {"title": "새이름", "start": "2027-09-20T10:00", "end": "2027-09-20T11:00"}
    assert calendar_store._moves_this_occurrence(eid, loose, series) is False

    payload["start"] = "2027-09-20T14:00:00"
    assert calendar_store._moves_this_occurrence(eid, payload, series) is True


def test_session_identity_is_exact_not_case_folded():
    """로그인은 대소문자를 봐주지만 **세션 신원은 저장된 이름 그대로**여야 한다.

    여기까지 느슨하면, 대소문자만 다른 계정이 둘 있다가 하나가 지워졌을 때 그
    사람의 살아 있는 쿠키가 남은 계정(주인일 수 있다)으로 해석된다 — 실제로
    주인 전용 화면까지 열렸다.
    """
    from backend.auth import issue_token

    login_guard.reset()
    s = get_settings()
    ghost = TestClient(app)
    ghost.cookies.set("server_session", issue_token("TESTER", s))  # 대문자만 다른 이름
    assert ghost.get("/api/auth/session").status_code == 401
    assert ghost.get("/api/system").status_code == 401


def test_date_only_due_is_all_day():
    """날짜만 준 마감은 종일이어야 한다 — 아니면 캘린더에 0시 일정으로 뜬다.

    생성 모델의 all_day 기본값이 False 라 payload 에 늘 실렸고, 저장소가 마감
    표기로 판단하는 길이 막혀 있었다(수정 쪽은 None 이라 제대로 동작했다).
    """
    _login()
    made = client.post("/api/todo/create", json={"title": "종일확인", "due": "2027-02-03"})
    assert made.status_code == 200, made.text
    assert made.json()["all_day"] is True, made.json()
    assert made.json()["due"] == "2027-02-03", made.json()

    timed = client.post("/api/todo/create",
                        json={"title": "시각확인", "due": "2027-02-03T14:00"})
    assert timed.json()["all_day"] is False, timed.json()
    assert timed.json()["due"] == "2027-02-03T14:00:00", timed.json()

    # 명시하면 그 값을 따른다
    forced = client.post("/api/todo/create",
                         json={"title": "강제종일", "due": "2027-02-03T14:00", "all_day": True})
    assert forced.json()["all_day"] is True, forced.json()

    for t in client.get("/api/todo/board").json()["todos"]:
        client.delete(f"/api/todo/{t['id']}")


def test_color_rule_is_the_same_everywhere():
    """색 판정도 한 곳에서만 한다 — 일정은 거절하고 할 일은 받아 주면 안 된다.

    관대한 해석(resolve_color)은 모르는 색을 기본색으로 바꿔치기한다. 그러면
    "민트색으로 만들어줘"가 조용히 연두가 되고, 사용자는 자기가 말한 색과 다른
    것을 보게 된다. 일정 쪽만 고쳐 두었더니 할 일·카테고리가 계속 관대했다.
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.ai.skills import calendar as cal_skill
    from backend.auth import SessionUser
    from backend.calendar_colors import strict_color

    assert cal_skill._strict_color is strict_color

    reg = default_registry()
    ctx = SkillContext(
        user=SessionUser(username="tester", display_name="T", expires_at=0, remaining=0),
        settings=get_settings(), today="2026-09-02")
    calls = {
        "일정": ("create_calendar_event", {"title": "색", "start": "2027-05-02T10:00",
                                          "end": "2027-05-02T11:00", "color": "민트"}),
        "할 일": ("create_todo", {"title": "색", "color": "민트"}),
        "카테고리": ("create_todo_category", {"name": "색카테고리", "color": "민트"}),
    }
    for label, (name, args) in calls.items():
        res = reg.dispatch(name, args, ctx)
        assert not res.ok, f"{label}: 못 알아듣는 색을 받아들였다"
        assert res.error_code == "invalid", (label, res.error_code)
        assert "민트" in res.message, (label, res.message)

    # 알아듣는 색은 그대로 들어간다
    made = reg.dispatch("create_todo", {"title": "보라할일", "color": "보라"}, ctx)
    assert made.ok, made.message
    _login()  # 위 dispatch 는 HTTP 를 안 거친다 — 여기서 세션을 확실히 해 둔다
    board = client.get("/api/todo/board").json()
    todos = board["todos"] if isinstance(board, dict) else board
    hit = [t for t in todos if t["title"] == "보라할일"]
    assert hit and hit[0]["color"] == "9", hit
    for t in todos:
        client.delete(f"/api/todo/{t['id']}")


def test_folder_identifier_is_not_read_as_a_document():
    """조회 스킬이 준 **폴더** 식별자를 문서 스킬이 문서로 읽으면 안 된다.

    list_folders 가 준 `회의록` 을 delete_document 에 넘기면, 예전에는 `회의록.md`
    를 찾아 **지목하지 않은 문서**를 휴지통으로 보내고 폴더는 그대로 남긴 채
    "지웠습니다"라고 답했다. 이 저장소에서 반복해서 난 결함 유형이다.
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser

    s = get_settings()
    _login()
    user = SessionUser(username="tester", display_name="T", expires_at=0, remaining=0)
    ctx = SkillContext(user=user, settings=s, today="2026-09-02")
    reg = default_registry()

    reg.dispatch("create_folder", {"path": "겹침시험"}, ctx)
    reg.dispatch("write_document", {"path": "겹침시험.md", "content": "지우면 안 됨"}, ctx)
    try:
        assert "겹침시험" in reg.dispatch("list_folders", {}, ctx).data["folders"]
        # 폴더와 문서가 같은 이름이면 **되묻는다**(말없이 하나를 고르지 않는다)
        for skill in ("delete_document", "read_document", "rename_document"):
            args = {"path": "겹침시험"}
            if skill == "rename_document":
                args["new_name"] = "새이름"
            r = reg.dispatch(skill, args, ctx)
            assert not r.ok, (skill, r.message)
            assert r.error_code == "ambiguous", (skill, r.error_code, r.message)
            assert "겹침시험.md" in r.message, (skill, r.message)

        # 문서가 없으면 폴더 삭제는 그대로 된다(이 스킬의 원래 기능)
        client.delete("/api/notes/delete?path=겹침시험.md")
        r = reg.dispatch("delete_document", {"path": "겹침시험"}, ctx)
        assert r.ok, r.message
        assert "폴더" in r.message, r.message
        client.put("/api/notes/save", json={"path": "겹침시험.md", "content": "지우면 안 됨"})
        # 폴더만 있을 때 읽기·이름변경은 여전히 거절한다
        client.post("/api/notes/folder", json={"path": "겹침시험폴더"})
        r = reg.dispatch("read_document", {"path": "겹침시험폴더"}, ctx)
        assert not r.ok and r.error_code == "is_folder", (r.error_code, r.message)
        client.delete("/api/notes/folder?path=겹침시험폴더")
        # 문서는 그대로 있어야 한다
        got = client.get("/api/notes/get", params={"path": "겹침시험.md"})
        assert got.status_code == 200 and got.json()["content"] == "지우면 안 됨", got.text
    finally:
        client.delete("/api/notes/delete?path=겹침시험.md")
        client.delete("/api/notes/folder?path=겹침시험")


def test_extension_rule_lives_in_one_place():
    """확장자 판정은 한 곳에서만 한다.

    같은 정규식이 세 파일에 복사돼 있었고, 네 번째 자리(휴지통 복원)가
    Path.suffixes 라는 다른 규칙을 쓰는 바람에 `2026.08 회고` 의 확장자를
    `.08 회고` 로 보고 이름을 망가뜨렸다.
    """
    from backend.ai.skills import documents as doc_skill
    from backend.file_kinds import looks_like_extension, split_ext
    from backend.routers import notes as notes_router
    from backend import trash as trash_mod

    # 같은 함수를 가리켜야 한다(복사본이 다시 생기면 여기서 걸린다)
    assert notes_router._looks_like_extension is looks_like_extension
    assert doc_skill._has_extension is looks_like_extension
    assert trash_mod._split_ext is split_ext

    for name, ext in (("문서.md", ".md"), ("2026.08 회고", ""), ("v1.2", ""),
                      ("사진.jpeg", ".jpeg"), ("폴더", ""), ("예산 1.5", "")):
        assert split_ext(name)[1] == ext, (name, split_ext(name))
        assert looks_like_extension(name) is bool(ext), name

    # 분류도 같은 규칙을 써야 한다. Path.suffix 로 보면 `2026.08 회고` 의 확장자가
    # `.08 회고` 라 'other'(=편집 불가)가 되고, 만들자마자 열 수도 저장할 수도 없다.
    from backend.file_kinds import is_editable, kind_of
    assert kind_of("2026.08 회고") == "text", kind_of("2026.08 회고")
    assert is_editable("2026.08 회고")
    assert kind_of("사진 2026.08.jpeg") == "image"
    assert kind_of("보고서 v1.2") == "text"


def test_dotted_titles_survive_the_whole_document_lifecycle():
    """제목에 점이 든 문서(`2026.08 회고`)를 끝까지 다뤄 본다.

    확장자 판정이 file_kinds 한 곳으로 모였어도, 붙이는 쪽이 Path.suffix 면
    `이름 변경` 이 원본의 가짜 꼬리(`.08 회고`)를 새 이름에 덧붙인다.
    """
    _login()
    name = "2026.08 회고"
    client.request("DELETE", "/api/notes/delete", json={"path": name})
    r = client.put("/api/notes/save", json={"path": name, "content": "# 회고"})
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "text", r.json()
    # 만들자마자 다시 열려야 한다
    got = client.get("/api/notes/get", params={"path": name})
    assert got.status_code == 200, got.text
    assert got.json()["content"] == "# 회고" and got.json()["kind"] == "text", got.json()

    # 확장자를 안 적은 새 이름 → 가짜 꼬리가 따라붙으면 안 된다
    r = client.post("/api/notes/rename", json={"path": name, "new_name": "2027.01 계획"})
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "2027.01 계획", r.json()
    client.request("DELETE", "/api/notes/delete", json={"path": "2027.01 계획"})

    # 업로드 중복 이름도 같은 규칙으로 쪼개야 한다
    up = "2026.08 회고.md"
    client.request("DELETE", "/api/notes/delete", json={"path": up})
    for _ in range(2):
        r = client.post("/api/notes/upload?path=",
                        files={"file": (up, io.BytesIO("내용".encode()), "text/markdown")})
        assert r.status_code == 200, r.text
    paths = [n["path"] for n in client.get("/api/notes/list").json()]
    assert "2026.08 회고 (2).md" in paths, [p for p in paths if "회고" in p]
    for p in ("2026.08 회고.md", "2026.08 회고 (2).md"):
        client.request("DELETE", "/api/notes/delete", json={"path": p})


def test_server_still_starts_when_the_accounts_file_is_broken():
    """계정 파일이 깨져도 **서버는 떠야 한다**.

    기동에서 예외가 올라가면 `Application startup failed` 로 끝나고, compose 의
    restart: unless-stopped 때문에 재시작만 반복한다 — 문서·캘린더·할 일·health
    까지 전부 내려가고 무엇이 문제인지 볼 방법도 없다. 손상은 로그인 경로가
    503 으로 이미 막고 있으므로(덮어쓰지 않는다) 기동은 계속한다.
    """
    import shutil as _sh
    import tempfile as _tf
    from pathlib import Path as _P

    prev = os.environ.get("STORAGE_ROOT")
    prev_users = os.environ.get("AUTH_USERS")
    for label, raw in (
        ("깨진 JSON", "{계정 목록이 아님".encode()),
        ("CP949", '[{"username": "주인"}]'.encode("cp949")),
        ("목록이 아님", b'{"username": "o"}'),
        ("빈 파일", b""),
    ):
        root = _P(_tf.mkdtemp(prefix="startup_"))
        (root / "accounts.json").write_bytes(raw)
        os.environ["STORAGE_ROOT"] = str(root)
        os.environ["AUTH_USERS"] = json.dumps([{"username": "o", "password": "pw-long-enough"}])
        try:
            from backend.config import Settings
            from backend.main import lifespan

            get_settings.cache_clear()
            import asyncio

            async def boot():
                async with lifespan(app):
                    return True

            assert asyncio.run(boot()) is True, label  # 기동이 예외로 끝나지 않는다

            s = Settings()
            quiet = TestClient(app, raise_server_exceptions=False)
            r = quiet.post("/api/auth/login",
                           json={"username": "o", "password": "pw-long-enough"})
            assert r.status_code == 503, (label, r.status_code, r.text)
            # 손상된 파일을 덮어쓰지 않았다
            assert (root / "accounts.json").read_bytes() == raw, label
            assert s.storage_root == root
        finally:
            if prev is None:
                os.environ.pop("STORAGE_ROOT", None)
            else:
                os.environ["STORAGE_ROOT"] = prev
            if prev_users is None:
                os.environ.pop("AUTH_USERS", None)
            else:
                os.environ["AUTH_USERS"] = prev_users
            get_settings.cache_clear()
            _sh.rmtree(root, ignore_errors=True)


def test_broken_auth_users_does_not_lock_the_owner_out_forever():
    """AUTH_USERS 가 깨졌을 때 accounts.json 을 빈 목록으로 만들면 안 된다.

    한 번 `[]` 로 써 버리면 다음 부팅부터는 '이미 있는 파일'로 보고 건너뛰므로,
    .env 를 고쳐 재시작해도 주인 계정이 영영 생기지 않는다(승인해 줄 사람도 없다).
    """
    import shutil as _sh
    import tempfile as _tf
    from pathlib import Path as _P

    from backend import accounts as acc_mod
    from backend.config import Settings

    prev = os.environ.get("STORAGE_ROOT")
    prev_users = os.environ.get("AUTH_USERS")
    root = _P(_tf.mkdtemp(prefix="seedfail_"))
    try:
        os.environ["STORAGE_ROOT"] = str(root)
        for broken in ('{"username": "o"}', "[[]", '[{"username": null, "password": null}]'):
            os.environ["AUTH_USERS"] = broken
            st = Settings()
            acc_mod.ensure_seed(st)
            p = root / "accounts.json"
            assert not p.exists(), f"{broken!r} 에서 빈 계정 파일을 만들었다: {p.read_text()}"

        # .env 를 고치고 재시작하면 그때 이관돼야 한다
        os.environ["AUTH_USERS"] = '[{"username": "owner", "password": "pw-long-enough"}]'
        st = Settings()
        acc_mod.ensure_seed(st)
        rows = json.loads((root / "accounts.json").read_text(encoding="utf-8"))
        assert [r["username"] for r in rows] == ["owner"], rows
    finally:
        if prev is None:
            os.environ.pop("STORAGE_ROOT", None)
        else:
            os.environ["STORAGE_ROOT"] = prev
        if prev_users is None:
            os.environ.pop("AUTH_USERS", None)
        else:
            os.environ["AUTH_USERS"] = prev_users
        _sh.rmtree(root, ignore_errors=True)


def test_refused_deletion_puts_the_vault_back():
    """계정 삭제가 거절되면 벌트를 제자리로 돌려놔야 한다.

    데이터를 먼저 치우도록 고쳤더니, accounts.delete 가 400 으로 막는 경우
    (마지막 관리자·마지막 주인)에 계정은 멀쩡히 살아 있는데 그 사람의
    문서·일정·할 일·설정·구글 토큰만 통째로 사라지게 됐다.
    """
    s = get_settings()
    _login()
    client.put("/api/notes/save", json={"path": "지키자.md", "content": "이건 남아야 한다"})

    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.post("/api/auth/login", json={"username": "tester2", "password": "pw456"})
    # tester 는 .env 출신 주인이다. 주인이 둘이라 삭제가 되면 안 되게 막아 둔다.
    import backend.accounts as acc_mod
    from fastapi import HTTPException

    real = acc_mod.delete

    def refuse(username, settings):
        raise HTTPException(status_code=400, detail="마지막 서버 관리자는 삭제할 수 없습니다.")

    acc_mod.delete = refuse
    try:
        r = quiet.delete("/api/admin/users/tester")
        assert r.status_code == 400, r.text
    finally:
        acc_mod.delete = real

    # 계정도 벌트도 그대로여야 한다
    assert s.user_root("tester").exists(), "벌트가 사라졌다"
    got = client.get("/api/notes/get", params={"path": "지키자.md"})
    assert got.status_code == 200 and got.json()["content"] == "이건 남아야 한다", got.text
    grave = s.storage_root / "deleted-users"
    left = [p.name for p in grave.iterdir()] if grave.exists() else []
    assert not any(n.startswith("tester-") for n in left), left
    client.delete("/api/notes/delete?path=지키자.md")


def test_self_lockout_guard_ignores_letter_case():
    """자기 계정 조작 금지는 계정 조회와 **같은 기준**(대소문자 무관)이어야 한다.

    여기만 정확히 비교하면 URL 대소문자만 바꿔서 가드를 지나가고, 그다음
    조작들은 _match 로 같은 계정을 찾아 실제로 자기 자신을 잠근다.
    """
    _login()  # 전역 client 도 여기서 직접 로그인한다(앞선 테스트에 기대지 않는다)
    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    for path in ("/api/admin/users/TESTER/disable", "/api/admin/users/Tester/disable"):
        r = quiet.post(path)
        assert r.status_code == 400, (path, r.status_code, r.text)
    r = quiet.delete("/api/admin/users/TeStEr")
    assert r.status_code == 400, r.text
    # 여전히 관리 화면을 쓸 수 있다(자기 자신을 못 잠갔다)
    assert client.get("/api/admin/users").status_code == 200


def test_deleting_an_account_keeps_it_when_the_data_cannot_be_moved():
    """폴더를 못 치우면 계정도 지우면 안 된다.

    계정을 먼저 지우면 200 OK 를 돌려주면서 users/<id>/ 가 그대로 남아,
    다음 가입자가 그 벌트를 통째로 물려받는다.
    """
    import backend.routers.admin as admin_mod

    login_guard.reset()
    s = get_settings()
    TestClient(app).post("/api/auth/signup",
                         json={"username": "stuckuser", "password": "pw-long-enough"})
    _login()
    client.post("/api/admin/users/stuckuser/approve")
    victim = TestClient(app)
    victim.post("/api/auth/login", json={"username": "stuckuser", "password": "pw-long-enough"})
    victim.put("/api/notes/save", json={"path": "비밀.md", "content": "x"})

    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    real_move = admin_mod.shutil.move
    admin_mod.shutil.move = lambda *a, **k: (_ for _ in ()).throw(OSError(13, "denied"))
    try:
        r = quiet.delete("/api/admin/users/stuckuser")
        assert r.status_code == 500, r.text
        # 계정이 살아 있어야 한다 — 아니면 폴더만 남아 다음 사람이 물려받는다
        rows = client.get("/api/admin/users").json()["users"]
        names = [u["username"] for u in rows]
        assert "stuckuser" in names, names
    finally:
        admin_mod.shutil.move = real_move
    assert client.delete("/api/admin/users/stuckuser").status_code == 200
    assert not s.user_root("stuckuser").exists()


def test_old_owner_account_keeps_admin_access():
    """origin 필드가 없던 시절의 주인 계정이 관리 화면에서 잠기면 안 된다.

    이미 돌고 있는 서버에 새 코드를 올리는 상황이다. `.env` 와 계정 파일의
    대소문자가 다르면 주인을 못 알아보고 **본인이 403 을 받는다**(실측).
    """
    import tempfile as _tf

    from backend.config import Settings

    prev = os.environ.get("STORAGE_ROOT")
    prev_users = os.environ.get("AUTH_USERS")
    os.environ["STORAGE_ROOT"] = _tf.mkdtemp(prefix="oldowner_")
    os.environ["AUTH_USERS"] = json.dumps([{"username": "Zanviq", "password": "pw-owner"}])
    try:
        s = Settings()
        s.ensure_storage()
        (s.storage_root / "accounts.json").write_text(json.dumps([{
            "username": "zanviq",  # 계정 파일은 소문자, .env 는 대문자
            "display_name": "주인",
            "password_hash": accounts.hash_password("pw-owner"),
            "role": "admin", "status": "active",
            "created_at": 1, "approved_at": 1, "approved_by": "관리자",
        }], ensure_ascii=False), encoding="utf-8")

        acc = accounts.find("zanviq", s)
        assert acc is not None
        assert acc.is_owner, f"주인으로 안 읽힌다: origin={acc.origin}"
    finally:
        for k, v in (("STORAGE_ROOT", prev), ("AUTH_USERS", prev_users)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_old_settings_values_are_normalized_on_read():
    """예전 버전이 남긴 범위 밖 값이 그대로 내려가면 화면이 이상해진다."""
    from backend import user_settings
    from backend.auth import SessionUser

    _login()
    s = get_settings()
    me = SessionUser(username="tester", display_name="T", expires_at=0, remaining=0)
    path = s.user_root("tester") / "settings.json"
    backup = path.read_text(encoding="utf-8") if path.exists() else None
    path.write_text(json.dumps({
        "ai": {"tone": "counselor", "max_steps": 99},
        "calendar": {"default_view": "listWeek", "default_remind": 999999},
        "notes": {"autosave_ms": 100},
        "sync": {"enabled": True},  # 사라진 기능
    }, ensure_ascii=False), encoding="utf-8")
    try:
        got = user_settings.load(me, s)
        assert got["ai"]["max_steps"] <= 16, got["ai"]
        assert got["calendar"]["default_view"] in ("dayGridMonth", "timeGridWeek", "timeGridDay")
        assert got["notes"]["autosave_ms"] >= 300, got["notes"]
        assert "sync" not in got, got.keys()
    finally:
        if backup is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(backup, encoding="utf-8")


def test_every_skill_has_a_korean_label_in_the_chat_panel():
    """스킬을 추가하면 화면 라벨도 같이 채워야 한다.

    커밋 277374a 에서 고쳤던 결함이 할 일 스킬 9개 + list_folders 를 붙이면서
    그대로 되살아났다(AI 단계에 raw 영문 이름이 뜬다). 사람이 기억하는 대신
    여기서 막는다.
    """
    import re as _re
    from pathlib import Path as _P

    from backend.ai.skills import ALL_SKILLS

    src = (_P(__file__).resolve().parent.parent
           / "frontend" / "src" / "components" / "ai" / "ChatPanel.tsx")
    if not src.exists():
        # 백엔드만 떼어 낸 사본(돌연변이 검사 등)에서는 볼 파일이 없다
        import pytest
        pytest.skip("프런트 소스가 없는 사본이다")
    text = src.read_text(encoding="utf-8")
    body = text.split("const SKILL_LABEL", 1)[1].split("};", 1)[0]
    labeled = set(_re.findall(r"^\s{2}(\w+):", body, _re.M))

    missing = sorted({s.name for s in ALL_SKILLS} - labeled)
    assert not missing, f"ChatPanel 의 SKILL_LABEL 에 빠진 스킬: {missing}"
    stale = sorted(labeled - {s.name for s in ALL_SKILLS})
    assert not stale, f"없어진 스킬의 라벨이 남아 있다: {stale}"


def test_atomic_write_retries_when_the_file_is_briefly_locked():
    """Windows 에서 파일을 잠깐 잡고 있으면 os.replace 가 PermissionError 를 낸다.

    재시도가 없으면 그 한 건이 500 으로 실패한다(할 일 24건 동시 삭제 12회 중
    1회 재현 — 삭제는 실패하는데 휴지통에는 미아가 남았다).
    """
    import shutil as _sh
    import tempfile as _tf
    from pathlib import Path as _P

    from backend import json_store

    d = _P(_tf.mkdtemp(prefix="replace_"))
    real = json_store.os.replace
    calls = {"n": 0}

    def flaky(src, dst):
        calls["n"] += 1
        if calls["n"] <= 2:  # 처음 두 번은 잠겨 있다
            raise PermissionError(5, "access denied")
        return real(src, dst)

    json_store.os.replace = flaky
    try:
        json_store.write_atomic(d / "a.json", [{"x": 1}])
        assert json.loads((d / "a.json").read_text(encoding="utf-8")) == [{"x": 1}]
        assert calls["n"] == 3, calls
        # 실패한 시도가 임시파일을 흘리면 안 된다
        assert [p.name for p in d.iterdir()] == ["a.json"], list(d.iterdir())

        # 끝까지 안 풀리면 올려야 한다 — 조용히 성공한 척하면 안 된다
        calls["n"] = -1000
        try:
            json_store.write_atomic(d / "b.json", [1])
            raise AssertionError("계속 잠겨 있는데도 성공했다고 했다")
        except PermissionError:
            pass
        assert not (d / "b.json").exists()
        assert [p.name for p in d.iterdir()] == ["a.json"], list(d.iterdir())
    finally:
        json_store.os.replace = real
        _sh.rmtree(d, ignore_errors=True)


def test_bad_settings_are_cleaned_before_they_are_stored():
    """저장 시점에도 걸러야 한다 — 읽기만 정규화하면 파일에는 쓰레기가 남는다.

    load() 가 다시 정규화하므로 API 응답만 봐서는 저장 검증이 빠져도 알 수 없다.
    실제로 디스크에 뭐가 적혔는지를 본다.
    """
    _login()
    s = get_settings()
    path = s.user_root("tester") / "settings.json"
    backup = path.read_text(encoding="utf-8") if path.exists() else None
    try:
        r = client.patch("/api/settings", json={"changes": {
            "ai": {"tone": "해적", "max_steps": 9999},
            "calendar": {"default_color": "99", "ai_rules": "규칙"},
            "notes": {"autosave_ms": 1},
            "몰라요": {"x": 1},
        }})
        assert r.status_code == 200, r.text
        stored = json.loads(path.read_text(encoding="utf-8"))
        assert stored["ai"]["tone"] == "assistant", stored["ai"]
        assert stored["ai"]["max_steps"] == 16, stored["ai"]
        assert stored["calendar"]["default_color"] == "2", stored["calendar"]
        assert stored["notes"]["autosave_ms"] == 300, stored["notes"]
        assert "몰라요" not in stored, stored.keys()

        # 너무 긴 글은 **조용히 자르지 않는다**. 잘라 두면 '설정 저장됨' 토스트를
        # 보고 나가는데 뒷부분이 사라져 있고, 사용자는 그 사실조차 모른다.
        quiet = TestClient(app, raise_server_exceptions=False)
        quiet.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
        r = quiet.patch("/api/settings", json={"changes": {"calendar": {"ai_rules": "가" * 5000}}})
        assert r.status_code == 400, r.text
        assert json.loads(path.read_text(encoding="utf-8"))["calendar"]["ai_rules"] == "규칙"

        # 무한대는 ValueError 가 아니라 OverflowError 다. 파이썬 json 은 표준이
        # 아닌 `Infinity` 토큰을 그대로 읽어 주므로 실제로 들어올 수 있다.
        r = quiet.patch("/api/settings", headers={"content-type": "application/json"},
                        content='{"changes": {"ai": {"max_steps": Infinity}}}')
        assert r.status_code in (200, 422), r.text  # 500 만 아니면 된다
        # 받아들였다면 기본값으로 떨어져 있어야 한다(범위 밖 값이 박히면 안 된다)
        assert json.loads(path.read_text(encoding="utf-8"))["ai"]["max_steps"] in (8, 16)

        # 반대로 **읽기**는 막히지도, 자르지도 않는다. 상한이 생기기 전에 길게
        # 써 둔 값을 자르면 그 잘린 값이 관계없는 설정 하나만 바꿔도 디스크에
        # 영구히 덮어써진다 — 상한을 새로 넣는 것만으로 글이 절반 사라진다.
        bad = json.loads(path.read_text(encoding="utf-8"))
        bad["calendar"]["ai_rules"] = "나" * 5000
        path.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
        got = client.get("/api/settings")
        assert got.status_code == 200, got.text
        assert len(got.json()["settings"]["calendar"]["ai_rules"]) == 5000, "읽을 때 잘렸다"
        # 관계없는 설정을 바꿔도 그 값은 그대로 남아야 한다
        assert client.patch("/api/settings",
                            json={"changes": {"notes": {"autosave_ms": 1200}}}).status_code == 200
        kept = json.loads(path.read_text(encoding="utf-8"))["calendar"]["ai_rules"]
        assert len(kept) == 5000, f"다른 설정을 바꿨더니 {5000 - len(kept)}자가 사라졌다"

        # 무한대·NaN 을 직접 넣어도 기본값으로 떨어져야 한다("못 맞추면 기본값")
        from backend import user_settings as us
        assert us._coerce("ai", "max_steps", float("inf"), 8) == 8
        assert us._coerce("ai", "max_steps", float("nan"), 8) == 8
    finally:
        if backup is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(backup, encoding="utf-8")


def test_corrupt_store_files_are_not_overwritten():
    """저장 파일이 잘렸을 때 '비어 있음'으로 보면 다음 저장이 원본을 덮는다."""
    _login()
    s = get_settings()
    made_ev = client.post("/api/calendar/events", json={
        "title": "손상시험", "start": "2027-01-05T10:00:00", "end": "2027-01-05T11:00:00"}).json()
    made_todo = client.post("/api/todo/create", json={"title": "손상시험"}).json()
    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.post("/api/auth/login", json={"username": "tester", "password": "pw123"})

    for path, read_url, make in (
        (s.storage_root / "users" / "tester" / "calendar" / "events.json",
         "/api/calendar/events",
         lambda: quiet.post("/api/calendar/events", json={
             "title": "새것", "start": "2027-01-06T10:00:00", "end": "2027-01-06T11:00:00"})),
        (s.storage_root / "users" / "tester" / "todo" / "todo.json",
         "/api/todo/board",
         lambda: quiet.post("/api/todo/create", json={"title": "새것"})),
    ):
        original = path.read_text(encoding="utf-8")
        broken = original[: len(original) // 2]
        path.write_text(broken, encoding="utf-8")
        try:
            assert quiet.get(read_url).status_code == 503, path.name
            make()
            assert path.read_text(encoding="utf-8") == broken, f"{path.name} 을 덮어썼다"
        finally:
            path.write_text(original, encoding="utf-8")
        assert quiet.get(read_url).status_code == 200

    # 다른 테스트가 빈 저장소를 전제한다 — 만든 것은 치운다
    client.delete(f"/api/calendar/events/{made_ev['id']}")
    client.delete(f"/api/todo/{made_todo['id']}")


def test_corrupt_accounts_file_is_not_overwritten():
    """계정 파일이 잘렸을 때 새로 써 버리면 가입 계정이 전부 사라진다."""
    import tempfile as _tf

    import pytest
    from fastapi import HTTPException

    from backend.config import Settings

    prev = os.environ.get("STORAGE_ROOT")
    os.environ["STORAGE_ROOT"] = _tf.mkdtemp(prefix="corrupt_")
    try:
        s = Settings()
        s.ensure_storage()
        accounts.signup("someone", "pw-long-enough", "", s)
        p = s.storage_root / "accounts.json"
        broken = '[{"username": "tester", "pass'
        p.write_text(broken, encoding="utf-8")

        with pytest.raises(HTTPException) as err:
            accounts.list_all(s)
        assert err.value.status_code == 503
        assert p.read_text(encoding="utf-8") == broken, "손상된 파일을 덮어썼다"
    finally:
        if prev is None:
            del os.environ["STORAGE_ROOT"]
        else:
            os.environ["STORAGE_ROOT"] = prev


def test_trash_rollback_when_index_write_fails():
    """실물만 옮기고 목록에 못 실으면 문서가 양쪽 어디에도 없는 유령이 된다."""
    from backend import trash as trash_mod

    _login()
    client.put("/api/notes/save", json={"path": "되돌릴문서.md", "content": "소중함"})
    real = trash_mod.write_atomic

    def boom(path, data):
        if str(path).endswith("index.json"):
            raise OSError("일부러 실패")
        return real(path, data)

    # 500이 되는 것을 보려면 예외를 서버 응답으로 받아야 한다
    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    trash_mod.write_atomic = boom
    try:
        failed = quiet.delete("/api/notes/delete?path=되돌릴문서.md")
        assert failed.status_code >= 500, failed.status_code
    finally:
        trash_mod.write_atomic = real

    got = client.get("/api/notes/get", params={"path": "되돌릴문서.md"})
    assert got.status_code == 200, "휴지통 기록이 실패하자 문서가 사라졌다"
    assert got.json()["content"] == "소중함"
    client.delete("/api/notes/delete?path=되돌릴문서.md")


def test_restore_name_collision_keeps_dotted_names():
    """`2026.08 회고.md` 의 확장자를 `.08 회고.md` 로 보면 이름이 망가진다."""
    from backend.trash import _unique_target

    _login()
    root = get_settings().storage_root / "users" / "tester" / "data"
    root.mkdir(parents=True, exist_ok=True)
    (root / "2026.08 회고.md").write_text("있음", encoding="utf-8")
    got = _unique_target(root, "2026.08 회고.md")
    assert got.name == "2026.08 회고 (restored).md", got.name
    (root / "2026.08 회고.md").unlink()


def test_save_does_not_overwrite_md_twin():
    """`회의` 로 새 노트를 만들 때 이미 있는 `회의.md` 를 덮으면 안 된다."""
    _login()
    client.put("/api/notes/save", json={"path": "쌍둥이.md", "content": "원래 내용"})
    r = client.put("/api/notes/save", json={"path": "쌍둥이", "content": ""})
    assert r.status_code == 409, r.text
    assert client.get("/api/notes/get?path=쌍둥이.md").json()["content"] == "원래 내용"
    client.delete("/api/notes/delete?path=쌍둥이.md")


def test_upload_never_destroys_existing_file():
    """업로드가 같은 이름의 문서를 조용히 덮으면 되돌릴 수 없다."""
    import base64 as _b64

    _login()
    png = _b64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
    first = client.post("/api/notes/upload", params={"path": "올린것"},
                        files={"file": ("사진.png", png, "image/png")})
    assert first.status_code == 200, first.text
    again = client.post("/api/notes/upload", params={"path": "올린것"},
                        files={"file": ("사진.png", png, "image/png")})
    assert again.status_code == 200, again.text
    assert again.json()["path"] != first.json()["path"], "같은 자리에 덮어썼다"
    paths = {n["path"] for n in client.get("/api/notes/list").json()}
    assert first.json()["path"] in paths and again.json()["path"] in paths

    # 크기 초과로 실패해도 이미 있던 파일은 그대로여야 한다
    big = b"x" * (get_settings().max_upload_bytes + 1024)
    over = client.post("/api/notes/upload", params={"path": "올린것"},
                       files={"file": ("사진.png", big, "image/png")})
    assert over.status_code == 413, over.status_code
    still = {n["path"] for n in client.get("/api/notes/list").json()}
    assert first.json()["path"] in still, "실패한 업로드가 기존 파일을 지웠다"
    # 임시 파일이 남지 않아야 한다
    assert not [p for p in still if ".upload" in p], still
    client.delete("/api/notes/folder?path=올린것")


def test_search_sees_edits_immediately():
    """검색은 본문을 캐시해 둔다 — 고친 뒤 옛 내용이 잡히면 안 된다."""
    _login()
    p = "캐시확인.md"
    client.put("/api/notes/save", json={"path": p, "content": "사과나무"})
    assert any(h["path"] == p for h in client.get("/api/notes/search?q=사과나무").json())

    # 글자 수가 같은 내용으로 바꾼다. 파일시스템 시각 해상도가 거칠면
    # mtime·크기가 모두 그대로일 수 있어, 여기가 캐시 무효화의 최악 조건이다.
    client.put("/api/notes/save", json={"path": p, "content": "바나나무"})
    assert not any(h["path"] == p for h in client.get("/api/notes/search?q=사과나무").json())
    assert any(h["path"] == p for h in client.get("/api/notes/search?q=바나나무").json())

    # 발췌는 원문 그대로여야 한다(소문자로 담아 두면 여기서 드러난다)
    client.put("/api/notes/save", json={"path": p, "content": "Hello World 문서"})
    hit = [h for h in client.get("/api/notes/search?q=hello").json() if h["path"] == p]
    assert hit and "Hello World" in hit[0]["snippet"], hit

    client.delete(f"/api/notes/delete?path={p}")


def test_notes_rename_and_move():
    _login()
    client.put("/api/notes/save", json={"path": "RM원본.md", "content": "본문"})
    client.post("/api/notes/folder", json={"path": "이동폴더"})
    # 이름 변경
    r = client.post("/api/notes/rename", json={"path": "RM원본", "new_name": "RM변경"})
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "RM변경"
    assert client.get("/api/notes/get?path=RM변경").json()["content"] == "본문"
    # 폴더로 이동
    r = client.post("/api/notes/move", json={"path": "RM변경", "target_folder": "이동폴더"})
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "이동폴더/RM변경.md"
    assert client.get("/api/notes/get?path=이동폴더/RM변경").json()["content"] == "본문"
    # 존재하지 않는 노트 이름변경 → 404
    assert client.post("/api/notes/rename", json={"path": "없음", "new_name": "x"}).status_code == 404
    # 잘못된 이름(슬래시) → 400
    assert client.post("/api/notes/rename",
                       json={"path": "이동폴더/RM변경", "new_name": "a/b"}).status_code == 400


def test_notes_graph_cache():
    """노트 그래프 캐시: 변경 없으면 동일 객체, 노트 추가 시 지문 변경으로 무효화."""
    import tempfile
    from pathlib import Path
    from backend import notes_graph
    d = Path(tempfile.mkdtemp(prefix="ngraph_"))
    notes_graph.clear_cache()
    (d / "A.md").write_text("see [[B]]", encoding="utf-8")
    (d / "B.md").write_text("leaf", encoding="utf-8")
    g1 = notes_graph.build_graph(d)
    g2 = notes_graph.build_graph(d)
    assert g1 is g2 and len(g1["nodes"]) == 2  # 캐시 히트(동일 객체)
    (d / "C.md").write_text("new [[A]]", encoding="utf-8")
    g3 = notes_graph.build_graph(d)
    assert g3 is not g1 and len(g3["nodes"]) == 3  # 지문 변경 → 재계산


def test_calendar_recurrence_and_reminders():
    _login()
    # 매일 반복 이벤트 (알림 30분 전)
    r = client.post(
        "/api/calendar/events",
        json={
            "title": "데일리 스탠드업",
            "start": "2026-08-03T09:00:00",
            "end": "2026-08-03T09:15:00",
            "recurrence": "daily",
            "recur_until": "2026-08-09",
            "remind_minutes": 30,
        },
    )
    assert r.status_code == 200, r.text
    # 8/3~8/9 조회 → 7개 인스턴스
    got = client.get("/api/calendar/events?from=2026-08-03T00:00:00&to=2026-08-09T23:59:59").json()
    daily = [e for e in got if e["title"] == "데일리 스탠드업"]
    assert len(daily) == 7, len(daily)
    # 단일 발생 삭제(예외)
    inst_id = daily[2]["id"]  # id@2026-08-05
    assert "@" in inst_id
    assert client.delete(f"/api/calendar/events/{inst_id}").status_code == 200
    got2 = client.get("/api/calendar/events?from=2026-08-03T00:00:00&to=2026-08-09T23:59:59").json()
    daily2 = [e for e in got2 if e["title"] == "데일리 스탠드업"]
    assert len(daily2) == 6
    # 알림 due 엔드포인트 — **리스트인지만 보면 안 된다.** 알림 계산이 통째로
    # 죽어 아무 알림도 안 나가게 되어도 그 검사는 초록불이다.
    from backend import calendar_service
    from backend.auth import SessionUser
    from backend.config import get_settings as _gs

    me = SessionUser(username="tester", display_name="T", expires_at=0, remaining=0)
    # 8/6 08:00 기준으로 보면 그날 09:00 회차가 30분 전 알림 대상이다
    due = calendar_service.due_reminders(me, _gs(), "2026-08-06T08:00:00", 120)
    mine = [d for d in due if d["title"] == "데일리 스탠드업"]
    assert len(mine) == 1, [d.get("start") for d in due]
    assert mine[0]["start"].startswith("2026-08-06T09:00"), mine[0]
    assert mine[0]["remind_at"].startswith("2026-08-06T08:30"), mine[0]
    # 지운 회차(8/5)는 알림도 나가면 안 된다
    gone = calendar_service.due_reminders(me, _gs(), "2026-08-05T08:00:00", 120)
    assert not [d for d in gone if d["title"] == "데일리 스탠드업"], gone

    assert isinstance(client.get("/api/calendar/reminders?within=100000").json(), list)

    # 뒷정리 — 이 일정이 남으면 다른 테스트의 조회 결과에 섞인다
    for e in client.get(
            "/api/calendar/events?from=2026-08-03T00:00:00&to=2026-08-09T23:59:59").json():
        if e["title"] == "데일리 스탠드업":
            client.delete(f"/api/calendar/events/{e['id'].split('@')[0]}")
            break


def test_notes_folders_and_tree():
    _login()
    assert client.post("/api/notes/folder", json={"path": "proj"}).status_code == 200
    client.put("/api/notes/save", json={"path": "proj/idea.md", "content": "# idea"})
    tree = client.get("/api/notes/tree").json()
    assert "proj" in tree["folders"]
    assert any(n["path"] == "proj/idea.md" for n in tree["notes"])
    # 폴더 그래프 모드: 루트에서 하위 폴더 노드로 proj 표시
    g = client.get("/api/notes/graph?mode=folders").json()
    assert any(n.get("type") == "folder" and n["title"] == "proj" for n in g["nodes"])


def test_trash_restore_flow():
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester2", "password": "pw456"})
    c.post(
        "/api/notes/upload?path=",
        files={"file": ("t.txt", io.BytesIO(b"data"), "text/plain")},
    )
    assert c.delete("/api/notes/delete?path=t.txt").status_code == 200
    paths = [n["path"] for n in c.get("/api/notes/tree").json()["notes"]]
    assert "t.txt" not in paths  # 목록에서 사라짐
    items = c.get("/api/trash/list").json()
    entry = next(e for e in items if e["name"] == "t.txt")
    assert c.post(f"/api/trash/restore?id={entry['id']}").status_code == 200
    paths2 = [n["path"] for n in c.get("/api/notes/tree").json()["notes"]]
    assert "t.txt" in paths2  # 원래 자리로 복원됨


def test_unified_document_space():
    """마크다운·텍스트·이미지·PDF가 한 트리에 있고, 종류에 맞게 처리된다.

    개편 전에는 파일 저장소와 노트 폴더가 나뉘어 같은 문서를 두 페이지에서
    다르게 봐야 했다. 이제 users/<u>/data 하나뿐이다.
    """
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester", "password": "pw123"})

    # 마크다운은 확장자 없이 저장 → .md가 붙는다
    r = c.put("/api/notes/save", json={"path": "혼합/메모.md", "content": "# 메모"})
    assert r.status_code == 200 and r.json()["path"] == "혼합/메모.md"
    assert r.json()["kind"] == "md" and r.json()["editable"] is True

    # 이미지·PDF 업로드
    png = b"fake-png-payload" + b"0" * 32  # 분류는 확장자로 하므로 내용은 무관
    up = c.post("/api/notes/upload?path=혼합",
                files={"file": ("사진.png", io.BytesIO(png), "image/png")})
    assert up.status_code == 200 and up.json()["kind"] == "image"
    assert up.json()["editable"] is False
    up2 = c.post("/api/notes/upload?path=혼합",
                 files={"file": ("문서.pdf", io.BytesIO(b"%PDF-1.4 x"), "application/pdf")})
    assert up2.status_code == 200 and up2.json()["kind"] == "pdf"

    # 하나의 트리에 전부 보인다
    tree = c.get("/api/notes/tree").json()
    by_path = {n["path"]: n for n in tree["notes"]}
    for want, kind in [("혼합/메모.md", "md"), ("혼합/사진.png", "image"), ("혼합/문서.pdf", "pdf")]:
        assert want in by_path, f"{want} 없음"
        assert by_path[want]["kind"] == kind

    # 이미지는 인라인 MIME으로 서빙(브라우저가 바로 표시)
    raw = c.get("/api/notes/raw?path=혼합/사진.png")
    assert raw.status_code == 200 and raw.headers["content-type"] == "image/png"
    assert c.get("/api/notes/raw?path=혼합/문서.pdf").headers["content-type"] == "application/pdf"
    # download=true면 첨부로
    dl = c.get("/api/notes/raw?path=혼합/사진.png&download=true")
    assert dl.headers["content-type"] == "application/octet-stream"

    # 텍스트가 아닌 파일은 편집기로 열 수 없다(조용히 깨진 내용을 주지 않음)
    assert c.get("/api/notes/get?path=혼합/사진.png").status_code == 415
    assert c.put("/api/notes/save",
                 json={"path": "혼합/사진.png", "content": "x"}).status_code == 415

    # 이름변경은 확장자를 유지한다
    rn = c.post("/api/notes/rename", json={"path": "혼합/사진.png", "new_name": "여행"})
    assert rn.status_code == 200 and rn.json()["path"] == "혼합/여행.png"

    # 검색: 이미지·PDF는 이름으로 잡힌다
    hits = c.get("/api/notes/search?q=여행").json()
    assert any(h["path"] == "혼합/여행.png" for h in hits)


def test_google_allday_end_conversion():
    from backend.calendar_google import _to_internal, _to_google
    # 구글(배타적 end.date) → 내부(포함): 7/1~7/2(이틀) = 구글 end.date 7/3 → 내부 end 7/2
    g = {"id": "x", "summary": "t", "start": {"date": "2026-07-01"}, "end": {"date": "2026-07-03"}}
    internal = _to_internal(g)
    assert internal["start"] == "2026-07-01" and internal["end"] == "2026-07-02"
    assert internal["allDay"] is True
    # 내부(포함) → 구글(배타적): 7/1~7/2 = 내부 end 7/2 → 구글 end.date 7/3
    body = _to_google({"title": "t", "allDay": True, "start": "2026-07-01", "end": "2026-07-02"})
    assert body["start"]["date"] == "2026-07-01" and body["end"]["date"] == "2026-07-03"
    # 시간 일정은 날짜 변환 없음
    g2 = {"start": {"dateTime": "2026-07-01T09:00:00+09:00"}, "end": {"dateTime": "2026-07-01T10:00:00+09:00"}}
    assert _to_internal(g2)["allDay"] is False


def test_calendar_colors_names_and_prefs():
    from backend.calendar_colors import resolve_color
    assert resolve_color("보라") == "9"
    assert resolve_color("보라색") == "9"
    assert resolve_color("9") == "9"
    assert resolve_color("동아리보라") == "9"          # 부분 포함
    assert resolve_color(None, default="2") == "2"
    assert resolve_color("헬로우", default="2") == "2"  # 미매칭 → 기본

    # 사용자 필수 규칙 + 알림 정책이 시스템 프롬프트에 반영
    from backend.ai.prompt_builder import build_system
    from backend.auth import SessionUser
    u = SessionUser(username="x", display_name="X", expires_at=0, remaining=0)
    sysp = build_system(u, "assistant", "2026-07-01",
                        {"default_color": "9", "default_remind": 0, "ai_rules": "동아리는 보라색"})
    assert "동아리는 보라색" in sysp
    assert "붙이지 마세요" in sysp  # 알림 자동부착 금지 지시

    # create 스킬: 색 이름 → id, 기본 색/알림 적용
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.config import get_settings
    from backend import user_settings
    s = get_settings()
    u2 = SessionUser(username="tester2", display_name="T2", expires_at=0, remaining=0)
    user_settings.patch(u2, s, {"calendar": {"default_color": "10", "default_remind": 30}})
    ctx = SkillContext(user=u2, settings=s)
    reg = default_registry()
    r = reg.dispatch("create_calendar_event",
                     {"title": "동아리", "start": "2026-09-10T10:00:00", "color": "보라"}, ctx)
    assert r.ok and r.data["event"]["color"] == "9"
    assert r.data["event"]["remind_minutes"] == 30  # 미지정 시 기본 알림
    r2 = reg.dispatch("create_calendar_event",
                      {"title": "기타", "start": "2026-09-11T10:00:00"}, ctx)
    assert r2.data["event"]["color"] == "10"  # 색 미지정 → 기본 색


def test_calendar_list_default_window():
    # 기간 미지정 조회는 '오늘 근처'로 한정되어 아주 오래된 일정은 제외됨
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    s = get_settings()
    u = SessionUser(username="tester2", display_name="T2", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-07-12")
    reg = default_registry()
    reg.dispatch("create_calendar_event", {"title": "OLDEVT", "start": "2010-01-01T10:00:00"}, ctx)
    reg.dispatch("create_calendar_event", {"title": "NOWEVT", "start": "2026-07-15T10:00:00"}, ctx)
    r = reg.dispatch("list_calendar_events", {}, ctx)  # 기간 미지정
    assert r.ok
    titles = [e["title"] for e in r.data["events"]]
    assert "NOWEVT" in titles
    assert "OLDEVT" not in titles  # 기본창(오늘-30~+120) 밖


def test_calendar_list_date_only_end_is_inclusive():
    """to_date를 날짜만(YYYY-MM-DD) 주면 그날 하루 전체가 포함되어야 한다.

    회귀: 날짜만 준 종료 경계가 그날 00:00으로 해석돼 당일 일정이 전부 빠졌다.
    AI가 "치과 일정 3시로 옮겨줘" 같은 요청에서 대상 날짜로 범위를 좁혀 조회하면
    0건이 나와 event_id를 못 얻고, 결국 수정이 실패했다.
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="tester3", display_name="T3", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-16")
    reg = default_registry()
    reg.dispatch("create_calendar_event", {"title": "DAYEVT", "start": "2026-08-20T10:00:00"}, ctx)

    # 같은 날짜로 좁힌 조회(AI가 실제로 만드는 인자 형태)
    r = reg.dispatch("list_calendar_events", {"from_date": "2026-08-20", "to_date": "2026-08-20"}, ctx)
    assert r.ok
    assert "DAYEVT" in [e["title"] for e in r.data["events"]], "당일 종료 경계가 하루 전체를 포함해야 함"

    # 하루 끝(23:5x) 일정도 포함
    reg.dispatch("create_calendar_event", {"title": "LATEEVT", "start": "2026-08-20T23:30:00"}, ctx)
    r2 = reg.dispatch("list_calendar_events", {"from_date": "2026-08-20", "to_date": "2026-08-20"}, ctx)
    assert "LATEEVT" in [e["title"] for e in r2.data["events"]]

    # 경계 밖(다음 날)은 여전히 제외되어야 함 — 범위가 과하게 넓어지지 않았는지
    reg.dispatch("create_calendar_event", {"title": "NEXTEVT", "start": "2026-08-21T09:00:00"}, ctx)
    r3 = reg.dispatch("list_calendar_events", {"from_date": "2026-08-20", "to_date": "2026-08-20"}, ctx)
    assert "NEXTEVT" not in [e["title"] for e in r3.data["events"]]

    # 시각을 명시한 종료 경계는 기존 의미 그대로(정오 이후 제외)
    r4 = reg.dispatch(
        "list_calendar_events", {"from_date": "2026-08-20", "to_date": "2026-08-20T12:00:00"}, ctx
    )
    titles4 = [e["title"] for e in r4.data["events"]]
    assert "DAYEVT" in titles4 and "LATEEVT" not in titles4


def test_ai_notes_in_folders_are_usable():
    """폴더 안 노트도 AI가 읽기·덧붙이기·이름변경·삭제까지 할 수 있어야 한다.

    회귀: 목록이 파일명만 돌려줘 폴더 정보가 사라졌고, 읽기는 항상 루트에서만
    찾아 '찾을 수 없습니다'가 났다. 목록은 보이는데 읽기/수정이 안 되는,
    캘린더 조회→수정 실패와 같은 계약 불일치.
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root

    s = get_settings()
    u = SessionUser(username="notefolder", display_name="NF", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-16")
    reg = default_registry()

    root = user_data_root(u, s)
    (root / "프로젝트").mkdir(parents=True, exist_ok=True)
    (root / "프로젝트" / "회의록.md").write_text("# 회의록\n첫 줄", encoding="utf-8")
    (root / "루트노트.md").write_text("# 루트노트\n", encoding="utf-8")

    # 목록은 폴더를 포함한 식별자를 준다
    listed = reg.dispatch("list_documents", {}, ctx)
    assert listed.ok
    idents = [d["path"] for d in listed.data["documents"]]
    assert "프로젝트/회의록" in idents
    assert "루트노트" in idents  # 루트 문서는 확장자 없이

    # 목록이 준 식별자로 바로 읽힌다
    for ident in idents:
        got = reg.dispatch("read_document", {"path": ident}, ctx)
        assert got.ok, f"{ident} 읽기 실패: {got.message}"

    # 검색 결과의 title도 그대로 읽기에 쓸 수 있다
    hit = reg.dispatch("search_documents", {"query": "회의"}, ctx)
    assert hit.data["matches"], "검색 결과 없음"
    assert reg.dispatch("read_document", {"path": hit.data["matches"][0]["path"]}, ctx).ok

    # 폴더를 생략한 제목만 줘도(모델이 흔히 하는 형태) 유일하면 찾아준다
    assert reg.dispatch("read_document", {"path": "회의록"}, ctx).ok

    # 덧붙이기가 새 루트 노트를 만들지 않고 기존 노트를 수정한다
    reg.dispatch("append_document", {"path": "회의록", "content": "둘째 줄"}, ctx)
    assert not (root / "회의록.md").exists(), "루트에 중복 노트가 생기면 안 됨"
    assert "둘째 줄" in (root / "프로젝트" / "회의록.md").read_text(encoding="utf-8")

    # 이름변경은 같은 폴더 안에서 이뤄진다
    assert reg.dispatch(
        "rename_document", {"path": "회의록", "new_name": "주간회의"}, ctx
    ).ok
    assert (root / "프로젝트" / "주간회의.md").exists()

    # 삭제도 폴더 안 노트에 닿는다
    assert reg.dispatch("delete_document", {"path": "프로젝트/주간회의"}, ctx).ok
    assert not (root / "프로젝트" / "주간회의.md").exists()

    # 같은 이름이 여러 폴더에 있으면 임의로 고르지 말고 후보를 알려준다
    (root / "A").mkdir(exist_ok=True)
    (root / "B").mkdir(exist_ok=True)
    (root / "A" / "중복.md").write_text("a", encoding="utf-8")
    (root / "B" / "중복.md").write_text("b", encoding="utf-8")
    amb = reg.dispatch("read_document", {"path": "중복"}, ctx)
    assert not amb.ok and amb.error_code == "ambiguous", f"모호한 제목은 거절해야 함: {amb}"
    assert "A/중복" in amb.message and "B/중복" in amb.message


def test_ai_deletes_go_to_trash():
    """AI 삭제도 웹 UI와 동일하게 휴지통을 거쳐야 한다(복구 가능).

    회귀: delete_note/delete_path만 unlink·rmtree로 영구 삭제해, 대상을 잘못
    짚었을 때 되돌릴 방법이 없었다. 웹은 전부 move_to_trash를 쓴다.
    """
    from backend import trash
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root

    s = get_settings()
    u = SessionUser(username="trashai", display_name="TA", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-16")
    reg = default_registry()

    # 노트 삭제 → 휴지통에서 복구 가능해야
    nroot = user_data_root(u, s)
    (nroot / "지울노트.md").write_text("소중한 내용", encoding="utf-8")
    assert reg.dispatch("delete_document", {"path": "지울노트"}, ctx).ok
    assert not (nroot / "지울노트.md").exists()
    entry = next((e for e in trash.list_trash(u, s) if e["name"] == "지울노트.md"), None)
    assert entry is not None, "삭제한 노트가 휴지통에 없음"
    trash.restore(entry["id"], u, s)
    assert (nroot / "지울노트.md").read_text(encoding="utf-8") == "소중한 내용"

    # 파일 삭제도 동일
    froot = user_data_root(u, s)
    (froot / "지울파일.txt").write_text("파일 내용", encoding="utf-8")
    assert reg.dispatch("delete_document", {"path": "지울파일.txt"}, ctx).ok
    fentry = next((e for e in trash.list_trash(u, s) if e["name"] == "지울파일.txt"), None)
    assert fentry is not None, "삭제한 파일이 휴지통에 없음"
    trash.restore(fentry["id"], u, s)
    assert (froot / "지울파일.txt").exists()

    # 폴더 삭제도 내용째로 복구 가능
    (froot / "지울폴더").mkdir(exist_ok=True)
    (froot / "지울폴더" / "안쪽.txt").write_text("안쪽", encoding="utf-8")
    assert reg.dispatch("delete_document", {"path": "지울폴더"}, ctx).ok
    dentry = next((e for e in trash.list_trash(u, s) if e["name"] == "지울폴더"), None)
    assert dentry is not None, "삭제한 폴더가 휴지통에 없음"
    trash.restore(dentry["id"], u, s)
    assert (froot / "지울폴더" / "안쪽.txt").exists()


def test_ai_find_free_slots_robustness():
    """빈 시간 찾기: 시각 표기 흔들림을 견디고, 오늘이면 지난 시간대를 내놓지 않는다."""
    from datetime import datetime, timedelta

    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="slots", display_name="SL", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-16")
    reg = default_registry()

    # 모델이 흔히 주는 표기들 — 전부 받아들여야 한다
    for ws, we in [("09:00", "18:00"), ("9:00", "18:00"), ("09:00:00", "18:00:00")]:
        r = reg.dispatch(
            "find_free_slots",
            {"date": "2026-09-10", "duration_minutes": 60, "work_start": ws, "work_end": we},
            ctx,
        )
        assert r.ok, f"work_start={ws!r} work_end={we!r} 실패: {r.message}"
        assert r.data["free_slots"], "빈 하루인데 슬롯이 없음"

    # 종료가 시작보다 빠르면 조용히 이상한 결과 대신 명확히 거절
    bad = reg.dispatch(
        "find_free_slots",
        {"date": "2026-09-10", "duration_minutes": 60, "work_start": "18:00", "work_end": "09:00"},
        ctx,
    )
    assert not bad.ok and bad.error_code == "invalid", f"뒤집힌 범위는 거절해야 함: {bad}"

    # 근무시간 밖(저녁) 일정이 슬롯 경계를 끌어당기면 안 된다
    reg.dispatch(
        "create_calendar_event",
        {"title": "저녁약속", "start": "2026-09-11T20:00:00", "end": "2026-09-11T21:00:00"},
        ctx,
    )
    r = reg.dispatch(
        "find_free_slots",
        {"date": "2026-09-11", "duration_minutes": 60, "work_start": "09:00", "work_end": "18:00"},
        ctx,
    )
    assert r.ok
    for slot in r.data["free_slots"]:
        assert slot["end"] <= "2026-09-11T18:00:00", f"근무시간을 넘는 슬롯: {slot}"
        assert slot["start"] >= "2026-09-11T09:00:00", f"근무시간 이전 슬롯: {slot}"

    # 오늘 날짜면 이미 지난 시간대는 제안하지 않는다
    now = datetime.now()
    if now.hour < 22:  # 자정 근처엔 남은 시간이 없어 의미 없는 검사가 됨
        today_ctx = SkillContext(user=u, settings=s, today=now.strftime("%Y-%m-%d"))
        r = reg.dispatch(
            "find_free_slots",
            {"date": now.strftime("%Y-%m-%d"), "duration_minutes": 30,
             "work_start": "00:00", "work_end": "23:59"},
            today_ctx,
        )
        assert r.ok
        for slot in r.data["free_slots"]:
            started = datetime.fromisoformat(slot["start"])
            assert started >= now - timedelta(minutes=1), f"지난 시간대 제안됨: {slot}"


def test_calendar_update_start_preserves_duration():
    """시작만 바꾸면 길이를 유지한 채 끝도 따라와야 한다.

    회귀: end를 안 주면 예전 값이 그대로 남아 '3시로 옮겨줘'(start만 변경) 시
    start=15:00, end=11:00처럼 끝이 시작보다 앞서는 상태가 됐다. 조회 시
    end<start를 start로 클램프하므로 길이 0짜리 일정으로 보였다.
    """
    from backend import calendar_store
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="dur", display_name="D", expires_at=0, remaining=0)

    ev = calendar_store.create_event(
        u, s, {"title": "회의", "start": "2026-09-15T10:00:00", "end": "2026-09-15T11:00:00"}
    )
    # 시작만 15시로 (AI가 "3시로 옮겨줘"에서 흔히 만드는 형태)
    moved = calendar_store.update_event(u, s, ev["id"], {"start": "2026-09-15T15:00:00"})
    assert moved["end"] == "2026-09-15T16:00:00", f"1시간 길이가 유지돼야 함: {moved}"

    # 앞으로 당겨도 동일
    moved2 = calendar_store.update_event(u, s, ev["id"], {"start": "2026-09-15T09:30:00"})
    assert moved2["end"] == "2026-09-15T10:30:00", f"길이 유지 실패: {moved2}"

    # start·end를 함께 주면 준 값을 그대로 쓴다
    both = calendar_store.update_event(
        u, s, ev["id"], {"start": "2026-09-15T13:00:00", "end": "2026-09-15T17:00:00"}
    )
    assert (both["start"], both["end"]) == ("2026-09-15T13:00:00", "2026-09-15T17:00:00")

    # 종일 일정도 길이(일수)를 유지
    allday = calendar_store.create_event(
        u, s, {"title": "휴가", "start": "2026-09-20", "end": "2026-09-22", "allDay": True}
    )
    a2 = calendar_store.update_event(u, s, allday["id"], {"start": "2026-09-25"})
    assert a2["end"] == "2026-09-27", f"종일 일정 길이 유지 실패: {a2}"

    calendar_store.delete_event(u, s, ev["id"])
    calendar_store.delete_event(u, s, allday["id"])


def test_google_partial_update_preserves_fields():
    """Google 캘린더 부분 수정이 나머지 필드를 건드리면 안 된다.

    회귀 1: update가 부분 payload를 그대로 _to_google에 넘겨 전체 본문을 만들었다.
    시작만 옮기면 summary/description이 ''로, colorId가 '2'로 덮이고 end가 start로
    무너졌으며, 제목만 바꾸면 p["start"]에서 KeyError(500)가 났다.
    회귀 2: 전체 본문을 보내느라 recurrence를 우리 모델(FREQ/INTERVAL/UNTIL)로
    재작성했다. 구글 앱에서 만든 'BYDAY=MO,WE,FR;COUNT=30' 일정의 제목만 바꿔도
    수·금 회차가 사라지고 EXDATE로 지워둔 회차가 되살아났다.

    events.patch는 **보내지 않은 필드를 그대로 둔다**. 그러니 안 바꿀 것은
    아예 보내지 않는 것이 정답이다.
    """
    from backend.calendar_google import GoogleCalendar

    stored = {
        "id": "evt1",
        "summary": "치과 진료",
        "description": "2층 접수",
        "colorId": "7",
        "start": {"dateTime": "2026-09-15T10:00:00", "timeZone": "Asia/Seoul"},
        "end": {"dateTime": "2026-09-15T11:00:00", "timeZone": "Asia/Seoul"},
    }

    class _Req:
        def __init__(self, result):
            self._r = result

        def execute(self):
            return self._r

    class _Events:
        def __init__(self):
            self.last_body = None

        def get(self, calendarId, eventId):
            return _Req(stored)

        def patch(self, calendarId, eventId, body):
            self.last_body = body
            merged = {**stored, **body}
            return _Req(merged)

    class _Svc:
        def __init__(self):
            self._e = _Events()

        def events(self):
            return self._e

    svc = _Svc()
    gc = GoogleCalendar(svc, "primary")

    # 시작만 이동 → 제목·설명·색은 아예 보내지 않고(=보존), 길이(1시간)는 유지
    got = gc.update("evt1", {"start": "2026-09-15T15:00:00"})
    body = svc.events().last_body
    assert "summary" not in body and "description" not in body, f"안 바꿀 걸 보냄: {body}"
    assert "colorId" not in body, f"색을 덮어씀: {body}"
    assert body["end"]["dateTime"] == "2026-09-15T16:00:00", f"길이 유지 실패: {body}"
    assert got["title"] == "치과 진료" and got["color"] == "7", got

    # 제목만 수정 → 500이 아니고, 시각은 아예 건드리지 않는다
    got = gc.update("evt1", {"title": "치과 재진"})
    body = svc.events().last_body
    assert body["summary"] == "치과 재진"
    assert "start" not in body and "end" not in body, f"시각을 건드림: {body}"
    assert got["start"] == "2026-09-15T10:00:00", got


def test_google_update_keeps_recurrence_rules_it_cannot_model():
    """우리가 표현하지 못하는 반복 규칙을 수정 한 번에 날리면 안 된다."""
    from backend.calendar_google import GoogleCalendar

    stored = {
        "id": "rec1",
        "summary": "스터디",
        "description": "",
        "colorId": "5",
        "start": {"dateTime": "2026-01-05T19:00:00+09:00"},
        "end": {"dateTime": "2026-01-05T21:00:00+09:00"},
        "recurrence": [
            "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=30",
            "EXDATE;TZID=Asia/Seoul:20260211T190000",
        ],
    }

    class _Req:
        def __init__(self, r):
            self._r = r

        def execute(self):
            return self._r

    class _Events:
        def __init__(self):
            self.last_body = None

        def get(self, calendarId, eventId):
            return _Req(stored)

        def patch(self, calendarId, eventId, body):
            self.last_body = body
            return _Req({**stored, **body})

    class _Svc:
        def __init__(self):
            self._e = _Events()

        def events(self):
            return self._e

    svc = _Svc()
    gc = GoogleCalendar(svc, "primary")

    # 제목만 / 색만 바꾸면 recurrence를 아예 보내지 않는다 → 구글이 원본을 유지
    for payload in ({"title": "스터디(변경)"}, {"color": "3"}):
        gc.update("rec1", payload)
        assert "recurrence" not in svc.events().last_body, svc.events().last_body

    # 반복을 실제로 바꾸라고 하면 그때는 보낸다
    gc.update("rec1", {"recurrence": "daily", "interval": 2})
    body = svc.events().last_body
    assert body["recurrence"] == ["RRULE:FREQ=DAILY;INTERVAL=2"], body

    # 반복을 없애라고 하면 비운다
    gc.update("rec1", {"recurrence": "none"})
    assert svc.events().last_body["recurrence"] == [], svc.events().last_body


def test_google_recurrence_and_reminders_round_trip():
    """Google 경로에서도 반복·알림이 실제로 전달되고 되읽혀야 한다.

    회귀: _to_google가 recurrence/remind_minutes를 아예 보내지 않아, 반복 일정을
    만들어도 1회성 일정이 생기고 알림이 사라졌다. 그런데 AI는 "매주 반복 일정을
    만들었습니다"라고 답했다(조용한 오답).
    """
    from backend.calendar_google import _to_google, _to_internal

    body = _to_google(
        {
            "title": "주간회의",
            "start": "2026-09-15T10:00:00",
            "end": "2026-09-15T11:00:00",
            "recurrence": "weekly",
            "interval": 2,
            "recur_until": "2026-12-31",
            "remind_minutes": 30,
        }
    )
    rrule = next((r for r in body.get("recurrence", []) if r.startswith("RRULE:")), "")
    assert "FREQ=WEEKLY" in rrule, f"반복 규칙이 전달되지 않음: {body}"
    assert "INTERVAL=2" in rrule, f"간격이 전달되지 않음: {rrule}"
    assert "UNTIL=" in rrule, f"종료일이 전달되지 않음: {rrule}"
    mins = [o["minutes"] for o in body.get("reminders", {}).get("overrides", [])]
    assert 30 in mins, f"알림이 전달되지 않음: {body}"

    # 되읽기 — 시리즈를 다시 읽었을 때 값이 복원돼야 부분 수정이 반복을 지우지 않는다
    back = _to_internal(
        {
            "id": "e1",
            "summary": "주간회의",
            "start": {"dateTime": "2026-09-15T10:00:00"},
            "end": {"dateTime": "2026-09-15T11:00:00"},
            "recurrence": ["RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T145959Z"],
            "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 30}]},
        }
    )
    assert back["recurrence"] == "weekly", back
    assert back["interval"] == 2, back
    assert back["recur_until"] == "2026-12-31", back
    assert back["remind_minutes"] == 30, back

    # 반복 없는 일정은 recurrence 키를 아예 넣지 않는다(인스턴스 patch 거부 방지)
    plain = _to_google({"title": "단발", "start": "2026-09-15T10:00:00", "recurrence": "none"})
    assert "recurrence" not in plain, plain

    # 종일 반복은 UNTIL을 날짜 형식으로
    allday = _to_google(
        {"title": "휴가", "start": "2026-09-20", "end": "2026-09-20", "allDay": True,
         "recurrence": "yearly", "recur_until": "2030-01-01"}
    )
    ar = next(r for r in allday["recurrence"] if r.startswith("RRULE:"))
    assert "UNTIL=20300101" in ar and "T" not in ar.split("UNTIL=")[1], ar


def test_uncategorized_filter_does_not_return_everything():
    """'미분류'는 카테고리가 아니라 **카테고리 없음**이다.

    자손 카테고리를 포함하도록 고치면서 부모 맵의 빈 열쇠("")가 최상위 카테고리
    전부를 가리키게 됐다. 그 바람에 미분류 지정 조회가 모든 할 일을 돌려준다.
    """
    from backend import todo_store
    from backend.auth import SessionUser

    _login()
    cat = client.post("/api/todo/categories", json={"name": "분류있음"}).json()
    client.post("/api/todo/create", json={"title": "분류된것", "category_id": cat["id"]})
    client.post("/api/todo/create", json={"title": "분류없는것"})
    try:
        me = SessionUser(username="tester", display_name="T", expires_at=0, remaining=0)
        s = get_settings()
        board = todo_store.board(me, s)
        todos, cats = board["todos"], board["categories"]

        loose = todo_store.filter_todos(todos, category_id="", categories=cats)
        names = sorted(t["title"] for t in loose)
        assert "분류된것" not in names, names
        assert "분류없는것" in names, names

        # 지정한 카테고리 조회는 그대로 동작해야 한다
        picked = todo_store.filter_todos(todos, category_id=cat["id"], categories=cats)
        assert [t["title"] for t in picked] == ["분류된것"], picked
    finally:
        for t in client.get("/api/todo/board").json()["todos"]:
            client.delete(f"/api/todo/{t['id']}")
        client.delete(f"/api/todo/categories/{cat['id']}")


def test_emptying_the_trash_does_not_leave_ghosts_when_the_index_write_fails():
    """실물을 먼저 지우면, 인덱스 쓰기가 실패했을 때 유령만 남는다.

    목록에는 보이는데 복원은 전부 410 이고, 사용자는 지운 것을 되찾을 수 없다.
    """
    from backend import trash as trash_mod

    _login()
    client.put("/api/notes/save", json={"path": "유령시험.md", "content": "되찾아야 함"})
    assert client.delete("/api/notes/delete?path=유령시험.md").status_code == 200
    entry = next(e for e in client.get("/api/trash/list").json() if e["name"] == "유령시험.md")

    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    real = trash_mod.write_atomic
    trash_mod.write_atomic = lambda *a, **k: (_ for _ in ()).throw(OSError(28, "no space"))
    try:
        r = quiet.delete("/api/trash/empty")
        assert r.status_code == 500, r.text
    finally:
        trash_mod.write_atomic = real

    # 인덱스에 남았으면 **실물도 남아 있어야** 한다 — 복원되는지로 확인한다
    listed = client.get("/api/trash/list").json()
    if any(e["id"] == entry["id"] for e in listed):
        r = client.post(f"/api/trash/restore?id={entry['id']}")
        assert r.status_code == 200, f"목록엔 있는데 복원이 안 된다(유령): {r.text}"
        got = client.get("/api/notes/get", params={"path": "유령시험.md"})
        assert got.status_code == 200 and got.json()["content"] == "되찾아야 함", got.text
        client.delete("/api/notes/delete?path=유령시험.md")
    client.delete("/api/trash/empty")


def test_restore_reports_a_conflict_instead_of_crashing():
    """복원할 자리의 상위 폴더 자리에 지금 '파일'이 있으면 500 이 아니라 409."""
    _login()
    client.post("/api/notes/folder", json={"path": "복원충돌"})
    client.put("/api/notes/save", json={"path": "복원충돌/안쪽.md", "content": "x"})
    assert client.delete("/api/notes/delete?path=복원충돌/안쪽.md").status_code == 200
    # 폴더를 지우고 **같은 이름의 문서**를 만든다
    assert client.delete("/api/notes/folder?path=복원충돌").status_code == 200
    r = client.put("/api/notes/save", json={"path": "복원충돌", "content": "이제는 문서다"})
    assert r.status_code == 200, r.text

    entry = next(e for e in client.get("/api/trash/list").json() if e["name"] == "안쪽.md")
    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    r = quiet.post(f"/api/trash/restore?id={entry['id']}")
    assert r.status_code == 409, r.text
    # 실패했으면 휴지통에 그대로 남아 있어야 한다(복원할 기회를 뺏으면 안 된다)
    assert any(e["id"] == entry["id"] for e in client.get("/api/trash/list").json())
    client.request("DELETE", "/api/notes/delete", json={"path": "복원충돌"})


def test_empty_color_is_not_sent_to_google():
    """색을 정하지 않은 일정에 `colorId: ""` 를 실어 보내면 구글이 거절한다.

    colorId 없는 구글 일정을 '' 로 읽도록 바꾼 뒤로, 편집창이 그 '' 를 그대로
    되돌려 보내게 됐다(어제까지는 '2' 였다).
    """
    from backend.calendar_google import _to_google, _to_google_partial

    when = {"start": "2027-02-03T10:00:00", "end": "2027-02-03T11:00:00"}
    assert "colorId" not in _to_google({"title": "무색", "color": "", **when})
    assert "colorId" not in _to_google({"title": "무색", **when})
    assert _to_google({"title": "색있음", "color": "5", **when})["colorId"] == "5"

    assert "colorId" not in _to_google_partial({"title": "제목만", "color": ""})
    assert _to_google_partial({"title": "x", "color": "9"})["colorId"] == "9"


def test_terminal_status_gate():
    """웹터미널 권한 규칙: **주인이면서 화이트리스트에도 있어야** 한다.

    예전에는 값의 '타입'만 봤다. 테스트 환경에서는 TERMINAL_ADMINS 가 비어 있어
    is_admin 이 언제나 False 였고, 실제 규칙은 한 갈래도 실행되지 않았다.
    """
    login_guard.reset()
    s = get_settings()
    TestClient(app).post("/api/auth/signup",
                         json={"username": "termguest", "password": "pw-long-enough"})
    _login()
    client.post("/api/admin/users/termguest/approve")
    member = TestClient(app)
    member.post("/api/auth/login", json={"username": "termguest", "password": "pw-long-enough"})

    was_admins, was_enabled = s.terminal_admins, s.terminal_enabled
    try:
        # 주인 + 화이트리스트 + 켜짐 → 쓸 수 있다
        s.terminal_admins, s.terminal_enabled = ["tester", "termguest"], True
        st = client.get("/api/terminal/status").json()
        assert st == {"enabled": True, "is_admin": True, "available": True}, st

        # 꺼져 있으면 권한이 있어도 못 쓴다
        s.terminal_enabled = False
        assert client.get("/api/terminal/status").json()["available"] is False

        # 주인이지만 화이트리스트에 없으면 관리자가 아니다
        s.terminal_admins, s.terminal_enabled = ["다른사람"], True
        st = client.get("/api/terminal/status").json()
        assert st["is_admin"] is False and st["available"] is False, st

        # **화이트리스트에 있어도 주인이 아니면 안 된다**(권한 축소 방향)
        s.terminal_admins = ["tester", "termguest"]
        st = member.get("/api/terminal/status").json()
        assert st["is_admin"] is False and st["available"] is False, st
    finally:
        s.terminal_admins, s.terminal_enabled = was_admins, was_enabled
        client.delete("/api/admin/users/termguest")


def test_settings_get_patch():
    _login()
    s = client.get("/api/settings").json()
    assert s["settings"]["ai"]["tone"] == "assistant"
    client.patch("/api/settings", json={"changes": {"ai": {"tone": "friend"}}})
    after = client.get("/api/settings").json()
    assert after["settings"]["ai"]["tone"] == "friend"
    # 다른 기본값은 유지(병합)
    assert after["settings"]["calendar"]["default_view"] == "dayGridMonth"


def test_session_ttl_setting():
    """세션 자동 로그아웃 시간 설정: 로그인 remaining이 사용자 설정값을 따르고, 범위 밖은 클램프."""
    _login()
    # 30분으로 설정 → 로그인 시 remaining=1800
    client.patch("/api/settings", json={"changes": {"security": {"session_ttl_minutes": 30}}})
    r = client.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    assert r.json()["remaining"] == 1800
    # 1분(최소 5분 미만)으로 설정 → 300초로 클램프
    client.patch("/api/settings", json={"changes": {"security": {"session_ttl_minutes": 1}}})
    r = client.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    assert r.json()["remaining"] == 300
    # 원복(다른 테스트 영향 방지)
    client.patch("/api/settings", json={"changes": {"security": {"session_ttl_minutes": 60}}})


def test_calendar_lifecycle():
    _login()
    r = client.post(
        "/api/calendar/events",
        json={"title": "회의", "start": "2026-07-02T10:00:00", "end": "2026-07-02T11:00:00"},
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    got = client.get("/api/calendar/events").json()
    assert any(e["id"] == eid for e in got)
    client.put(f"/api/calendar/events/{eid}", json={"title": "수정된 회의"})
    after = client.get("/api/calendar/events").json()
    assert any(e["id"] == eid and e["title"] == "수정된 회의" for e in after)
    assert client.delete(f"/api/calendar/events/{eid}").status_code == 200


def test_ai_call_failure_does_not_leak_internals():
    """상류(Gemini SDK)의 예외 문자열에는 경로·키·요청 본문이 섞일 수 있다.

    라우터는 예외를 DEBUG 일 때만 흘리는데, 이 경로는 예외가 아니라 **값**으로
    와서 그 마스킹을 통째로 우회했다.
    """
    from backend.ai import orchestrator
    from backend.ai.orchestrator import LLMResult
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="tester", display_name="T", expires_at=0, remaining=0)
    secret = "API key AIzaSyLEAKED at C:\\srv\\keys\\gemini.json"

    class Broken:
        def chat(self, contents, catalog, system):
            return LLMResult(text="", error=secret)

    was = s.debug
    try:
        s.debug = False
        msgs = [e.get("message", "") for e in orchestrator.run(u, s, "안녕", "2026-09-02", llm=Broken())]
        joined = " ".join(msgs)
        assert "AIzaSyLEAKED" not in joined and "C:\\srv" not in joined, joined
        assert any("AI 호출 실패" in m for m in msgs), msgs

        # DEBUG 로 켜 두면 개발자는 원문을 봐야 한다
        s.debug = True
        msgs = [e.get("message", "") for e in orchestrator.run(u, s, "안녕", "2026-09-02", llm=Broken())]
        assert any("AIzaSyLEAKED" in m for m in msgs), msgs
    finally:
        s.debug = was


def test_ai_react_chains_skills():
    from backend.ai import orchestrator
    from backend.ai.orchestrator import LLMResult
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root
    from backend import calendar_store

    s = get_settings()
    user = SessionUser(username="tester", display_name="Tester", expires_at=0, remaining=0)

    class FakeLLM:
        def __init__(self):
            self.n = 0

        def chat(self, contents, catalog, system):
            self.n += 1
            if self.n == 1:
                return LLMResult(text="", tool_use={"name": "write_document", "args": {"path": "plan", "content": "# plan\n[[meeting]]"}})
            if self.n == 2:
                return LLMResult(text="", tool_use={"name": "create_calendar_event", "args": {"title": "미팅", "start": "2026-07-05T10:00:00"}})
            return LLMResult(text="노트와 일정을 만들었습니다.", tool_use=None)

    events = list(orchestrator.run(user, s, "계획 노트 만들고 일정 잡아줘", "2026-07-01", llm=FakeLLM()))
    types = [e["type"] for e in events]
    assert types.count("tool_call") == 2  # 스킬 2개 연속 실행
    assert any(e["type"] == "text" and "일정" in e["text"] for e in events)
    # 실제 생성 확인 (사용자 스코프)
    assert (user_data_root(user, s) / "plan.md").exists()
    assert any(ev["title"] == "미팅" for ev in calendar_store.list_events(user, s))


def test_ai_react_runs_all_parallel_calls():
    """한 응답에 스킬 호출이 여러 개 오면 전부 실행돼야 한다.

    회귀: 첫 호출만 쓰고 break로 나머지를 버려, 모델이 요청한 작업이 조용히
    누락되고 다음 스텝에서 다시 요청하느라 max_steps를 낭비했다.
    """
    from types import SimpleNamespace

    from backend.ai import orchestrator
    from backend.ai.orchestrator import LLMResult, parse_candidate
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root

    # 응답 파싱 자체가 호출을 빠뜨리지 않는지 — 결함이 있던 지점을 직접 검증
    cand = SimpleNamespace(
        content=SimpleNamespace(
            parts=[
                SimpleNamespace(text="확인했습니다.", function_call=None),
                SimpleNamespace(text="", function_call=SimpleNamespace(name="f1", args={"a": 1})),
                SimpleNamespace(text="", function_call=SimpleNamespace(name="f2", args={"b": 2})),
            ]
        )
    )
    text, uses = parse_candidate(cand)
    assert [u_["name"] for u_ in uses] == ["f1", "f2"], f"호출이 누락됨: {uses}"
    assert text == "확인했습니다.", text
    assert uses[1]["args"] == {"b": 2}

    s = get_settings()
    u = SessionUser(username="par", display_name="P", expires_at=0, remaining=0)

    class FakeLLM:
        def __init__(self):
            self.n = 0
            self.seen = None

        def chat(self, contents, catalog, system):
            self.n += 1
            if self.n == 1:
                return LLMResult(text="", tool_uses=[
                    {"name": "write_document", "args": {"path": "A", "content": "a"}},
                    {"name": "write_document", "args": {"path": "B", "content": "b"}},
                ])
            self.seen = contents
            return LLMResult(text="둘 다 만들었습니다.")

    llm = FakeLLM()
    events = list(orchestrator.run(u, s, "노트 두 개 만들어줘", "2026-08-16", llm=llm))
    assert [e["name"] for e in events if e["type"] == "tool_call"] == ["write_document", "write_document"]

    root = user_data_root(u, s)
    assert (root / "A.md").exists() and (root / "B.md").exists(), "두 번째 호출이 실행되지 않음"

    # 호출 수와 응답 수가 맞아야 Gemini가 대화를 받아들인다
    model_turn = next(c for c in llm.seen if c["role"] == "model")
    resp_turn = llm.seen[llm.seen.index(model_turn) + 1]
    assert len(model_turn["parts"]) == 2, model_turn
    assert len(resp_turn["parts"]) == 2, resp_turn
    assert all("function_response" in p for p in resp_turn["parts"])


def test_mutating_skills_declare_what_they_change():
    """상태를 바꾸는 스킬은 mutates를 선언해야 한다.

    프런트는 tool_result.mutates를 보고 해당 화면을 새로고침한다. 선언이 빠지면
    "AI는 고쳤다는데 화면은 그대로"가 되고, 새로고침해야 보인다
    (bulk_update_calendar_events를 추가했을 때 실제로 그랬다).
    """
    from backend.ai.skills import ALL_SKILLS

    by_name = {s.name: s for s in ALL_SKILLS}
    expect_calendar = {
        "create_calendar_event", "update_calendar_event",
        "bulk_update_calendar_events", "delete_calendar_event",
    }
    expect_documents = {
        "write_document", "append_document", "delete_document",
        "rename_document", "move_document", "create_folder",
    }
    for n in expect_calendar:
        assert by_name[n].mutates == "calendar", f"{n}이 mutates를 선언하지 않았다"
    for n in expect_documents:
        assert by_name[n].mutates == "documents", f"{n}이 mutates를 선언하지 않았다"

    # 조회 전용은 빈 값이어야 한다(불필요한 새로고침 방지)
    for n in ("list_calendar_events", "find_free_slots", "list_documents",
              "read_document", "search_documents", "document_backlinks"):
        assert by_name[n].mutates == "", f"{n}은 조회인데 mutates가 있다"

    # 이름으로 미루어 바꾸는 것 같은데 선언이 없는 스킬이 새로 생기면 잡는다
    verbs = ("create_", "update_", "delete_", "write_", "append_", "rename_", "move_", "bulk_")
    missing = [s.name for s in ALL_SKILLS
               if s.name.startswith(verbs) and not s.mutates]
    assert not missing, f"mutates 선언이 빠진 스킬: {missing}"


def test_document_writes_are_serialized_and_atomic():
    """동시 쓰기에서 내용이 사라지거나 섞이지 않아야 한다.

    문서 저장에 락도 원자성도 없었다. AI append와 UI 자동저장이 read-modify-write를
    겹쳐 서로를 덮어썼고(실측: 락 없이 동시 20건 중 2건만 남음), plain write_text라
    쓰는 도중 죽으면 파일이 잘린 채 남았다.
    """
    import threading

    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root

    s = get_settings()
    u = SessionUser(username="concur", display_name="CC", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-27")
    reg = default_registry()
    root = user_data_root(u, s)

    reg.dispatch("write_document", {"path": "일지", "content": "시작"}, ctx)
    failures: list[str] = []

    def add_line(i: int) -> None:
        r = reg.dispatch("append_document", {"path": "일지", "content": f"줄{i}"}, ctx)
        if not r.ok:
            failures.append(r.message)

    threads = [threading.Thread(target=add_line, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    text = (root / "일지.md").read_text(encoding="utf-8")
    kept = [i for i in range(20) if f"줄{i}" in text]
    assert not failures, failures
    assert len(kept) == 20, f"{len(kept)}/20만 남았다 — 덧붙이기가 서로를 덮어쓴다"

    # 동시 덮어쓰기는 '어느 한 값'으로 끝나야 한다(섞이면 안 된다)
    def overwrite(i: int) -> None:
        reg.dispatch("write_document", {"path": "덮어", "content": f"v{i}"}, ctx)

    threads = [threading.Thread(target=overwrite, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    final = (root / "덮어.md").read_text(encoding="utf-8")
    assert final in {f"v{i}" for i in range(10)}, repr(final)

    # 임시파일이 남지 않는다(이름이 PID만이면 스레드끼리 충돌해 남았다)
    assert not list(root.rglob("*.tmp*")), list(root.rglob("*.tmp*"))


def test_recurring_single_occurrence_roundtrip():
    """반복 일정 '한 회차만' 삭제 → 휴지통 → 복원.

    id 규칙을 통일하면서 단건 삭제에도 base_id를 적용했더니, 구글에서는
    "그날 것만 지워줘"가 시리즈 전체를 지웠다(내가 만든 회귀). 또 휴지통에
    시리즈 원본이 담겨 복원하면 반복 일정이 통째로 중복 생성됐다.
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend import trash

    s = get_settings()
    u = SessionUser(username="recur1", display_name="R1", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-27")
    reg = default_registry()

    reg.dispatch("create_calendar_event", {
        "title": "스탠드업", "start": "2026-09-01T09:00:00",
        "end": "2026-09-01T09:15:00", "recurrence": "weekly",
    }, ctx)
    win = {"from_date": "2026-09-01", "to_date": "2026-09-30"}
    before = reg.dispatch("list_calendar_events", win, ctx).data["events"]
    assert len(before) >= 4, before
    target = before[1]

    assert reg.dispatch("delete_calendar_event", {"event_id": target["id"]}, ctx).ok
    after = reg.dispatch("list_calendar_events", win, ctx).data["events"]
    assert len(after) == len(before) - 1, "시리즈가 통째로 지워지면 안 된다"

    # 휴지통에는 '그 회차'만 담긴다(시리즈가 아니라)
    entries = trash.list_trash(u, s, trash.KIND_EVENT)
    assert len(entries) == 1 and entries[0]["event_start"].startswith("2026-09-08"), entries
    assert reg.dispatch("restore_from_trash", {"id": entries[0]["id"]}, ctx).ok
    back = reg.dispatch("list_calendar_events", win, ctx).data["events"]
    assert len(back) == len(before), "복원이 시리즈를 복제하면 안 된다"


def test_ai_write_target_rules():
    """쓰기 대상 선택 — 이미지 충돌과 점 있는 제목."""
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root

    s = get_settings()
    u = SessionUser(username="wtarget", display_name="WT", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-27")
    reg = default_registry()
    root = user_data_root(u, s)

    # 같은 이름의 이미지가 있어도 노트를 만들 수 있어야 한다(예전엔 거절됐다)
    (root / "사진").mkdir(parents=True, exist_ok=True)
    (root / "사진" / "여행.png").write_bytes(b"PNG")
    r = reg.dispatch("write_document", {"path": "여행", "content": "# 여행"}, ctx)
    assert r.ok, r.message
    assert (root / "여행.md").exists()
    assert (root / "사진" / "여행.png").read_bytes() == b"PNG"  # 이미지는 그대로
    # 이미지 자체를 정확히 지정하면 여전히 거절된다
    assert not reg.dispatch("write_document", {"path": "사진/여행.png", "content": "x"}, ctx).ok

    # 제목에 점이 있어도 .md가 붙어 다시 열린다
    # (Path("v1.2 회의록").suffix == ".2 회의록" 이라 확장자로 오판했다)
    assert reg.dispatch("write_document", {"path": "v1.2 회의록", "content": "본문"}, ctx).ok
    assert (root / "v1.2 회의록.md").exists()
    assert reg.dispatch("read_document", {"path": "v1.2 회의록"}, ctx).ok


def test_ai_round2_hardening():
    """2차 점검 수정분 — 상한·식별자 충돌·폴더 목록·입력 제한."""
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.ai.skills.documents import _ident, _resolve
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root

    s = get_settings()
    u = SessionUser(username="round2", display_name="R2", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-27")
    reg = default_registry()
    root = user_data_root(u, s)

    # 확장자 없는 파일과 .md가 같은 식별자가 되어 .md가 가려지던 문제
    (root / "메모").write_text("확장자 없음", encoding="utf-8")
    (root / "메모.md").write_text("마크다운", encoding="utf-8")
    (root / "보통.md").write_text("보통", encoding="utf-8")
    assert _ident(root, root / "메모.md") == "메모.md"   # 충돌하면 확장자 유지
    assert _ident(root, root / "보통.md") == "보통"       # 충돌 없으면 그대로 생략
    assert _resolve(root, "메모.md").read_text(encoding="utf-8") == "마크다운"
    assert _resolve(root, "메모").read_text(encoding="utf-8") == "확장자 없음"
    idents = [d["path"] for d in reg.dispatch("list_documents", {}, ctx).data["documents"]]
    assert len(idents) == len(set(idents)), idents  # 목록에 같은 값이 두 번 나오지 않는다

    # 빈 폴더도 AI가 볼 수 있어야 한다(오타 폴더가 조용히 생기는 것을 막는다)
    (root / "빈폴더").mkdir(exist_ok=True)
    folders = reg.dispatch("list_folders", {}, ctx)
    assert folders.ok and "빈폴더" in folders.data["folders"], folders.data

    # 일정 목록 상한 — 수백 건을 통째로 모델에 싣지 않는다
    from backend.ai.skills.calendar import _MAX_LIST

    from backend.ai.skills.calendar import BulkCreateCalendarEvents

    # 일괄 생성에는 호출당 상한이 있다 — 나눠서 넣는다.
    per = BulkCreateCalendarEvents.MAX
    total_want = _MAX_LIST + 20
    for off in range(0, total_want, per):
        chunk = [
            {"title": f"e{i}", "start": f"2026-09-{(i % 28) + 1:02d}T10:00:00"}
            for i in range(off, min(off + per, total_want))
        ]
        r = reg.dispatch("bulk_create_calendar_events", {"events": chunk}, ctx)
        assert r.ok, r.message
    listed = reg.dispatch("list_calendar_events",
                          {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx)
    assert len(listed.data["events"]) == _MAX_LIST
    assert listed.data["truncated"] is True and listed.data["total"] == _MAX_LIST + 20
    assert "기간을 좁히세요" in listed.message

    # 채팅 입력 상한이 존재한다(주인 키를 무제한으로 태울 수 없게)
    from backend.routers.ai import MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, MAX_MESSAGE_CHARS

    assert MAX_MESSAGE_CHARS > 0 and MAX_HISTORY_TURNS > 0 and MAX_HISTORY_CHARS > 0
    _login()
    assert client.post("/api/ai/chat", json={"message": "   "}).status_code == 400


def test_ai_document_safety_rules():
    """전면 점검에서 확인된 문서 스킬 결함들(전부 데이터 손실 경로였다)."""
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root
    from backend.trash import KIND_DOCUMENT, list_trash

    s = get_settings()
    u = SessionUser(username="docsafe", display_name="DS", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-27")
    reg = default_registry()
    root = user_data_root(u, s)

    # (1) 폴더를 명시했으면 다른 폴더의 같은 이름 문서를 건드리면 안 된다.
    #     예전엔 '업무/보고서'가 없으면 트리 전체에서 '보고서'를 찾아
    #     '개인/보고서.md'를 덮어썼다(복구 불가였다).
    (root / "개인").mkdir(parents=True, exist_ok=True)
    (root / "개인" / "보고서.md").write_text("원본 내용", encoding="utf-8")
    r = reg.dispatch("write_document", {"path": "업무/보고서", "content": "새 업무 보고"}, ctx)
    assert r.ok, r.message
    assert (root / "개인" / "보고서.md").read_text(encoding="utf-8") == "원본 내용"
    assert (root / "업무" / "보고서.md").read_text(encoding="utf-8") == "새 업무 보고"
    # 삭제·이동도 같은 규칙
    assert not reg.dispatch("delete_document", {"path": "없는폴더/보고서"}, ctx).ok
    assert (root / "개인" / "보고서.md").exists()

    # (2) 덮어쓰기는 이전 내용을 휴지통에 남긴다(가장 되돌리기 어려운 동작이었다)
    before = len(list_trash(u, s, KIND_DOCUMENT))
    r = reg.dispatch("write_document", {"path": "개인/보고서", "content": "덮어쓴 내용"}, ctx)
    assert r.ok and r.data["backed_up"] is True, r.data
    after = list_trash(u, s, KIND_DOCUMENT)
    assert len(after) == before + 1
    assert reg.dispatch("restore_from_trash", {"id": after[0]["id"]}, ctx).ok
    restored = [p for p in (root / "개인").iterdir() if p.name.startswith("보고서")]
    assert any("원본 내용" in p.read_text(encoding="utf-8") for p in restored), restored

    # (3) 긴 문서를 읽으면 잘렸다고 알려준다(모델이 되쓰면 뒤가 사라지므로)
    long_text = "가" * 25000
    (root / "긴글.md").write_text(long_text, encoding="utf-8")
    rd = reg.dispatch("read_document", {"path": "긴글"}, ctx)
    assert rd.ok and rd.data["truncated"] is True
    assert rd.data["total_chars"] == 25000 and rd.data["read_chars"] == 20000
    assert "25000자 중" in rd.message and "사라집니다" in rd.message
    short = reg.dispatch("read_document", {"path": "개인/보고서"}, ctx)
    assert short.data["truncated"] is False

    # (4) 민감 판정은 '해석된 실제 경로'로 한다 — 폴더를 빼고 이름만 줘도 막혀야 한다
    (root / "비밀").mkdir(parents=True, exist_ok=True)
    (root / "비밀" / "일기.md").write_text("카드번호 4123-9999", encoding="utf-8")
    blocked_full = reg.dispatch("read_document", {"path": "비밀/일기"}, ctx)
    blocked_name = reg.dispatch("read_document", {"path": "일기"}, ctx)
    assert blocked_full.error_code == "blocked"
    assert blocked_name.error_code == "blocked", blocked_name.data  # 예전엔 여기서 뚫렸다


def test_ai_calendar_id_and_filter_rules():
    """반복 id 규칙 일원화 + event_ids가 기본 조회창에 갇히지 않는지."""
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.calendar_ids import base_id, is_instance
    from backend.config import get_settings

    # 규칙은 한 곳에서만 정의된다 — 예전엔 세 벌이 갈라져 구글에서만 깨졌다
    assert base_id("abc_20260305T100000Z") == "abc" and is_instance("abc_20260305T100000Z")
    assert base_id("abc@2026-03-05") == "abc" and is_instance("abc@2026-03-05")
    assert base_id("abc") == "abc" and not is_instance("abc")

    s = get_settings()
    u = SessionUser(username="calids", display_name="CI", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-27")
    reg = default_registry()

    # 기본 조회창(오늘-30일~+120일) 밖의 일정
    reg.dispatch("create_calendar_event",
                 {"title": "작년 회고", "start": "2025-12-10T10:00:00",
                  "end": "2025-12-10T11:00:00", "color": "노랑"}, ctx)
    old = reg.dispatch("list_calendar_events",
                       {"from_date": "2025-12-01", "to_date": "2025-12-31"}, ctx).data["events"]
    assert len(old) == 1
    eid = old[0]["id"]

    # 조회가 준 id를 기간 없이 그대로 넘겨도 동작해야 한다
    r = reg.dispatch("bulk_update_calendar_events",
                     {"event_ids": [eid], "title_prefix": "[완료] "}, ctx)
    assert r.ok and r.data["count"] == 1, (r.message, r.data)
    again = reg.dispatch("list_calendar_events",
                         {"from_date": "2025-12-01", "to_date": "2025-12-31"}, ctx).data["events"]
    assert again[0]["title"] == "[완료] 작년 회고"

    # 없는 id는 조용히 0건이 아니라 왜 못 찾았는지 알려준다
    miss = reg.dispatch("bulk_update_calendar_events",
                        {"event_ids": ["없는id"], "title_prefix": "x"}, ctx)
    assert not miss.ok and miss.error_code == "not_found" and "없는id" in miss.message

    # 단건 수정도 모르는 색을 거절한다(예전엔 조용히 기본색으로 덮었다)
    bad = reg.dispatch("update_calendar_event", {"event_id": eid, "color": "민트색"}, ctx)
    assert not bad.ok and bad.error_code == "invalid"
    same = reg.dispatch("list_calendar_events",
                        {"from_date": "2025-12-01", "to_date": "2025-12-31"}, ctx).data["events"]
    assert same[0]["color"] == "5", same  # 노랑 그대로


def test_ai_can_undo_its_own_deletions():
    """지우는 힘을 준 곳에는 되돌리는 힘도 있어야 한다.

    문서·일정을 지우는 스킬은 있는데 휴지통 스킬이 없어서, AI가 방금 지운 것을
    되살릴 수 없었다(사용자가 UI로 직접 들어가야 했다).
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root

    s = get_settings()
    u = SessionUser(username="undoer", display_name="UD", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-27")
    reg = default_registry()

    # 문서 하나, 일정 하나를 만들고 AI가 지운다
    root = user_data_root(u, s)
    (root / "소중한메모.md").write_text("# 소중한메모\n지우면 안 되는 내용", encoding="utf-8")
    reg.dispatch("create_calendar_event",
                 {"title": "지울일정", "start": "2026-09-05T10:00:00",
                  "end": "2026-09-05T11:00:00", "color": "보라"}, ctx)

    assert reg.dispatch("delete_document", {"path": "소중한메모"}, ctx).ok
    ev = reg.dispatch("list_calendar_events",
                      {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx).data["events"]
    assert reg.dispatch("delete_calendar_event", {"event_id": ev[0]["id"]}, ctx).ok

    # 휴지통에서 둘 다 보인다 — 갈래로 걸러진다
    listed = reg.dispatch("list_trash", {}, ctx)
    assert listed.ok and len(listed.data["items"]) == 2, listed.data
    docs = reg.dispatch("list_trash", {"kind": "document"}, ctx).data["items"]
    evs = reg.dispatch("list_trash", {"kind": "event"}, ctx).data["items"]
    assert [d["name"] for d in docs] == ["소중한메모.md"], docs
    assert [e["name"] for e in evs] == ["지울일정"], evs
    assert evs[0]["event_start"].startswith("2026-09-05")

    # 이름으로도 좁힌다(모델이 "메모 되살려줘"라고 할 때)
    hit = reg.dispatch("list_trash", {"name_contains": "소중한"}, ctx).data["items"]
    assert len(hit) == 1 and hit[0]["kind"] == "document"

    # 복원 — 문서는 원래 경로로, 결과가 바뀐 화면을 알려준다
    r1 = reg.dispatch("restore_from_trash", {"id": docs[0]["id"]}, ctx)
    assert r1.ok and r1.mutates == "documents", (r1.message, r1.mutates)
    assert (root / "소중한메모.md").read_text(encoding="utf-8").startswith("# 소중한메모")

    # 일정은 캘린더에 다시 생기고, mutates가 calendar로 바뀐다
    r2 = reg.dispatch("restore_from_trash", {"id": evs[0]["id"]}, ctx)
    assert r2.ok and r2.mutates == "calendar", (r2.message, r2.mutates)
    back = reg.dispatch("list_calendar_events",
                        {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx).data["events"]
    assert [e["title"] for e in back] == ["지울일정"] and back[0]["color"] == "9", back

    # 휴지통이 비었고, 없는 id는 조용히 성공하지 않는다
    assert reg.dispatch("list_trash", {}, ctx).data["items"] == []
    assert not reg.dispatch("restore_from_trash", {"id": "없는id"}, ctx).ok
    assert not reg.dispatch("restore_from_trash", {"id": ""}, ctx).ok

    # 영구 삭제·비우기는 스킬로 열지 않는다(되돌릴 수 없다)
    names = {sk.name for sk in reg._skills.values()}  # noqa: SLF001
    assert not {"purge_trash", "empty_trash"} & names, names


def test_ai_model_selectable_in_settings():
    """설정에서 고른 모델이 실제 호출에 쓰이고, 없는 모델은 저장이 막힌다."""
    from backend.ai import models as ai_models
    from backend.ai.orchestrator import GeminiLLM
    from backend.config import get_settings

    s = get_settings()
    _login()

    # 목록은 대화용만 — 이미지/TTS/전사/로봇 모델이 섞이면 고르는 순간 비서가 망가진다.
    #
    # **거르는 규칙을 직접 먹여 본다.** list_models 의 결과만 보면, API 키가 없는
    # 곳에서는 하드코딩된 _FALLBACK 3개만 돌아와 필터가 한 번도 실행되지 않는다
    # (그래도 초록불이라, 필터가 통째로 사라져도 알 수 없었다).
    should_pass = ["gemini-2.5-pro", "gemini-3.0-flash", "gemini-2.5-flash-lite"]
    should_fail = [
        "gemini-2.5-flash-image", "gemini-2.5-flash-tts", "gemini-2.5-transcribe",
        "gemini-robotics-er", "gemini-2.5-computer-use", "gemini-omni",
        "text-embedding-004", "imagen-3.0",  # gemini 로 시작하지도 않는다
    ]
    for name in should_pass:
        assert ai_models._is_chat_model(name), name
    for name in should_fail:
        assert not ai_models._is_chat_model(name), name

    listed = [m["id"] for m in ai_models.list_models(s)]
    assert listed, "목록이 비면 드롭다운이 빈칸이 된다"
    assert all(ai_models._is_chat_model(m) for m in listed), listed
    # 현재 서버 기본값은 항상 고를 수 있어야 한다
    assert s.gemini_model in listed, (s.gemini_model, listed)

    # API로도 같은 목록을 준다
    r = client.get("/api/ai/models")
    assert r.status_code == 200
    body = r.json()
    assert [m["id"] for m in body["models"]] == listed
    assert body["server_default"] == s.gemini_model

    # 고른 모델이 실제 호출에 쓰인다
    pick = listed[0]
    assert client.patch("/api/settings", json={"changes": {"ai": {"model": pick}}}).status_code == 200
    assert client.get("/api/settings").json()["settings"]["ai"]["model"] == pick
    assert GeminiLLM(s, pick)._model == pick
    # 빈 값이면 서버 기본으로 되돌아간다
    assert GeminiLLM(s, "")._model == s.gemini_model

    # 없는 모델은 저장 자체를 막는다(저장되면 그 뒤 AI가 통째로 실패한다).
    #
    # 목록을 **실제로 받아온 상태**에서만 막는 규칙이다(models.is_allowed). 그러니
    # 여기서 목록을 그렇게 고정해 둔다. 예전에는 이 단언이 개발 기기의 .env 에
    # 유효한 API 키가 있는지에 따라 통과했다 갔다 했다 — 키가 없는 곳(CI·새로 받은
    # 저장소·복사본)에서는 그냥 빨간불이었고, 그게 진짜 회귀를 가렸다.
    saved_cache = ai_models._CACHE
    ai_models._CACHE = {
        "at": time.time(),
        "items": [{"id": m, "label": m} for m in listed],
        "live": True,
    }
    try:
        bad = client.patch("/api/settings", json={"changes": {"ai": {"model": "gemini-없는모델"}}})
        assert bad.status_code == 400, bad.text
        assert client.get("/api/settings").json()["settings"]["ai"]["model"] == pick  # 그대로
    finally:
        ai_models._CACHE = saved_cache

    # 반대로 목록을 못 받아온 상태에서는 막지 않는다 — 네트워크가 잠깐 끊긴 탓에
    # "저장이 안 된다"가 되면 사용자는 원인을 알 수 없다(models.is_allowed 의 의도).
    ai_models._CACHE = {"at": time.time(), "items": [{"id": pick, "label": pick}], "live": False}
    try:
        lenient = client.patch("/api/settings",
                               json={"changes": {"ai": {"model": "gemini-3.0-flash"}}})
        assert lenient.status_code == 200, lenient.text
    finally:
        ai_models._CACHE = saved_cache
        client.patch("/api/settings", json={"changes": {"ai": {"model": pick}}})

    # 빈 값(서버 기본)은 허용
    assert client.patch("/api/settings", json={"changes": {"ai": {"model": ""}}}).status_code == 200
    assert client.get("/api/settings").json()["settings"]["ai"]["model"] == ""


def test_bulk_update_uses_one_batched_call():
    """일괄 수정이 건당 호출로 흩어지지 않아야 한다.

    낱개 update_event를 반복하면 Google에서는 건마다 get+patch(왕복 2회)다.
    78건 = 156회가 되어 라즈베리파이에서 1분을 넘겼고 nginx가 스트림을 끊어
    "요청 처리 중 오류"가 떴다. 그래서 서비스 계층의 update_many 한 번으로 모은다.
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend import calendar_service

    s = get_settings()
    u = SessionUser(username="batchcal", display_name="BC", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-26")
    reg = default_registry()

    reg.dispatch("bulk_create_calendar_events", {"events": [
        {"title": f"항목{i}", "start": f"2026-09-{i:02d}T10:00:00", "end": f"2026-09-{i:02d}T11:00:00"}
        for i in range(1, 13)
    ], "color": "자주"}, ctx)

    calls = {"single": 0, "many": 0, "sizes": []}
    real_single = calendar_service.update_event
    real_many = calendar_service.update_many

    def spy_single(*a, **k):
        calls["single"] += 1
        return real_single(*a, **k)

    def spy_many(user, settings, items):
        calls["many"] += 1
        calls["sizes"].append(len(items))
        return real_many(user, settings, items)

    calendar_service.update_event = spy_single
    calendar_service.update_many = spy_many
    try:
        r = reg.dispatch("bulk_update_calendar_events",
                         {"from_date": "2026-09-01", "to_date": "2026-09-30",
                          "color": "자주", "title_prefix": "묶음-"}, ctx)
    finally:
        calendar_service.update_event = real_single
        calendar_service.update_many = real_many

    assert r.ok and r.data["count"] == 12, r.data
    assert calls["many"] == 1, f"update_many가 한 번이어야 한다: {calls}"
    assert calls["sizes"] == [12], calls
    assert calls["single"] == 0, "낱개 update_event로 흩어지면 안 된다"

    names = {e["title"] for e in reg.dispatch("list_calendar_events",
             {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx).data["events"]}
    assert all(n.startswith("묶음-") for n in names), names

    # 조회 결과에 색 이름이 실려 온다(모델이 색을 잘못 짚었는지 알아채도록)
    ev = reg.dispatch("list_calendar_events",
                      {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx).data["events"][0]
    assert ev["color_name"] == "자주", ev


def test_calendar_bulk_create_delete_and_trash_restore():
    """일괄 생성 → 일괄 삭제 → 휴지통(일정) → 복원."""
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.trash import KIND_DOCUMENT, KIND_EVENT, counts_by_kind, list_trash

    s = get_settings()
    u = SessionUser(username="bulkcrud", display_name="BD", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-26")
    reg = default_registry()

    # 일괄 생성 — dry_run은 만들지 않는다
    payload = {"events": [
        {"title": "스탠드업 월", "start": "2026-09-07T09:00:00", "end": "2026-09-07T09:15:00"},
        {"title": "스탠드업 화", "start": "2026-09-08T09:00:00", "end": "2026-09-08T09:15:00"},
        {"title": "스탠드업 수", "start": "2026-09-09T09:00:00", "end": "2026-09-09T09:15:00"},
    ], "color": "하늘"}
    dry = reg.dispatch("bulk_create_calendar_events", {**payload, "dry_run": True}, ctx)
    assert dry.ok and dry.data["count"] == 3
    assert not reg.dispatch("list_calendar_events",
                            {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx).data["events"]

    made = reg.dispatch("bulk_create_calendar_events", payload, ctx)
    assert made.ok and made.data["count"] == 3, made.data
    assert all(e["color"] == "7" for e in made.data["created"])  # 하늘 = 7

    # 모르는 색은 하나라도 있으면 거절(일부만 만들어지면 더 곤란하다)
    bad = reg.dispatch("bulk_create_calendar_events",
                       {"events": [{"title": "x", "start": "2026-09-10T09:00:00", "color": "민트색"}]}, ctx)
    assert not bad.ok and bad.error_code == "invalid"

    # 일괄 삭제 — dry_run은 지우지 않는다
    dry_del = reg.dispatch("bulk_delete_calendar_events",
                           {"from_date": "2026-09-01", "to_date": "2026-09-30",
                            "title_contains": "스탠드업", "dry_run": True}, ctx)
    assert dry_del.ok and dry_del.data["count"] == 3
    assert len(reg.dispatch("list_calendar_events",
               {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx).data["events"]) == 3

    gone = reg.dispatch("bulk_delete_calendar_events",
                        {"from_date": "2026-09-01", "to_date": "2026-09-30",
                         "title_contains": "스탠드업"}, ctx)
    assert gone.ok and gone.data["count"] == 3, gone.data
    assert not reg.dispatch("list_calendar_events",
                            {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx).data["events"]

    # 휴지통의 '일정' 갈래에 들어가 있어야 한다
    ev_entries = list_trash(u, s, KIND_EVENT)
    assert len(ev_entries) == 3, ev_entries
    assert all(e["kind"] == KIND_EVENT for e in ev_entries)
    assert {e["name"] for e in ev_entries} == {"스탠드업 월", "스탠드업 화", "스탠드업 수"}
    assert all(e.get("event_start", "").startswith("2026-09") for e in ev_entries)
    c = counts_by_kind(u, s)
    assert c[KIND_EVENT] == 3 and c["all"] >= 3

    # 문서 갈래에는 안 섞인다
    assert all(e["kind"] == KIND_DOCUMENT for e in list_trash(u, s, KIND_DOCUMENT))

    # 복원 → 캘린더에 다시 생긴다
    from backend.trash import restore as trash_restore

    back = trash_restore(ev_entries[0]["id"], u, s)
    assert back["ok"] and back["kind"] == KIND_EVENT
    restored = reg.dispatch("list_calendar_events",
                            {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx).data["events"]
    assert len(restored) == 1
    assert restored[0]["title"] == ev_entries[0]["name"]
    assert restored[0]["color"] == "7"          # 색·시간이 보존된다
    assert restored[0]["start"].startswith("2026-09")
    # 복원한 항목은 휴지통에서 빠진다
    assert len(list_trash(u, s, KIND_EVENT)) == 2

    # 안전장치: 조건 없는 일괄 삭제는 거절
    assert not reg.dispatch("bulk_delete_calendar_events", {}, ctx).ok


def test_calendar_color_filter_guardrails():
    """모르는 색은 거절하고, 조건에 안 맞으면 왜 없는지 알려 준다.

    실제로 겪은 두 가지:
    - "이번 달 초록 일정" 이 0건이면 "없습니다"로 끝나 다음 수가 없었다.
      정작 그 일정들은 다음 달에 있었다.
    - resolve_color는 모르는 이름에 기본값을 준다. 그 값을 필터로 쓰면 색 조건이
      조용히 사라져, 일괄 수정이 기간 내 **전체 일정**을 대상으로 삼는다.
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="colorguard", display_name="CG", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-26")
    reg = default_registry()

    # 8월엔 연두(2), 9월엔 초록(10)
    reg.dispatch("create_calendar_event",
                 {"title": "팀 회의", "start": "2026-08-10T10:00:00", "end": "2026-08-10T11:00:00",
                  "color": "연두"}, ctx)
    for d in ("13", "14", "15"):
        reg.dispatch("create_calendar_event",
                     {"title": f"수정-테스트{d}", "start": f"2026-09-{d}T10:00:00",
                      "end": f"2026-09-{d}T11:00:00", "color": "초록"}, ctx)

    # 8월 초록 조회 → 0건이지만, 9월에 있다고 알려 줘야 한다
    r = reg.dispatch("list_calendar_events",
                     {"from_date": "2026-08-01", "to_date": "2026-08-31", "color": "초록"}, ctx)
    assert r.ok and not r.data["events"]
    hint = r.data.get("hint", {})
    assert hint.get("same_color_other_months", {}).get("2026-09") == 3, hint
    assert "2026-09" in r.message, r.message
    # 그 기간에 어떤 색이 있는지도 준다(초록↔연두 혼동을 풀 수 있게)
    assert any("연두" in k for k in hint.get("colors_in_window", {})), hint

    # 9월로 잡으면 제대로 나온다 + 접두어 제거도 동작
    r2 = reg.dispatch("list_calendar_events",
                      {"from_date": "2026-09-01", "to_date": "2026-09-30", "color": "초록"}, ctx)
    assert len(r2.data["events"]) == 3
    rm = reg.dispatch("bulk_update_calendar_events",
                      {"from_date": "2026-09-01", "to_date": "2026-09-30", "color": "초록",
                       "replace_from": "수정-", "replace_to": ""}, ctx)
    assert rm.ok and rm.data["count"] == 3, rm.data
    names = {e["title"] for e in reg.dispatch("list_calendar_events",
             {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx).data["events"]}
    assert not any(t.startswith("수정-") for t in names), names

    # 모르는 색은 거절한다 — 조용히 전체를 대상으로 삼으면 안 된다
    bad = reg.dispatch("list_calendar_events", {"color": "민트색"}, ctx)
    assert not bad.ok and bad.error_code == "invalid", bad
    bad2 = reg.dispatch("bulk_update_calendar_events",
                        {"from_date": "2026-08-01", "to_date": "2026-09-30",
                         "color": "민트색", "title_prefix": "X-"}, ctx)
    assert not bad2.ok and bad2.error_code == "invalid", bad2
    # 거절당했으니 아무것도 안 바뀌어야 한다
    untouched = {e["title"] for e in reg.dispatch("list_calendar_events",
                 {"from_date": "2026-08-01", "to_date": "2026-09-30"}, ctx).data["events"]}
    assert not any(t.startswith("X-") for t in untouched), untouched


def test_bulk_update_calendar_events():
    """여러 일정 한 번에 수정 — 조건으로 고르고, 반복은 시리즈로 한 번만.

    테스트 사용자는 Google 연동이 없으므로 내부 캘린더를 쓴다(실제 계정 데이터와 무관).
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.ai.skills.calendar import _base_id
    from backend.auth import SessionUser
    from backend.config import get_settings

    # 구글 인스턴스 id도 시리즈로 접힌다 — 이걸 놓치면 주간 반복 하나에
    # 제목 변경이 수십 번 걸려 '멋사-멋사-…'와 시리즈 예외가 생긴다.
    assert _base_id("abc123_20260305T100000Z") == "abc123"
    assert _base_id("abc123_20260305") == "abc123"
    assert _base_id("abc123@2026-03-05") == "abc123"
    assert _base_id("abc123") == "abc123"

    s = get_settings()
    u = SessionUser(username="bulkcal", display_name="BC", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-05-15")
    reg = default_registry()

    mk = lambda t, d, c, rec="none": reg.dispatch(  # noqa: E731
        "create_calendar_event",
        {"title": t, "start": f"{d}T10:00:00", "end": f"{d}T11:00:00", "color": c, "recurrence": rec},
        ctx,
    )
    mk("스터디", "2026-03-10", "보라")
    mk("해커톤", "2026-05-02", "보라")
    mk("치과", "2026-04-01", "빨강")          # 색이 달라 대상 아님
    mk("옛날모임", "2026-01-05", "보라")       # 기간 밖
    mk("정기모임", "2026-03-05", "보라", "weekly")  # 반복 → 인스턴스 여러 개

    # 조회가 색으로 걸러진다
    listed = reg.dispatch("list_calendar_events",
                          {"from_date": "2026-03-01", "to_date": "2026-08-31", "color": "보라"}, ctx)
    assert listed.ok
    titles = {e["title"] for e in listed.data["events"]}
    assert titles == {"스터디", "해커톤", "정기모임"}, titles
    assert len(listed.data["events"]) > 3  # 반복이 인스턴스로 펼쳐진다

    # dry_run은 바꾸지 않는다
    dry = reg.dispatch("bulk_update_calendar_events",
                       {"from_date": "2026-03-01", "to_date": "2026-08-31",
                        "color": "보라", "title_prefix": "멋사-", "dry_run": True}, ctx)
    assert dry.ok and dry.data["count"] == 3, dry.data
    assert dry.data["recurring"] == 1
    still = {e["title"] for e in reg.dispatch("list_calendar_events",
             {"from_date": "2026-03-01", "to_date": "2026-08-31"}, ctx).data["events"]}
    assert "멋사-스터디" not in still

    # 적용: 반복은 시리즈 하나로 세어 3건
    hit = reg.dispatch("bulk_update_calendar_events",
                       {"from_date": "2026-03-01", "to_date": "2026-08-31",
                        "color": "보라", "title_prefix": "멋사-"}, ctx)
    assert hit.ok and hit.data["count"] == 3, hit.data

    after = reg.dispatch("list_calendar_events", {"from_date": "2026-01-01", "to_date": "2026-12-31"}, ctx)
    names = {e["title"] for e in after.data["events"]}
    assert {"멋사-스터디", "멋사-해커톤", "멋사-정기모임"} <= names
    assert "치과" in names and "옛날모임" in names        # 조건 밖은 그대로
    assert not any(t.startswith("멋사-멋사-") for t in names)  # 반복에 중복 부착 없음

    # 같은 지시를 다시 받아도 두 번 붙지 않는다
    again = reg.dispatch("bulk_update_calendar_events",
                         {"from_date": "2026-03-01", "to_date": "2026-08-31",
                          "color": "보라", "title_prefix": "멋사-"}, ctx)
    assert again.ok and again.data["count"] == 0, again.data

    # 색 변경 + 제목 치환
    reg.dispatch("bulk_update_calendar_events",
                 {"from_date": "2026-03-01", "to_date": "2026-08-31",
                  "title_contains": "멋사", "replace_from": "멋사-", "replace_to": "LIKELION_",
                  "set_color": "초록"}, ctx)
    fin = reg.dispatch("list_calendar_events", {"from_date": "2026-03-01", "to_date": "2026-08-31"}, ctx)
    changed = [e for e in fin.data["events"] if e["title"].startswith("LIKELION_")]
    assert changed and all(e["color"] == "10" for e in changed)

    # 안전장치: 무엇을 바꿀지 없거나 대상이 너무 넓으면 거절
    assert not reg.dispatch("bulk_update_calendar_events", {"color": "보라"}, ctx).ok
    assert not reg.dispatch("bulk_update_calendar_events", {"title_prefix": "x"}, ctx).ok


def test_ai_skill_catalog_and_ops():
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    reg = default_registry()
    catalog = reg.build_catalog()
    # 문서·캘린더·시스템 스킬이 모두 등록됐는지
    assert len(catalog) >= 16, len(catalog)
    names = {c["name"] for c in catalog}
    for expected in ("list_documents", "read_document", "write_document", "append_document",
                     "delete_document", "rename_document", "move_document", "search_documents",
                     "create_folder", "document_backlinks", "update_calendar_event",
                     "delete_calendar_event", "find_free_slots", "get_system_status"):
        assert expected in names, expected
    # 파일/노트로 나뉘던 옛 스킬은 남아 있으면 안 된다(모델이 헷갈린다)
    for gone in ("list_files", "read_file", "list_notes", "read_note", "delete_path"):
        assert gone not in names, gone
    # 모든 스킬에서 scope 인자가 사라졌다
    for c in catalog:
        assert "scope" not in (c.get("parameters", {}).get("properties") or {}), c["name"]

    ctx = SkillContext(
        user=SessionUser(username="tester", display_name="T", expires_at=0, remaining=0),
        settings=s,
    )
    # append_document → read_document 반영
    reg.dispatch("write_document", {"path": "log", "content": "# log\n"}, ctx)
    reg.dispatch("append_document", {"path": "log", "content": "라인2"}, ctx)
    r = reg.dispatch("read_document", {"path": "log"}, ctx)
    assert "라인2" in r.data["content"]
    # delete_document
    assert reg.dispatch("delete_document", {"path": "log"}, ctx).ok
    # find_free_slots (일정 없으면 근무시간 전체가 빈 시간)
    # **미래 날짜로 물어야 한다.** 오늘 날짜를 박아 두면, 지난 시간대는 제안하지
    # 않는 규칙 때문에 그날 오후에 돌릴 때 0건이 되어 시계에 따라 깨진다.
    from datetime import date as _date
    from datetime import timedelta as _td

    future = (_date.today() + _td(days=30)).isoformat()
    fr = reg.dispatch("find_free_slots", {"date": future, "duration_minutes": 60}, ctx)
    assert fr.ok and len(fr.data["free_slots"]) >= 1, (future, fr.data)
    # get_system_status — 주인 전용이라 일반 컨텍스트에서는 거절된다
    assert reg.dispatch("get_system_status", {}, ctx).error_code == "forbidden"
    owner_ctx = SkillContext(
        user=SessionUser(username="tester", display_name="T", expires_at=0, remaining=0,
                         role="admin", origin="bootstrap"),
        settings=s,
    )
    st = reg.dispatch("get_system_status", {}, owner_ctx)
    assert st.ok and "cpu_percent" in st.data
    # 캘린더 update/delete 스킬
    ev = reg.dispatch("create_calendar_event", {"title": "회의", "start": "2026-09-02T10:00:00"}, ctx)
    eid = ev.data["event"]["id"]
    up = reg.dispatch("update_calendar_event", {"event_id": eid, "title": "수정회의"}, ctx)
    assert up.ok and up.data["event"]["title"] == "수정회의"
    assert reg.dispatch("delete_calendar_event", {"event_id": eid}, ctx).ok


def test_ai_blocks_sensitive_files():
    from backend.ai.skill_base import SkillContext
    from backend.ai.skills import ReadDocument
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    ctx = SkillContext(
        user=SessionUser(username="tester", display_name="T", expires_at=0, remaining=0),
        settings=s,
    )
    for path in ("password.txt", "내 비밀번호", "계좌/메모", "secret.md"):
        r = ReadDocument().run({"path": path}, ctx)
        assert r.ok is False and r.error_code == "blocked", path
    # .env·키 파일은 AI가 읽지 못한다.
    # 예전에는 이 단언이 gemini_client.TEXT_EXTENSIONS를 봤는데, 그 모듈은
    # 아무도 쓰지 않는 죽은 코드라 '가짜 보증'이었다. 실제 게이트를 확인한다.
    from backend.file_kinds import is_editable

    assert is_editable(".env"), "UI 편집은 되어야 한다(텍스트로 분류)"
    for name in (".env", "prod.env", "server.key", "cert.pem"):
        r = ReadDocument().run({"path": name}, ctx)
        assert r.ok is False and r.error_code == "blocked", name


def test_raw_serve_blocks_stored_xss():
    """업로드한 파일을 인라인 제공할 때 스크립트가 실행되면 안 된다.

    SVG는 <img>로 볼 땐 안전하지만 문서로 직접 열면(새 탭·URL 직접 접근)
    내부 <script>가 앱과 같은 오리진에서 실행된다. 세션 쿠키가 httpOnly라
    값은 못 읽어도 인증된 API를 대신 호출할 수 있어 문서 전체가 노출된다.
    """
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    evil = b'<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/notes/tree")</script></svg>'
    r = c.post("/api/notes/upload?path=",
               files={"file": ("evil.svg", io.BytesIO(evil), "image/svg+xml")})
    assert r.status_code == 200, r.text

    raw = c.get("/api/notes/raw?path=evil.svg")
    assert raw.status_code == 200
    # 브라우저가 문서로 열어도 스크립트가 돌지 않도록 샌드박스 처리
    assert "sandbox" in raw.headers.get("content-security-policy", ""), raw.headers
    # MIME 스니핑으로 다른 타입으로 재해석되는 것도 차단
    assert raw.headers.get("x-content-type-options") == "nosniff", raw.headers

    # 이미지·PDF 등 나머지 인라인 응답에도 nosniff가 붙는다
    c.post("/api/notes/upload?path=",
           files={"file": ("ok.png", io.BytesIO(b"png-bytes"), "image/png")})
    png = c.get("/api/notes/raw?path=ok.png")
    assert png.headers["content-type"] == "image/png"
    assert png.headers.get("x-content-type-options") == "nosniff"


def test_password_hashing():
    """평문 비밀번호가 저장되지 않는다."""
    from backend import accounts
    from backend.config import get_settings

    h = accounts.hash_password("correct horse battery")
    assert "correct horse battery" not in h
    assert h.startswith("pbkdf2_sha256$")
    assert accounts.verify_password("correct horse battery", h)
    assert not accounts.verify_password("wrong", h)
    assert not accounts.verify_password("x", "깨진값")  # 형식 오류는 조용히 False

    # 같은 비밀번호라도 salt가 달라 해시가 다르다
    assert accounts.hash_password("same") != accounts.hash_password("same")

    # 저장소 파일에 평문이 없다.
    # 계정 파일은 **여기서 직접 만들어 둔다** — 앞선 테스트가 먼저 로그인해 준
    # 덕에만 통과하면, 이 테스트 하나만 돌렸을 때는 아무것도 검사하지 못한다.
    s = get_settings()
    accounts.ensure_seed(s)
    p = s.storage_root / "accounts.json"
    assert p.exists(), "계정 파일이 없다 — 아무것도 검사하지 못한다"
    raw = p.read_text(encoding="utf-8")
    assert "pw123" not in raw and "pw456" not in raw


def test_signup_requires_admin_approval():
    """가입 신청 → 승인 전 로그인 불가 → 승인 후 로그인 가능."""
    from backend import accounts
    from backend.config import get_settings

    s = get_settings()
    guest = TestClient(app)

    # 신청
    r = guest.post("/api/auth/signup",
                   json={"username": "newbie", "password": "longenough1", "display_name": "뉴비"})
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "pending"

    # 승인 전에는 로그인 불가 — 비밀번호가 맞아도 403이고 이유를 알려준다
    bad = guest.post("/api/auth/login", json={"username": "newbie", "password": "longenough1"})
    assert bad.status_code == 403 and "승인" in bad.json()["detail"]

    # 아이디 규칙·비밀번호 길이·중복
    assert guest.post("/api/auth/signup",
                      json={"username": "AB", "password": "longenough1"}).status_code == 400
    assert guest.post("/api/auth/signup",
                      json={"username": "shortpw", "password": "1234"}).status_code == 400
    assert guest.post("/api/auth/signup",
                      json={"username": "newbie", "password": "longenough1"}).status_code == 409

    # 관리자 대기열에 보인다
    admin = TestClient(app)
    admin.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    pend = admin.get("/api/admin/users").json()
    assert any(u["username"] == "newbie" for u in pend["pending"])

    # 비관리자는 접근 불가
    accounts.set_status("newbie", accounts.STATUS_ACTIVE, "tester", s)
    member = TestClient(app)
    member.post("/api/auth/login", json={"username": "newbie", "password": "longenough1"})
    assert member.get("/api/admin/users").status_code == 403

    # 승인 후 로그인 성공 + 역할 전달
    ok = guest.post("/api/auth/login", json={"username": "newbie", "password": "longenough1"})
    assert ok.status_code == 200 and ok.json()["role"] == "user"

    # 비활성화하면 기존 세션도 즉시 무효
    assert admin.post("/api/admin/users/newbie/disable").status_code == 200
    assert member.get("/api/notes/tree").status_code == 401
    assert guest.post("/api/auth/login",
                      json={"username": "newbie", "password": "longenough1"}).status_code == 403


def test_last_admin_cannot_lock_out():
    """마지막 관리자를 비활성화·강등·삭제하면 아무도 승인할 수 없게 된다."""
    from backend import accounts
    from backend.config import get_settings

    s = get_settings()
    admins = [u for u in accounts.list_all(s) if u.get("role") == "admin" and u.get("status") == "active"]
    # 테스트 환경엔 .env 이관 계정 2개가 admin이므로, 하나만 남기고 확인
    for extra in admins[1:]:
        accounts.set_status(extra["username"], accounts.STATUS_DISABLED, "test", s)

    last = admins[0]["username"]
    for fn, kwargs in (
        (accounts.set_status, {"status": accounts.STATUS_DISABLED, "actor": "test"}),
        (accounts.set_role, {"role": "user"}),
    ):
        try:
            fn(last, settings=s, **kwargs)
            raise AssertionError("마지막 관리자 변경이 허용됨")
        except Exception as e:
            assert getattr(e, "status_code", None) == 400, e
    try:
        accounts.delete(last, s)
        raise AssertionError("마지막 관리자 삭제가 허용됨")
    except Exception as e:
        assert getattr(e, "status_code", None) == 400, e

    # 원복
    for extra in admins[1:]:
        accounts.set_status(extra["username"], accounts.STATUS_ACTIVE, "test", s)


def test_google_oauth_state_and_isolation():
    """OAuth state가 위조·타계정 주입을 막는다."""
    from backend import google_oauth
    from backend.config import get_settings

    st = get_settings()

    # 서버에 클라이언트가 없으면 연동을 시작할 수 없다(조용히 실패하지 않음)
    assert not google_oauth.is_configured(st)
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    assert c.get("/api/google/auth-url").status_code == 503

    # state 서명·검증
    token = google_oauth.make_state("tester", st)
    assert google_oauth.verify_state(token, st) == "tester"
    try:
        google_oauth.verify_state(token + "x", st)
        raise AssertionError("위조된 state가 통과됨")
    except Exception as e:
        assert getattr(e, "status_code", None) == 400

    # 다른 사용자의 state로 콜백하면 거절 (남의 계정에 내 구글을 붙일 수 없다).
    # 거절은 하되 **원시 JSON 페이지에 남기지 않는다** — 콜백은 브라우저 주소창이
    # 오는 곳이라, 여기서 예외를 올리면 사용자가 앱으로 돌아갈 길이 없다.
    other = google_oauth.make_state("tester2", st)
    r = c.get(f"/api/google/callback?code=abc&state={other}", follow_redirects=False)
    assert r.status_code == 303, r.text
    assert r.headers["location"] == "/settings?google=other_account", r.headers

    # 모든 실패 경로가 화면으로 돌아간다(JSON 이 아니라)
    for url, reason in (
        ("/api/google/callback?error=access_denied", "denied"),
        ("/api/google/callback", "bad_request"),
        ("/api/google/callback?code=abc&state=위조", "bad_state"),
    ):
        r = c.get(url, follow_redirects=False)
        assert r.status_code == 303, (url, r.text)
        assert r.headers["location"] == f"/settings?google={reason}", (url, r.headers)

    # 로그인하지 않은 채 돌아와도 마찬가지다(동의 화면에 있는 동안 세션이 만료된 경우)
    anon = TestClient(app)
    r = anon.get(f"/api/google/callback?code=abc&state={token}", follow_redirects=False)
    assert r.status_code == 303, r.text
    assert r.headers["location"] == "/settings?google=session", r.headers

    # 연동 상태: 미연동
    s0 = c.get("/api/google/status").json()
    assert s0["connected"] is False and s0["server_ready"] is False

    # 저장/해제 왕복 — 저장되면 google_config가 저장소를 먼저 본다
    google_oauth.save_tokens("tester", {"refresh_token": "rt", "calendar_id": "primary"}, st)
    assert c.get("/api/google/status").json()["connected"] is True
    google_oauth.disconnect("tester", st)
    assert c.get("/api/google/status").json()["connected"] is False


def test_folder_archive_download():
    """폴더를 zip으로 내려받는다 — 로컬 연동을 대신하는 경로."""
    import zipfile as _zip

    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester2", "password": "pw456"})
    c.post("/api/notes/folder", json={"path": "묶음"})
    c.post("/api/notes/folder", json={"path": "묶음/안쪽"})
    c.put("/api/notes/save", json={"path": "묶음/문서.md", "content": "# 문서"})
    c.put("/api/notes/save", json={"path": "묶음/안쪽/깊은글.md", "content": "깊은 내용"})
    c.post("/api/notes/upload?path=묶음",
           files={"file": ("그림.png", io.BytesIO(b"img"), "image/png")})

    r = c.get("/api/notes/archive?path=묶음")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    # 한글 폴더명이 깨지지 않도록 RFC 5987 인코딩이 붙어야 한다
    assert "filename*=utf-8''" in r.headers["content-disposition"].lower(), r.headers

    names = _zip.ZipFile(io.BytesIO(r.content)).namelist()
    assert "문서.md" in names, names
    assert "안쪽/깊은글.md" in names, names   # 하위 구조 유지
    assert "그림.png" in names, names

    # path 생략 → 문서 공간 전체
    whole = c.get("/api/notes/archive")
    assert whole.status_code == 200
    assert "묶음/문서.md" in _zip.ZipFile(io.BytesIO(whole.content)).namelist()

    # 폴더가 아니면 404 (파일은 /raw 를 쓴다)
    assert c.get("/api/notes/archive?path=묶음/문서.md").status_code == 404
    assert c.get("/api/notes/archive?path=없는폴더").status_code == 404


def test_origin_backfill():
    """origin 없던 기존 행에 origin이 채워진다.

    회귀: ensure_seed가 accounts.json이 있으면 early-return하므로, 백필이 없으면
    실제 배포된 주인이 signup으로 읽혀 주인 전용 게이트를 켜는 순간 본인이 잠긴다.
    """
    import json as _json
    from backend import accounts
    from backend.config import get_settings

    st = get_settings()
    p = st.storage_root / "accounts.json"
    rows = _json.loads(p.read_text(encoding="utf-8"))
    # origin을 지워 '구버전 파일' 상태를 만든다
    for r in rows:
        r.pop("origin", None)
    p.write_text(_json.dumps(rows, ensure_ascii=False), encoding="utf-8")

    accounts.ensure_seed(st)  # 백필이 돌아야 한다

    after = {r["username"]: r.get("origin") for r in _json.loads(p.read_text(encoding="utf-8"))}
    assert after.get("tester") == accounts.ORIGIN_BOOTSTRAP, after
    assert after.get("tester2") == accounts.ORIGIN_BOOTSTRAP, after
    # 가입 계정은 bootstrap으로 오인되면 안 된다
    if "newbie" in after:
        assert after["newbie"] == accounts.ORIGIN_SIGNUP, after


def test_owner_only_surfaces():
    """가입 사용자는 관리 화면·시스템 상태·Google 연동에 접근할 수 없다.

    클라이언트에서 숨기는 것만으로는 curl로 뚫리므로 서버가 거절해야 한다.
    """
    from backend import accounts
    from backend.config import get_settings

    st = get_settings()
    guest = TestClient(app)
    guest.post("/api/auth/signup",
               json={"username": "member1", "password": "longenough1", "display_name": "멤버"})
    accounts.set_status("member1", accounts.STATUS_ACTIVE, "tester", st)

    m = TestClient(app)
    assert m.post("/api/auth/login",
                  json={"username": "member1", "password": "longenough1"}).status_code == 200
    assert m.get("/api/auth/session").json()["origin"] == "signup"

    # 주인 전용 표면은 전부 403
    for path in ("/api/system", "/api/admin/users", "/api/google/auth-url"):
        assert m.get(path).status_code == 403, path

    # 그런데 자기 기능은 정상 — 문서·캘린더는 그대로 쓴다
    assert m.get("/api/notes/tree").status_code == 200
    assert m.post("/api/calendar/events",
                  json={"title": "내 일정", "start": "2026-10-01T10:00:00"}).status_code == 200
    assert m.get("/api/calendar/events").status_code == 200
    # Google 상태 조회는 열려 있되 연동은 불가로 표시된다
    gs = m.get("/api/google/status").json()
    assert gs["owner_only"] is True and gs["server_ready"] is False

    # 주인은 접근된다
    owner = TestClient(app)
    owner.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    assert owner.get("/api/auth/session").json()["origin"] == "bootstrap"
    assert owner.get("/api/system").status_code == 200
    assert owner.get("/api/admin/users").status_code == 200

    # role만 admin으로 올려도 주인은 아니다(.env 출신이 아니므로)
    accounts.set_role("member1", "admin", st)
    assert m.get("/api/system").status_code == 403, "role=admin만으로는 주인이 아니어야 함"
    accounts.set_role("member1", "user", st)


def test_settings_prunes_dead_keys():
    """기능이 사라진 설정 키는 저장 시 정리된다(로컬 연동 잔재)."""
    from backend import user_settings
    from backend.auth import SessionUser
    from backend.config import get_settings

    st = get_settings()
    u = SessionUser(username="prune", display_name="P", expires_at=0, remaining=0)
    p = st.user_root("prune") / "settings.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('{"sync": {"text_conflict": "ask"}, "notes": {"autosave_ms": 500}}', encoding="utf-8")

    loaded = user_settings.load(u, st)
    assert "sync" not in loaded, loaded.keys()
    assert loaded["notes"]["autosave_ms"] == 500  # 살아있는 설정은 보존

    user_settings.patch(u, st, {"notes": {"autosave_ms": 700}})
    import json as _json
    assert "sync" not in _json.loads(p.read_text(encoding="utf-8"))


def test_owner_cannot_lock_themselves_out():
    """주인이 자기를 지우거나 비활성화·강등해 관리 권한을 영영 잃을 수 없어야 한다.

    회귀: 잠금 방지 가드가 _admin_count(role=admin)만 세어, 가입 사용자를 admin으로
    올리면 admin이 2명이 되어 주인 자신에 대한 삭제·비활성·강등이 전부 통과했다.
    그 상태가 되면 require_owner(origin=bootstrap AND role=admin)를 만족하는 계정이
    하나도 없어 아무도 관리 화면에 못 들어가고, ensure_seed는 파일이 있으면
    early-return하므로 재기동해도 복구되지 않는다.
    """
    from backend import accounts
    from backend.config import get_settings

    st = get_settings()
    # 가입 사용자를 admin으로 승격 → admin 수는 늘지만 주인은 여전히 1명
    guest = TestClient(app)
    guest.post("/api/auth/signup",
               json={"username": "coadmin", "password": "longenough1", "display_name": "코어드민"})
    accounts.set_status("coadmin", accounts.STATUS_ACTIVE, "tester", st)
    accounts.set_role("coadmin", "admin", st)
    assert accounts.find("coadmin", st).is_admin is True
    assert accounts.find("coadmin", st).is_owner is False  # 승격돼도 주인은 아니다

    # 테스트 환경엔 .env 출신 주인이 둘(tester·tester2)이므로 하나만 남긴다
    others = [
        u["username"] for u in accounts.list_all(st)
        if u.get("origin") == accounts.ORIGIN_BOOTSTRAP
        and u.get("role") == "admin" and u.get("status") == accounts.STATUS_ACTIVE
        and u["username"] != "tester"
    ]
    for u in others:
        accounts.set_status(u, accounts.STATUS_DISABLED, "test", st)

    owner = "tester"
    for fn, kwargs in (
        (accounts.set_status, {"status": accounts.STATUS_DISABLED, "actor": "x"}),
        (accounts.set_role, {"role": "user"}),
    ):
        try:
            fn(owner, settings=st, **kwargs)
            raise AssertionError(f"마지막 주인에 대한 {fn.__name__}가 허용됨")
        except Exception as e:
            assert getattr(e, "status_code", None) == 400, e
    try:
        accounts.delete(owner, st)
        raise AssertionError("마지막 주인 삭제가 허용됨")
    except Exception as e:
        assert getattr(e, "status_code", None) == 400, e

    # 주인은 여전히 관리 화면에 들어갈 수 있다
    o = TestClient(app)
    o.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    assert o.get("/api/admin/users").status_code == 200

    # 자기 계정을 대상으로 한 조작은 라우터에서도 막힌다
    assert o.post("/api/admin/users/tester/disable").status_code == 400
    assert o.delete("/api/admin/users/tester").status_code == 400

    accounts.set_role("coadmin", "user", st)
    for u in others:  # 원복
        accounts.set_status(u, accounts.STATUS_ACTIVE, "test", st)


def test_system_stats_not_leaked_via_ai_skill():
    """/api/system을 막아도 AI 스킬로 같은 값이 새면 의미가 없다."""
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    st = get_settings()
    reg = default_registry()

    member = SkillContext(
        user=SessionUser(username="m", display_name="M", expires_at=0, remaining=0,
                         role="user", origin="signup"),
        settings=st,
    )
    r = reg.dispatch("get_system_status", {}, member)
    assert r.ok is False and r.error_code == "forbidden", r

    owner = SkillContext(
        user=SessionUser(username="tester", display_name="T", expires_at=0, remaining=0,
                         role="admin", origin="bootstrap"),
        settings=st,
    )
    assert reg.dispatch("get_system_status", {}, owner).ok is True


def test_archive_survives_bad_files():
    """압축 불가 파일 하나가 전체 내보내기를 실패시키거나 임시파일을 흘리면 안 된다."""
    import os, time as _t
    from backend.config import get_settings

    st = get_settings()
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester2", "password": "pw456"})
    c.post("/api/notes/folder", json={"path": "오래된"})
    c.put("/api/notes/save", json={"path": "오래된/정상.md", "content": "ok"})

    # 1980년 이전 mtime → zipfile이 ValueError를 낸다(OSError가 아님)
    root = st.user_root("tester2") / "data" / "오래된"
    old = root / "옛날파일.txt"
    old.write_text("old", encoding="utf-8")
    os.utime(old, (0, 0))

    tmp_dir = st.storage_root / ".tmp"
    before = len(list(tmp_dir.glob("*.zip"))) if tmp_dir.exists() else 0

    r = c.get("/api/notes/archive?path=오래된")
    assert r.status_code == 200, r.text          # 한 파일 때문에 전체가 죽지 않는다
    import zipfile as _z, io as _io
    names = _z.ZipFile(_io.BytesIO(r.content)).namelist()
    assert "정상.md" in names                     # 나머지는 정상 포함
    # 이어받기를 제안하면 서로 다른 zip이 이어 붙어 조용히 깨진다
    assert r.headers.get("accept-ranges") == "none", r.headers

    _t.sleep(0.2)  # BackgroundTask가 정리할 틈
    after = len(list(tmp_dir.glob("*.zip"))) if tmp_dir.exists() else 0
    assert after <= before, f"임시 zip이 남았다: {before} -> {after}"


def test_user_isolation():
    """다른 사용자의 문서는 보이지도, 읽히지도 않는다."""
    a = TestClient(app)
    a.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    r = a.post(
        "/api/notes/upload?path=",
        files={"file": ("secret.txt", io.BytesIO(b"mine"), "text/plain")},
    )
    assert r.status_code == 200, r.text
    assert "secret.txt" in [n["path"] for n in a.get("/api/notes/tree").json()["notes"]]

    b = TestClient(app)
    b.post("/api/auth/login", json={"username": "tester2", "password": "pw456"})
    assert "secret.txt" not in [n["path"] for n in b.get("/api/notes/tree").json()["notes"]]
    # 경로를 알아도 읽을 수 없다(각자의 루트로만 해석되므로)
    assert b.get("/api/notes/raw?path=secret.txt").status_code == 404
def test_ai_result_contract():
    """스킬 결과가 모델에게 '판단할 수 있는 형태'로 전달되는지.

    실패 분류·잘림 표시·수정시각이 없으면 모델은 문장에서 추측하거나
    "이게 전부"라고 단정해 버린다. 여기서 막는다.
    """
    from backend.ai import orchestrator
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.ai.skills.documents import SearchDocuments
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root

    s = get_settings()
    u = SessionUser(username="contract", display_name="C", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-08-28")
    reg = default_registry()
    root = user_data_root(u, s)
    root.mkdir(parents=True, exist_ok=True)

    # 1) 실패 분류가 모델에게 전달된다 (예전엔 message만 갔다)
    class _FakeLLM:
        def __init__(self):
            self.seen = []
            self.n = 0

        def chat(self, contents, catalog, system):
            self.seen = contents
            self.n += 1
            if self.n == 1:
                return orchestrator.LLMResult(
                    text="", tool_uses=[{"name": "read_document", "args": {"path": "없는문서"}}]
                )
            return orchestrator.LLMResult(text="알겠습니다.")

    fake = _FakeLLM()
    list(orchestrator.run(u, s, "없는문서 읽어줘", "2026-08-28", llm=fake, registry=reg))
    responses = [
        part["function_response"]["response"]
        for turn in fake.seen
        for part in turn.get("parts", [])
        if "function_response" in part
    ]
    assert responses, fake.seen
    assert responses[0]["ok"] is False
    assert responses[0]["error_code"] == "not_found", responses[0]

    # 2) 모델이 빈 텍스트로 끝내도 빈 말풍선이 아니다
    class _Silent:
        def chat(self, contents, catalog, system):
            return orchestrator.LLMResult(text="   ")

    texts = [e["text"] for e in orchestrator.run(u, s, "안녕", "2026-08-28", llm=_Silent(), registry=reg)
             if e["type"] == "text"]
    assert texts and texts[0].strip(), texts

    # 3) HTTPException 이 "internal" 로 뭉개지지 않는다
    from fastapi import HTTPException

    from backend.ai.skill_base import SkillBase

    class _Boom(SkillBase):
        name = "boom"
        description = "x"
        parameters = {"type": "object", "properties": {}}

        def run(self, args, ctx):
            raise HTTPException(status_code=409, detail="이미 있습니다.")

    reg.register(_Boom())
    r = reg.dispatch("boom", {}, ctx)
    assert r.ok is False and r.error_code == "conflict" and r.message == "이미 있습니다.", r

    # 4) 검색: 30건에서 끊기면 그렇다고 말한다
    for i in range(SearchDocuments._LIMIT + 5):
        (root / f"찾기{i}.md").write_text("본문", encoding="utf-8")
    res = reg.dispatch("search_documents", {"query": "찾기"}, ctx)
    assert res.data["truncated"] is True and "상한" in res.message, res.message

    # 5) 검색이 민감 문서의 '본문'을 오라클로 흘리지 않는다
    (root / ".env").write_text("SECRET_TOKEN=abcdef", encoding="utf-8")
    leak = reg.dispatch("search_documents", {"query": "abcdef"}, ctx)
    assert not [m for m in leak.data["matches"] if ".env" in m["path"]], leak.data

    # 6) 문서 목록에 수정시각이 있다 ("최근 문서" 같은 요청의 전제)
    docs = reg.dispatch("list_documents", {}, ctx).data["documents"]
    assert docs and all("modified" in d for d in docs), docs[:3]

    # 7) 백링크: 없는 문서와 백링크 0건을 구분한다
    miss = reg.dispatch("document_backlinks", {"path": "이런거없음"}, ctx)
    assert miss.ok is False and miss.error_code == "not_found", miss
    (root / "대상.md").write_text("x", encoding="utf-8")
    hit = reg.dispatch("document_backlinks", {"path": "대상"}, ctx)
    assert hit.ok and hit.data["backlinks"] == [], hit.data


def test_bulk_calendar_skills_agree():
    """일괄 수정·삭제가 '대상 고르기'에서 같은 규칙을 쓰는지.

    두 스킬이 같은 골격을 복붙하고 있었고 그 사이에서 이미 두 번 어긋났다
    (색 해석이 한쪽만 엄격했고, id 정규화가 한쪽만 돼 있었다).
    골격을 하나로 모았으니, 다시 갈라지면 여기서 걸린다.
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="bulkparity", display_name="B", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=s, today="2026-09-01")
    reg = default_registry()

    reg.dispatch("bulk_create_calendar_events", {"events": [
        {"title": "회의 A", "start": "2026-09-10T10:00:00", "color": "2"},
        {"title": "회의 B", "start": "2026-09-11T10:00:00", "color": "2"},
    ]}, ctx)

    common = {"from_date": "2026-09-01", "to_date": "2026-09-30"}
    pairs = [
        ("bulk_update_calendar_events", {"title_prefix": "[x] "}),
        ("bulk_delete_calendar_events", {}),
    ]

    for name, extra in pairs:
        # 1) 조건 없이 부르면 둘 다 거절한다 (전체를 건드리지 않는다)
        r = reg.dispatch(name, dict(extra), ctx)
        assert r.ok is False and r.error_code == "invalid", (name, r)

        # 2) 모르는 색은 둘 다 오류다. 조용히 무시하면 색 조건이 사라져
        #    기간 내 전체가 대상이 된다 — 예전에 한쪽만 엄격했다.
        #    ('형광연두'처럼 아는 색 이름을 품은 말은 부분 매칭으로 통과한다)
        r = reg.dispatch(name, {**common, **extra, "color": "무지개색"}, ctx)
        assert r.ok is False and r.error_code == "invalid", (name, r)

        # 3) 없는 id를 주면 둘 다 not_found + missing 목록
        r = reg.dispatch(name, {**common, **extra, "event_ids": ["없는id"]}, ctx)
        assert r.ok is False and r.error_code == "not_found", (name, r)
        assert r.data["missing"] == ["없는id"], (name, r.data)

        # 4) 조건에 맞는 게 없으면 둘 다 ok=True + 왜 없는지 힌트
        r = reg.dispatch(name, {"from_date": "2027-01-01", "to_date": "2027-01-31",
                                "color": "5", **extra}, ctx)
        assert r.ok is True and r.data["count"] == 0, (name, r)

        # 5) dry_run 은 아무것도 바꾸지 않는다
        r = reg.dispatch(name, {**common, **extra, "dry_run": True}, ctx)
        assert r.ok and r.data["dry_run"] is True and r.data["count"] == 2, (name, r.data)

    # dry_run 뒤에도 원본이 그대로다
    listed = reg.dispatch("list_calendar_events", common, ctx)
    assert [e["title"] for e in listed.data["events"]] == ["회의 A", "회의 B"], listed.data

    # 실제 수정 → 삭제까지 흐름이 이어진다
    up = reg.dispatch("bulk_update_calendar_events", {**common, "title_prefix": "[x] "}, ctx)
    assert up.ok and up.data["count"] == 2, up
    # 같은 지시를 두 번 받아도 접두어가 겹치지 않는다
    again = reg.dispatch("bulk_update_calendar_events", {**common, "title_prefix": "[x] "}, ctx)
    assert again.ok and again.data["count"] == 0 and again.data["checked"] == 2, again.data

    dele = reg.dispatch("bulk_delete_calendar_events", common, ctx)
    assert dele.ok and dele.data["count"] == 2, dele
    assert reg.dispatch("list_calendar_events", common, ctx).data["events"] == []


def test_auth_reads_accounts_once_per_request():
    """인증된 요청 하나가 accounts.json을 몇 번 읽는가.

    verify_token과 require_session이 각각 조회해 요청마다 두 번 읽고 두 번
    파싱했다. 게다가 두 번째 조회는 None 검사가 없어, 그 사이에 계정이 지워지면
    401이 아니라 500이 났다.
    """
    from backend import accounts as accounts_mod

    _login()
    calls = []
    real = accounts_mod.find

    def counting(username, settings):
        calls.append(username)
        return real(username, settings)

    accounts_mod.find = counting
    try:
        r = client.get("/api/notes/list")
        assert r.status_code == 200, r.text
    finally:
        accounts_mod.find = real
    assert len(calls) == 1, calls


def test_session_survives_account_disappearing_mid_request():
    """조회와 조회 사이에 계정이 사라져도 500이 나지 않는다.

    두 번 조회하던 시절에는 첫 조회는 성공하고 둘째가 None이 되는 창이 있었고,
    거기에 None 검사가 없어 AttributeError → 500이 났다. 조회가 한 번이면
    그 창 자체가 없다.
    """
    from backend import accounts as accounts_mod

    _login()
    real = accounts_mod.find
    seen = []

    def vanishing(username, settings):
        seen.append(username)
        return real(username, settings) if len(seen) == 1 else None

    accounts_mod.find = vanishing
    try:
        r = client.get("/api/notes/list")
    finally:
        accounts_mod.find = real
    assert r.status_code == 200, (r.status_code, len(seen))

    # 계정이 정말 없어졌다면 401이지 500이 아니다
    accounts_mod.find = lambda username, settings: None
    try:
        assert client.get("/api/notes/list").status_code == 401
    finally:
        accounts_mod.find = real
    assert client.get("/api/notes/list").status_code == 200


def test_find_free_slots_over_a_range():
    """빈 시간 찾기가 기간을 한 번에 본다.

    하루씩만 볼 수 있으면 "이번 주에 두 시간 빈 때" 한 마디에 7번을 불러야 하고,
    모델은 대개 중간에 그만두거나 max_steps를 다 쓴다.
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    st = get_settings()
    u = SessionUser(username="freeslots", display_name="F", expires_at=0, remaining=0)
    ctx = SkillContext(user=u, settings=st, today="2026-09-01")
    reg = default_registry()

    # 화요일 하루만 오전이 막혀 있다
    reg.dispatch("create_calendar_event", {
        "title": "종일 회의", "start": "2026-09-08T09:00:00", "end": "2026-09-08T12:00:00",
    }, ctx)

    # 하루만: 예전과 같은 동작
    one = reg.dispatch("find_free_slots", {"date": "2026-09-08", "duration_minutes": 60}, ctx)
    assert one.ok, one
    assert [x["start"][11:16] for x in one.data["free_slots"]] == ["12:00"], one.data

    # 기간: 월~수를 한 번에
    many = reg.dispatch("find_free_slots", {
        "date": "2026-09-07", "to_date": "2026-09-09", "duration_minutes": 60,
    }, ctx)
    assert many.ok, many
    by_date = {}
    for x in many.data["free_slots"]:
        by_date.setdefault(x["date"], []).append(x["start"][11:16])
    assert by_date["2026-09-07"] == ["09:00"], by_date
    assert by_date["2026-09-08"] == ["12:00"], by_date   # 회의 뒤만 빈다
    assert by_date["2026-09-09"] == ["09:00"], by_date
    assert many.data["days_checked"] == 3, many.data

    # 거꾸로 준 기간은 거절한다(조용히 하루만 보지 않는다)
    bad = reg.dispatch("find_free_slots", {
        "date": "2026-09-09", "to_date": "2026-09-07", "duration_minutes": 60,
    }, ctx)
    assert bad.ok is False and bad.error_code == "invalid", bad

    # 너무 긴 기간도 거절한다
    long = reg.dispatch("find_free_slots", {
        "date": "2026-09-01", "to_date": "2026-12-31", "duration_minutes": 60,
    }, ctx)
    assert long.ok is False and long.error_code == "too_many", long

    # 형식 오류는 invalid 이지 internal 이 아니다
    junk = reg.dispatch("find_free_slots", {
        "date": "2026-09-07", "duration_minutes": 60, "work_start": "아홉시",
    }, ctx)
    assert junk.ok is False and junk.error_code == "invalid", junk


def _cal_ctx(name, today="2026-09-01"):
    from backend.ai.skill_base import SkillContext
    from backend.auth import SessionUser
    from backend.config import get_settings

    st = get_settings()
    u = SessionUser(username=name, display_name=name, expires_at=0, remaining=0)
    return u, SkillContext(user=u, settings=st, today=today), st


def test_bulk_delete_is_per_occurrence_not_series():
    """일괄 삭제는 '회차'를 지운다. 시리즈를 통째로 날리면 안 된다.

    배포 전 점검에서 실측으로 잡힌 결함: list_calendar_events가 준 인스턴스 id
    하나를 bulk_delete에 넘기면 52회차가 0이 됐다. 같은 id를 단건 삭제에 주면
    그 회차만 지워진다 — 같은 식별자를 정반대로 해석하고 있었다.
    """
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("occdel")

    def n():
        return len(reg.dispatch("list_calendar_events",
                                {"from_date": "2026-01-01", "to_date": "2026-12-31"},
                                ctx).data["events"])

    reg.dispatch("create_calendar_event", {
        "title": "스탠드업", "start": "2026-01-05T09:00:00", "end": "2026-01-05T09:15:00",
        "recurrence": "weekly", "recur_until": "2026-12-28",
    }, ctx)
    total = n()
    assert total > 40, total

    day = reg.dispatch("list_calendar_events",
                       {"from_date": "2026-09-21", "to_date": "2026-09-21"}, ctx)
    inst = day.data["events"][0]["id"]
    assert "@" in inst, inst

    r = reg.dispatch("bulk_delete_calendar_events", {"event_ids": [inst]}, ctx)
    assert r.ok and r.data["count"] == 1, r
    assert n() == total - 1, (n(), total)          # 시리즈가 아니라 한 회차만

    # 휴지통에서 되돌리면 그 회차가 돌아온다
    tid = reg.dispatch("list_trash", {"kind": "event"}, ctx).data["items"][0]["id"]
    assert reg.dispatch("restore_from_trash", {"id": tid}, ctx).ok
    assert n() == total, n()

    # 기간 조건으로 골라도 회차 단위다 — 9월 4회차만
    r = reg.dispatch("bulk_delete_calendar_events",
                     {"from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx)
    assert r.data["count"] == 4, r.data
    assert n() == total - 4, n()
    assert "반복 일정의 개별 회차" in r.message, r.message

    # 시리즈 id를 직접 주면 그때는 시리즈 전체다(그리고 그렇다고 말한다)
    base = inst.split("@", 1)[0]
    dry = reg.dispatch("bulk_delete_calendar_events",
                       {"event_ids": [base], "dry_run": True}, ctx)
    assert dry.data["planned"][0]["scope"] == "series", dry.data
    assert "전체" in dry.message, dry.message
    reg.dispatch("bulk_delete_calendar_events", {"event_ids": [base]}, ctx)
    assert n() == 0, n()


def test_bulk_update_warns_about_series_in_narrow_window():
    """반복 경고가 조회 기간 폭에 좌우되면 안 된다.

    창 안 인스턴스 개수로 세던 시절에는, 하루짜리 조회에서 주간 반복도 1건이라
    "시리즈 전체가 바뀝니다" 경고가 통째로 사라졌다.
    """
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("narrowwin")
    reg.dispatch("create_calendar_event", {
        "title": "주간 회의", "start": "2026-01-05T10:00:00", "end": "2026-01-05T11:00:00",
        "recurrence": "weekly", "recur_until": "2026-12-28",
    }, ctx)
    r = reg.dispatch("bulk_update_calendar_events", {
        "from_date": "2026-09-07", "to_date": "2026-09-07",
        "title_prefix": "[x] ", "dry_run": True,
    }, ctx)
    assert r.ok and r.data["count"] == 1, r
    assert "시리즈 전체가 바뀝니다" in r.message, r.message


def test_google_bulk_update_sends_only_changed_fields():
    """구글 일괄 수정은 바뀔 필드만 보낸다.

    예전에는 전체 본문을 만들어 보냈고 거기에 start/end가 항상 들어갔다.
    기준값이 조회로 펼쳐진 '인스턴스'였으므로, 제목만 바꾸라는 요청이 시리즈
    마스터의 시작일을 그 회차로 옮겨 이전 회차를 전부 없앴다.
    """
    from backend.calendar_google import GoogleCalendar

    sent = []

    class _Req:
        def __init__(self, body=None):
            self.body = body

        def execute(self):
            return {"id": "abc123", **(self.body or {})}

    class _Events:
        def patch(self, calendarId, eventId, body):
            sent.append((eventId, body))
            return _Req(body)

    class _Svc:
        def events(self):
            return _Events()

        def new_batch_http_request(self):
            raise RuntimeError("배치 미지원")

    gc = GoogleCalendar.__new__(GoogleCalendar)
    gc._svc = _Svc()
    gc._cid = "primary"

    instance = {"id": "abc123_20260907T000000Z", "title": "스탠드업",
                "start": "2026-09-07T09:00:00", "end": "2026-09-07T09:15:00", "color": "2"}
    ok, fail = gc.patch_many([("abc123", {"title": "[취소] 스탠드업"}, instance)])
    assert ok == ["abc123"] and not fail, (ok, fail)
    eid, body = sent[0]
    assert eid == "abc123"
    assert body == {"summary": "[취소] 스탠드업"}, body   # start/end가 없어야 한다


def test_google_batch_create_fallback_keeps_same_title_events():
    """배치가 도중에 깨져도 같은 제목 일정이 사라지지 않는다.

    폴백이 '제목'으로 처리 여부를 판정해서, 같은 제목 5건 중 4건이 조용히
    누락되고도 "1개 생성, 0개 실패"로 보고됐다.
    """
    from backend.calendar_google import GoogleCalendar

    inserted = []

    class _Ins:
        def __init__(self, body):
            self.body = body

        def execute(self):
            inserted.append(self.body)
            return {"id": f"id{len(inserted)}", **self.body}

    class _Events:
        def insert(self, calendarId, body):
            return _Ins(body)

    class _Batch:
        """첫 건만 콜백을 돌리고 그다음 터지는 배치(부분 성공)."""

        def __init__(self):
            self.items = []

        def add(self, req, request_id, callback):
            self.items.append((req, callback))

        def execute(self):
            req, cb = self.items[0]
            cb("0", {"id": "batch1", **req.body}, None)
            raise RuntimeError("전송 중 연결 끊김")

    class _Svc:
        def events(self):
            return _Events()

        def new_batch_http_request(self):
            return _Batch()

    gc = GoogleCalendar.__new__(GoogleCalendar)
    gc._svc = _Svc()
    gc._cid = "primary"

    payloads = [{"title": "회의", "start": f"2026-09-0{i}T10:00:00",
                 "end": f"2026-09-0{i}T11:00:00"} for i in range(1, 6)]
    made, fail = gc.create_many(payloads)
    assert len(made) + len(fail) == 5, (len(made), len(fail))
    assert len(made) == 5, len(made)
    assert fail == [], fail

    # **실패가 하나도 없으면 실패의 모양을 검사할 수 없다.** 폴백까지 막아서
    # 진짜 실패를 만든 뒤, 실패가 제목이 아니라 요청 인덱스로 오는지 본다
    # (제목으로 오면 같은 제목 5건이 1건으로 뭉개진다 — 이 테스트의 원래 사고).
    class _BrokenIns(_Ins):
        def execute(self):
            raise RuntimeError("폴백도 실패")

    class _BrokenEvents:
        def insert(self, calendarId, body):
            return _BrokenIns(body)

    class _BrokenSvc(_Svc):
        def events(self):
            return _BrokenEvents()

    gc2 = GoogleCalendar.__new__(GoogleCalendar)
    gc2._svc = _BrokenSvc()
    gc2._cid = "primary"
    made2, fail2 = gc2.create_many(payloads)
    assert len(fail2) == 4, (len(made2), fail2)  # 배치 첫 건은 성공했다
    assert all(isinstance(k, int) for k, _ in fail2), fail2
    assert sorted(k for k, _ in fail2) == [1, 2, 3, 4], fail2


def test_bulk_create_reports_every_failure():
    """같은 제목 3건이 실패하면 3건으로 보고한다(1건으로 뭉치지 않는다)."""
    import backend.calendar_store as cstore
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("failagg")
    real = cstore.create_many
    cstore.create_many = lambda user, settings, payloads: (
        [], [(i, "강제 실패") for i, _p in enumerate(payloads)]
    )
    try:
        r = reg.dispatch("bulk_create_calendar_events", {"events": [
            {"title": "같은제목", "start": "2026-09-01T10:00:00"},
            {"title": "같은제목", "start": "2026-09-02T10:00:00"},
            {"title": "같은제목", "start": "2026-09-03T10:00:00"},
        ]}, ctx)
    finally:
        cstore.create_many = real
    assert len(r.data["failed"]) == 3, r.data["failed"]
    assert "3개 실패" in r.message, r.message
    # 어느 건이 실패했는지 알 수 있어야 재시도가 된다
    assert [f["start"] for f in r.data["failed"]] == [
        "2026-09-01T10:00:00", "2026-09-02T10:00:00", "2026-09-03T10:00:00"], r.data["failed"]


def test_single_calendar_errors_keep_their_classification():
    """없는 일정 수정·삭제는 not_found다. 'error'로 뭉개면 모델이 못 고친다."""
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("errcode")
    for name, args in [("delete_calendar_event", {"event_id": "없음"}),
                       ("update_calendar_event", {"event_id": "없음", "title": "x"})]:
        r = reg.dispatch(name, args, ctx)
        assert r.ok is False and r.error_code == "not_found", (name, r)


def test_trash_event_restore_is_claimed_under_lock():
    """같은 항목을 동시에 복원해도 일정이 하나만 생긴다.

    락을 짧게 하려고 확인만 하고 나갔더니, 두 요청이 같은 엔트리를 보고
    각자 일정을 만들어 중복됐다(실측 2건).
    """
    import threading
    import time

    import backend.calendar_service as csvc
    from backend import trash as trash_mod
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    u, ctx, st = _cal_ctx("restorerace")
    reg.dispatch("create_calendar_event",
                 {"title": "복원대상", "start": "2026-09-01T10:00:00"}, ctx)
    ev = reg.dispatch("list_calendar_events",
                      {"from_date": "2026-09-01", "to_date": "2026-09-01"}, ctx)
    reg.dispatch("delete_calendar_event", {"event_id": ev.data["events"][0]["id"]}, ctx)
    tid = reg.dispatch("list_trash", {"kind": "event"}, ctx).data["items"][0]["id"]

    real = csvc.create_event
    csvc.create_event = lambda user, settings, payload: (
        time.sleep(0.2) or real(user, settings, payload)
    )
    out = []

    def go():
        try:
            out.append(("ok", trash_mod.restore(tid, u, st)))
        except Exception as e:  # noqa: BLE001
            out.append(("err", str(getattr(e, "detail", e))))

    try:
        ts = [threading.Thread(target=go) for _ in range(2)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
    finally:
        csvc.create_event = real

    made = reg.dispatch("list_calendar_events",
                        {"from_date": "2026-09-01", "to_date": "2026-09-01"}, ctx)
    assert len(made.data["events"]) == 1, made.data["events"]
    assert sum(1 for kind, _ in out if kind == "ok") == 1, out


def test_write_document_does_not_invent_extensions_from_dates():
    """'월간정리 2026.08'의 .08은 확장자가 아니다.

    확장자로 오판해 .md를 안 붙였고, kind가 'other'인 파일이 만들어져
    바로 다음 read_document가 실패했다 — 만들자마자 못 읽는 문서였다.
    """
    from backend.ai.skill_registry import default_registry
    from backend.ai.skills.documents import _has_extension

    for name in ["월간정리 2026.08", "예산 1.5", "회의록 v1.2", "정리 2026.8"]:
        assert not _has_extension(name), name
    for name in ["todo.txt", "그림.png", "문서.md", "묶음.7z"]:
        assert _has_extension(name), name

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("extguess")
    w = reg.dispatch("write_document", {"path": "월간정리 2026.08", "content": "내용"}, ctx)
    assert w.ok, w
    r = reg.dispatch("read_document", {"path": "월간정리 2026.08"}, ctx)
    assert r.ok and "내용" in r.data["content"], r


def test_whole_series_delete_snapshots_the_real_series():
    """시리즈를 통째로 지울 땐 진짜 시리즈 기록을 휴지통에 담는다.

    '창 안 첫 회차'를 담으면 복원했을 때 시작일이 그 창으로 밀려 앞쪽 회차가
    사라진다(실측: 52회차를 지우고 되돌렸더니 17회차만 돌아왔다).
    """
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("serieskeep")

    def n(frm="2026-01-01", to="2026-12-31"):
        return len(reg.dispatch("list_calendar_events",
                                {"from_date": frm, "to_date": to}, ctx).data["events"])

    reg.dispatch("create_calendar_event", {
        "title": "스터디", "start": "2026-01-05T19:00:00", "end": "2026-01-05T21:00:00",
        "recurrence": "weekly", "recur_until": "2026-12-28",
    }, ctx)
    total = n()
    day = reg.dispatch("list_calendar_events",
                       {"from_date": "2026-09-21", "to_date": "2026-09-21"}, ctx)
    base = day.data["events"][0]["id"].split("@", 1)[0]

    # 시리즈 id + 기간을 함께 줘도 스냅샷은 시리즈 원본이어야 한다
    r = reg.dispatch("bulk_delete_calendar_events",
                     {"event_ids": [base], "from_date": "2026-09-01", "to_date": "2026-09-30"}, ctx)
    assert r.ok and n() == 0, (r, n())
    item = reg.dispatch("list_trash", {"kind": "event"}, ctx).data["items"][0]
    assert item["event_start"].startswith("2026-01-05"), item["event_start"]

    assert reg.dispatch("restore_from_trash", {"id": item["id"]}, ctx).ok
    assert n() == total, (n(), total)
    assert n("2026-01-01", "2026-03-01") == 8, n("2026-01-01", "2026-03-01")


def test_calendar_times_are_validated_at_the_boundary():
    """모델이 준 시각을 그대로 저장하지 않는다.

    검증이 없던 시절의 실측:
    - '2026-9-3T16:00:00'(자리수 부족)으로 수정하면 "일정 수정됨"이라 답한 뒤
      그 일정이 모든 조회에서 사라졌다(_parse_dt가 datetime.min을 돌려줬다).
    - '+09:00'이 붙은 start 하나가 들어가면 그 사용자의 캘린더 전체가
      "can't compare offset-naive and offset-aware datetimes"로 죽었다.
    """
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("dtguard")

    def n(frm="2026-01-01", to="2026-12-31"):
        r = reg.dispatch("list_calendar_events", {"from_date": frm, "to_date": to}, ctx)
        assert r.ok, r
        return len(r.data["events"])

    c = reg.dispatch("create_calendar_event", {
        "title": "회의", "start": "2026-09-03T14:00:00", "end": "2026-09-03T15:00:00"}, ctx)
    assert c.ok and n() == 1

    # 느슨한 표기는 정규화해서 받아들인다(거절보다 낫다) — 사라지면 안 된다
    up = reg.dispatch("update_calendar_event",
                      {"event_id": c.data["event"]["id"], "start": "2026-9-3T16:00:00"}, ctx)
    assert up.ok, up
    assert n() == 1, n()
    assert up.data["event"]["start"] == "2026-09-03T16:00:00", up.data["event"]

    # 타임존이 붙어도 캘린더가 죽지 않는다
    tz = reg.dispatch("create_calendar_event",
                      {"title": "TZ", "start": "2026-09-02T10:00:00+09:00"}, ctx)
    assert tz.ok, tz
    assert n() == 2, n()

    # 진짜 못 알아듣는 값은 거절한다(조용히 저장하지 않는다)
    bad = reg.dispatch("create_calendar_event", {"title": "x", "start": "다음 주 월요일"}, ctx)
    assert bad.ok is False and bad.error_code == "invalid", bad
    bad2 = reg.dispatch("create_calendar_event", {"title": "x", "start": "2026-02-30T10:00:00"}, ctx)
    assert bad2.ok is False and bad2.error_code == "invalid", bad2
    assert n() == 2, n()

    # 일괄 생성도 같다 — 한 건이라도 이상하면 통째로 거절
    blk = reg.dispatch("bulk_create_calendar_events", {"events": [
        {"title": "좋음", "start": "2026-10-01T10:00:00"},
        {"title": "나쁨", "start": "내일"},
    ]}, ctx)
    assert blk.ok is False and blk.error_code == "invalid", blk
    assert n() == 2, n()


def test_calendar_query_window_is_validated():
    """조회 기간을 못 알아들으면 조용히 '전 기간'이 되지 않는다."""
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("winguard")
    reg.dispatch("bulk_create_calendar_events", {"events": [
        {"title": "옛날", "start": "2020-01-01T10:00:00"},
        {"title": "미래", "start": "2030-01-01T10:00:00"},
        {"title": "이번달", "start": "2026-09-10T10:00:00"},
    ]}, ctx)

    junk = reg.dispatch("list_calendar_events", {"from_date": "다음주", "to_date": "그담주"}, ctx)
    assert junk.ok is False and junk.error_code == "invalid", junk

    # 한쪽만 주면 반대쪽은 기본창이다 — 무한이 되어 몇 년 뒤까지 걸리면 안 된다
    one = reg.dispatch("bulk_delete_calendar_events",
                       {"from_date": "2026-09-01", "dry_run": True}, ctx)
    assert one.ok, one
    assert [p["title"] for p in one.data["planned"]] == ["이번달"], one.data["planned"]

    # 거꾸로 준 기간은 거절
    rev = reg.dispatch("list_calendar_events",
                       {"from_date": "2026-12-01", "to_date": "2026-01-01"}, ctx)
    assert rev.ok is False and rev.error_code == "invalid", rev

    # 같은 날 하루 조회는 여전히 된다(경계 비교가 문자열이면 여기서 뒤집혔다)
    same = reg.dispatch("list_calendar_events",
                        {"from_date": "2026-09-10", "to_date": "2026-09-10"}, ctx)
    assert same.ok and len(same.data["events"]) == 1, same.data


def test_huge_recurrence_interval_does_not_kill_the_calendar():
    """반복 간격이 커도 조회가 죽지 않는다(year out of range → 500이었다)."""
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("bigstep")
    r = reg.dispatch("create_calendar_event", {
        "title": "폭탄", "start": "2026-01-01T10:00:00",
        "recurrence": "yearly", "interval": 100000,
    }, ctx)
    assert r.ok, r
    q = reg.dispatch("list_calendar_events",
                     {"from_date": "2026-01-01", "to_date": "2026-12-31"}, ctx)
    assert q.ok, q
    assert len(q.data["events"]) == 1, q.data


def test_single_event_delete_is_not_reported_as_series():
    """반복이 아닌 일정을 '반복 일정 전체'로 안내하지 않는다."""
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("notseries")
    reg.dispatch("create_calendar_event", {"title": "치과", "start": "2026-09-10T10:00:00"}, ctx)
    eid = reg.dispatch("list_calendar_events",
                       {"from_date": "2026-09-10", "to_date": "2026-09-10"}, ctx).data["events"][0]["id"]
    d = reg.dispatch("bulk_delete_calendar_events", {"event_ids": [eid], "dry_run": True}, ctx)
    assert d.ok and "반복" not in d.message, d.message
    assert d.data["planned"][0]["scope"] == "single", d.data


def test_bulk_delete_by_ids_does_not_refetch_every_event():
    """id로 고른 평범한 일정마다 find_event를 다시 부르지 않는다.

    이 저장소는 '건당 왕복'을 없애려고 일괄 경로를 만들었다(78건 156회에
    nginx가 응답을 끊었다). 시리즈 스냅샷 보정이 전부에 걸리면 그게 되살아난다.
    """
    import backend.calendar_service as csvc
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("norefetch")
    reg.dispatch("bulk_create_calendar_events", {"events": [
        {"title": f"e{i}", "start": f"2026-09-{i:02d}T10:00:00"} for i in range(1, 21)
    ]}, ctx)
    ids = [e["id"] for e in reg.dispatch(
        "list_calendar_events", {"from_date": "2026-09-01", "to_date": "2026-09-30"},
        ctx).data["events"]]

    real = csvc.find_event
    calls = []

    def spy(user, settings, eid):
        calls.append(eid)
        return real(user, settings, eid)

    csvc.find_event = spy
    try:
        r = reg.dispatch("bulk_delete_calendar_events", {"event_ids": ids, "dry_run": True}, ctx)
    finally:
        csvc.find_event = real
    assert r.ok and r.data["count"] == 20, r
    assert calls == [], calls


def test_rename_document_does_not_invent_extensions_from_dates():
    """이름만 바꿨는데 못 읽는 문서가 되면 안 된다."""
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("renameext")
    reg.dispatch("write_document", {"path": "결산", "content": "# 내용"}, ctx)
    rn = reg.dispatch("rename_document", {"path": "결산", "new_name": "월간정리 2026.08"}, ctx)
    assert rn.ok, rn
    rd = reg.dispatch("read_document", {"path": "월간정리 2026.08"}, ctx)
    assert rd.ok and "내용" in rd.data["content"], rd

    # UI 경로도 같다
    _login()
    client.put("/api/notes/save", json={"path": "ui결산.md", "content": "# UI"})
    r = client.post("/api/notes/rename", json={"path": "ui결산.md", "new_name": "정리 2026.08"})
    assert r.status_code == 200, r.text
    got = client.get("/api/notes/get?path=" + r.json()["path"])
    assert got.status_code == 200, got.text


def test_saving_over_a_folder_is_a_clean_conflict():
    """폴더와 같은 이름으로 저장하면 500이 아니라 409."""
    _login()
    client.post("/api/notes/folder", json={"path": "충돌폴더"})
    r = client.put("/api/notes/save", json={"path": "충돌폴더", "content": "x"})
    assert r.status_code == 409, (r.status_code, r.text)


def test_http_calendar_rejects_bad_times():
    """UI로 들어오는 시각도 검증한다(AI 쪽만 막으면 반쪽이다)."""
    _login()
    ok = client.post("/api/calendar/events",
                     json={"title": "정상", "start": "2026-09-01T10:00:00"})
    assert ok.status_code == 200, ok.text
    bad = client.post("/api/calendar/events", json={"title": "x", "start": "다음주"})
    assert bad.status_code == 422, (bad.status_code, bad.text)
    huge = client.post("/api/calendar/events", json={
        "title": "x", "start": "2026-09-01T10:00:00",
        "recurrence": "yearly", "interval": 100000})
    assert huge.status_code == 422, (huge.status_code, huge.text)
    # 그리고 캘린더는 여전히 조회된다
    q = client.get("/api/calendar/events?from=2026-09-01&to=2026-09-30")
    assert q.status_code == 200, q.text


def test_bad_path_characters_are_rejected_not_crashed():
    """사용자 입력이 서버 오류(500)가 되면 안 된다.

    널바이트와 아주 긴 이름이 그대로 os 계층까지 내려가 ValueError/OSError로
    500이 났다. 둘 다 사용자 입력이므로 400이어야 한다.
    """
    _login()
    for path in ["a\x00b", "폴더/나쁜\x01이름", "가" * 300, "a/" + "b" * 300]:
        r = client.put("/api/notes/save", json={"path": path, "content": "x"})
        assert 400 <= r.status_code < 500, (path[:20], r.status_code, r.text[:120])

    # 정상 경로는 그대로 동작한다
    ok = client.put("/api/notes/save", json={"path": "정상/문서.md", "content": "x"})
    assert ok.status_code == 200, ok.text
    # 경계 근처(200바이트 이하)는 허용
    name = "가" * 60  # 180바이트
    ok2 = client.put("/api/notes/save", json={"path": f"{name}.md", "content": "x"})
    assert ok2.status_code == 200, ok2.text


def test_restore_gives_back_an_identifier_the_next_skill_can_use():
    """복원 결과가 후속 스킬이 쓸 식별자를 준다.

    일정은 원래 id를 되살릴 수 없어 새 id로 생긴다. 그 값을 안 주면
    "복원하고 시간도 바꿔줘"에서 다음 스킬이 쓸 것이 없어 흐름이 끊긴다.
    """
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("restoreid")

    # 일정: event_id로 바로 이어서 수정할 수 있어야 한다
    reg.dispatch("create_calendar_event", {"title": "복원대상", "start": "2026-09-01T10:00:00"}, ctx)
    eid = reg.dispatch("list_calendar_events",
                       {"from_date": "2026-09-01", "to_date": "2026-09-01"},
                       ctx).data["events"][0]["id"]
    reg.dispatch("delete_calendar_event", {"event_id": eid}, ctx)
    tid = reg.dispatch("list_trash", {"kind": "event"}, ctx).data["items"][0]["id"]
    rs = reg.dispatch("restore_from_trash", {"id": tid}, ctx)
    assert rs.ok and rs.data.get("event_id"), rs.data
    nxt = reg.dispatch("update_calendar_event",
                       {"event_id": rs.data["event_id"], "title": "복원 후 수정"}, ctx)
    assert nxt.ok, nxt

    # 문서: path로 바로 이어서 읽을 수 있어야 한다
    reg.dispatch("write_document", {"path": "지울문서", "content": "내용"}, ctx)
    reg.dispatch("delete_document", {"path": "지울문서"}, ctx)
    dtid = reg.dispatch("list_trash", {"kind": "document"}, ctx).data["items"][0]["id"]
    dr = reg.dispatch("restore_from_trash", {"id": dtid}, ctx)
    assert dr.ok and dr.data.get("path"), dr.data
    rd = reg.dispatch("read_document", {"path": dr.data["path"]}, ctx)
    assert rd.ok and "내용" in rd.data["content"], rd


def _todo_ctx(name):
    from backend.ai.skill_base import SkillContext
    from backend.auth import SessionUser
    from backend.config import get_settings

    st = get_settings()
    u = SessionUser(username=name, display_name=name, expires_at=0, remaining=0)
    return u, SkillContext(user=u, settings=st, today="2026-09-01"), st


def test_todo_skills_round_trip():
    """할 일: 조회가 준 id를 수정·완료·삭제·복원이 그대로 쓸 수 있어야 한다.

    이 저장소가 반복해서 깨뜨린 지점이라 새 도메인에서는 처음부터 묶어 둔다.
    """
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _todo_ctx("todoskill")

    a = reg.dispatch("create_todo_category", {"name": "A", "color": "보라"}, ctx)
    assert a.ok, a
    sub = reg.dispatch("create_todo_category", {"name": "a-sub", "parent": "A"}, ctx)
    assert sub.ok and sub.data["category"] == "A/a-sub", sub.data
    assert reg.dispatch("create_todo_category", {"name": "X", "parent": "없는것"}, ctx).error_code == "not_found"

    t = reg.dispatch("create_todo", {"title": "보고서", "category": "A", "due": "2026-09-10"}, ctx)
    assert t.ok and t.data["todo"]["due"] == "2026-09-10", t.data
    assert t.data["todo"]["category"] == "A", t.data
    reg.dispatch("create_todo", {"title": "언젠가", "category": "A/a-sub"}, ctx)

    # 이상한 마감은 조용히 저장되지 않는다(캘린더와 같은 규칙)
    bad = reg.dispatch("create_todo", {"title": "x", "due": "다음주"}, ctx)
    assert bad.ok is False and bad.error_code == "invalid", bad

    tid = t.data["todo_id"]
    up = reg.dispatch("update_todo", {"todo_id": tid, "title": "보고서 최종"}, ctx)
    assert up.ok and up.data["todo"]["title"] == "보고서 최종", up.data

    done = reg.dispatch("complete_todo", {"todo_id": tid}, ctx)
    assert done.ok and done.data["todo"]["done"], done.data
    assert reg.dispatch("list_todos", {"include_done": False}, ctx).data["count"] == 1
    assert reg.dispatch("list_todos", {"only_done": True}, ctx).data["count"] == 1
    reg.dispatch("complete_todo", {"todo_id": tid, "done": False}, ctx)

    # 기간 조회는 기한 있는 것만
    ranged = reg.dispatch("list_todos", {"from_date": "2026-09-01", "to_date": "2026-09-30",
                                         "include_undated": False}, ctx)
    assert ranged.data["count"] == 1, ranged.data


def test_todo_delete_is_restorable_with_same_id():
    """삭제한 할 일은 휴지통에서 **원래 id로** 돌아온다(이어서 수정 가능)."""
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _todo_ctx("todotrash")
    made = reg.dispatch("create_todo", {"title": "지울 것"}, ctx)
    tid = made.data["todo_id"]
    assert reg.dispatch("delete_todo", {"todo_id": tid}, ctx).ok
    assert reg.dispatch("list_todos", {}, ctx).data["count"] == 0

    items = reg.dispatch("list_trash", {"kind": "todo"}, ctx).data["items"]
    assert len(items) == 1 and items[0]["kind_label"] == "할 일", items
    rs = reg.dispatch("restore_from_trash", {"id": items[0]["id"]}, ctx)
    assert rs.ok and rs.data["todo_id"] == tid, rs.data
    assert reg.dispatch("update_todo", {"todo_id": rs.data["todo_id"], "title": "복원 후"}, ctx).ok
    assert reg.dispatch("list_todos", {}, ctx).data["count"] == 1


def test_deleting_a_category_does_not_delete_its_todos():
    """카테고리 정리가 할 일 대량 삭제가 되면 안 된다 — 위로 올린다."""
    from backend import todo_store
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    u, ctx, st = _todo_ctx("todocat")
    top = reg.dispatch("create_todo_category", {"name": "상위"}, ctx).data["category_id"]
    reg.dispatch("create_todo_category", {"name": "하위", "parent": "상위"}, ctx)
    reg.dispatch("create_todo", {"title": "t1", "category": "상위"}, ctx)
    reg.dispatch("create_todo", {"title": "t2", "category": "상위/하위"}, ctx)
    before = reg.dispatch("list_todos", {}, ctx).data["count"]

    res = todo_store.delete_category(u, st, top)
    assert res["moved_todos"] == 1 and res["moved_categories"] == 1, res
    assert reg.dispatch("list_todos", {}, ctx).data["count"] == before, "할 일이 사라졌다"


def test_todo_categories_cannot_form_a_cycle():
    """자기 자신이나 자손 아래로 옮기면 트리가 끊겨 화면에서 사라진다."""
    from backend import todo_store
    from backend.ai.skill_registry import default_registry
    from fastapi import HTTPException

    reg = default_registry()
    u, ctx, st = _todo_ctx("todocycle")
    p = reg.dispatch("create_todo_category", {"name": "P"}, ctx).data["category_id"]
    c = reg.dispatch("create_todo_category", {"name": "C", "parent": "P"}, ctx).data["category_id"]
    for cid, parent in [(p, p), (p, c)]:
        try:
            todo_store.update_category(u, st, cid, {"parent_id": parent})
            raise AssertionError(f"순환을 허용했다: {cid} -> {parent}")
        except HTTPException as e:
            assert e.status_code == 409, e.status_code


def test_todo_http_validates_like_the_calendar():
    """UI로 들어오는 마감도 검증한다(AI 쪽만 막으면 반쪽이다)."""
    _login()
    cat = client.post("/api/todo/categories", json={"name": "업무"})
    assert cat.status_code == 200, cat.text
    ok = client.post("/api/todo/create", json={
        "title": "정상", "due": "2026-09-15", "all_day": True,
        "category_id": cat.json()["id"]})
    assert ok.status_code == 200 and ok.json()["due"] == "2026-09-15", ok.text
    bad = client.post("/api/todo/create", json={"title": "x", "due": "내일쯤"})
    assert bad.status_code == 422, (bad.status_code, bad.text)
    # 느슨한 표기는 정규화해서 받는다
    loose = client.post("/api/todo/create", json={"title": "느슨", "due": "2026-9-5T9:00"})
    assert loose.status_code == 200 and loose.json()["due"] == "2026-09-05T09:00:00", loose.text
    # 거절된 것은 저장되지 않았다. **다른 테스트가 남긴 것과 섞이지 않게** 이
    # 테스트가 만든 제목만 본다(전체 개수를 세면 실행 순서에 따라 깨진다).
    mine = {"정상", "느슨", "x"}
    lst = client.get("/api/todo/list")
    assert lst.status_code == 200
    assert {t["title"] for t in lst.json()} & mine == {"정상", "느슨"}, lst.text
    # 캘린더 표시용 기간 조회 — 기한 없는 것은 뺀다
    ranged = client.get("/api/todo/list?from=2026-09-01&to=2026-09-30&include_undated=false")
    assert ranged.status_code == 200
    assert {t["title"] for t in ranged.json()} & mine == {"정상", "느슨"}, ranged.json()
    narrow = client.get("/api/todo/list?from=2026-09-10&to=2026-09-30&include_undated=false")
    assert {t["title"] for t in narrow.json()} & mine == {"정상"}, narrow.json()


def test_todo_due_time_is_not_silently_truncated():
    """종일 할 일에 시각을 넣으면 시각이 살아야 한다.

    all_day 를 함께 주지 않았을 때 예전 값(종일=True)으로 판단해서
    "9월 20일 14시 30분"이 "9월 20일"로 조용히 잘렸다.
    """
    from backend import todo_store
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    u, ctx, st = _todo_ctx("duetime")

    made = todo_store.create_todo(u, st, {"title": "시각검사", "due": "2026-09-20", "all_day": True})
    assert made["due"] == "2026-09-20" and made["all_day"] is True, made

    # all_day 없이 시각만 준다
    up = todo_store.update_todo(u, st, made["id"], {"due": "2026-09-20T14:30:00"})
    assert up["due"] == "2026-09-20T14:30:00", up
    assert up["all_day"] is False, up

    # 반대로 시각 있던 것을 날짜만으로 바꾸면 종일이 된다
    back = todo_store.update_todo(u, st, made["id"], {"due": "2026-09-21"})
    assert back["due"] == "2026-09-21" and back["all_day"] is True, back

    # all_day 를 명시하면 그 뜻을 따른다(사용자가 일부러 지정한 것)
    forced = todo_store.update_todo(u, st, made["id"], {"due": "2026-09-22T09:00:00", "all_day": True})
    assert forced["due"] == "2026-09-22" and forced["all_day"] is True, forced

    # AI 스킬 경로도 같다
    t = reg.dispatch("create_todo", {"title": "스킬", "due": "2026-10-01"}, ctx)
    assert t.data["todo"]["due"] == "2026-10-01", t.data
    up2 = reg.dispatch("update_todo", {"todo_id": t.data["todo_id"], "due": "2026-10-01T18:00:00"}, ctx)
    assert up2.data["todo"]["due"] == "2026-10-01T18:00:00", up2.data


def test_todo_is_archived_before_it_is_removed():
    """보관이 실패하면 삭제도 일어나지 않는다.

    지우고 나서 보관하면, 보관이 실패했을 때 되돌릴 방법이 없다.
    """
    from backend import todo_store, trash
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    u, ctx, st = _todo_ctx("archivefirst")
    made = todo_store.create_todo(u, st, {"title": "소중한 것"})

    real = trash.move_todo_to_trash
    trash.move_todo_to_trash = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("보관 실패"))
    try:
        try:
            todo_store.delete_todo(u, st, made["id"])
            raise AssertionError("보관이 실패했는데 삭제가 진행됐다")
        except RuntimeError:
            pass
    finally:
        trash.move_todo_to_trash = real

    # 할 일이 그대로 남아 있어야 한다
    assert reg.dispatch("list_todos", {}, ctx).data["count"] == 1
    # 정상 경로에서는 삭제되고 휴지통에 담긴다
    todo_store.delete_todo(u, st, made["id"])
    assert reg.dispatch("list_todos", {}, ctx).data["count"] == 0
    assert len(reg.dispatch("list_trash", {"kind": "todo"}, ctx).data["items"]) == 1


def test_rich_markdown_survives_round_trip():
    """앱이 그려 주는 문법이 저장·조회·링크·검색에서 온전한가.

    콜아웃·표·형광펜·토글은 편집기와 읽기 뷰가 따로 처리한다. 저장 계층이
    한 글자라도 바꾸면 두 화면이 어긋나므로 왕복이 완전히 같아야 한다.
    """
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _cal_ctx("richmd")

    rich = (
        "# 회의 정리\n\n"
        "> [!IMPORTANT] 마감\n"
        "> 금요일까지 [[보고서]] 제출\n\n"
        "| 항목 | 담당 | 상태 |\n"
        "| --- | :---: | ---: |\n"
        "| 설계 | 나 | ==완료== |\n\n"
        "<details>\n<summary>세부</summary>\n\n- [ ] 항목 1\n\n</details>\n"
    )
    assert reg.dispatch("write_document", {"path": "회의정리", "content": rich}, ctx).ok
    assert reg.dispatch("write_document", {"path": "보고서", "content": "# 보고서"}, ctx).ok

    got = reg.dispatch("read_document", {"path": "회의정리"}, ctx)
    assert got.ok and got.data["content"] == rich, "왕복에서 내용이 바뀌었다"

    # 콜아웃·표 안의 [[링크]]도 백링크로 잡혀야 한다
    back = reg.dispatch("document_backlinks", {"path": "보고서"}, ctx)
    assert back.ok and back.data["backlinks"] == ["회의정리"], back.data

    # 형광펜 안의 글자도 검색에 걸린다(마크업을 벗겨 저장하지 않는다는 뜻)
    hit = reg.dispatch("search_documents", {"query": "완료"}, ctx)
    assert hit.ok and any("회의정리" in m["path"] for m in hit.data["matches"]), hit.data


def test_prompt_tells_the_model_which_syntax_renders():
    """앱이 지원하는 문법을 모델에게 알려 준다.

    표·형광펜·콜아웃·토글을 그려 줄 수 있는데 모델이 그걸 모르면 쓰지 않는다.
    """
    from backend.ai.prompt_builder import build_system
    from backend.auth import SessionUser

    u = SessionUser(username="p", display_name="P", expires_at=0, remaining=0)
    sp = build_system(u, "assistant", "2026-09-01", {})
    for kw in ["[!NOTE]", "==강조==", "<details>", "![[사진.png|400]]", "[[문서 제목]]"]:
        assert kw in sp, kw


# ── 단어장 ──────────────────────────────────────────────────────────

def test_vocab_store_merges_same_headword_and_filters_by_tag():
    """같은 단어를 다른 출처에서 다시 넣으면 새로 생기지 않고 태그가 합쳐진다.

    논문 두 편에서 'degrade' 를 만나면 항목 하나에 태그가 둘 — 그래야
    "어디서 봤더라"에 답할 수 있다. 태그 필터·검색·복습 큐도 함께 본다.
    """
    from backend import vocab_store
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="vocab1", display_name="V", expires_at=0, remaining=0)

    w1, merged = vocab_store.add_word(u, s, {
        "word": "Degrade", "pos": "동사", "meanings": ["저하시키다", "비하하다"],
        "synonyms": "worsen(악화시키다), impair(손상시키다)",
        "examples": [{"en": "Noise degrades the signal.", "ko": "소음이 신호를 저하시킨다.", "grammar": "타동사"}],
        "tags": ["Paper A"], "context": "…degrade their reasoning…",
    })
    assert merged is False and w1["word"] == "Degrade"
    assert w1["synonyms"] == ["worsen(악화시키다)", "impair(손상시키다)"]  # 문자열도 목록으로

    w2, merged = vocab_store.add_word(u, s, {
        "word": "degrade", "meanings": ["분해되다"], "tags": ["Paper B"],
        "examples": [{"en": "Plastics degrade slowly.", "ko": "플라스틱은 천천히 분해된다."}],
        "context": "Plastics degrade slowly.",
    })
    assert merged is True and w2["id"] == w1["id"]
    assert {t for t in w2["tags"]} == {"Paper A", "Paper B"}
    assert "저하시키다" in w2["meanings"] and "분해되다" in w2["meanings"]
    assert len(w2["examples"]) == 2
    assert "Plastics degrade slowly." in w2["context"] and "reasoning" in w2["context"]
    assert len(vocab_store.list_words(u, s)) == 1

    vocab_store.add_word(u, s, {"word": "hinder", "meanings": ["방해하다"], "tags": ["Paper A"]})
    vocab_store.add_word(u, s, {"word": "adequate", "meanings": ["충분한"], "tags": ["TOEIC"]})

    # 태그만으로 거른다(대소문자 무시)
    assert {w["word"] for w in vocab_store.list_words(u, s, tag="paper a")} == {"Degrade", "hinder"}
    assert [w["word"] for w in vocab_store.list_words(u, s, tag="TOEIC")] == ["adequate"]
    # 검색은 뜻·유사어에도 걸린다
    assert [w["word"] for w in vocab_store.list_words(u, s, query="손상")] == ["Degrade"]
    tags = vocab_store.list_tags(u, s)
    assert tags[0] == {"tag": "Paper A", "count": 2}
    assert len(tags) == 3

    # 복습: 처음엔 전부 due, 맞히면 다음 날 이후로 밀린다
    assert vocab_store.stats(u, s)["due"] == 3
    r = vocab_store.record_review(u, s, w1["id"], ok=True)
    assert r["level"] == 1 and r["next_review"] > "2000-01-01"
    assert vocab_store.stats(u, s)["due"] == 2
    r = vocab_store.record_review(u, s, w1["id"], ok=False)
    assert r["level"] == 0 and r["review_ng"] == 1

    # 태그 이름 바꾸기
    assert vocab_store.rename_tag(u, s, "Paper A", "Paper A (2026)")["changed"] == 2
    assert not vocab_store.list_words(u, s, tag="Paper A")
    assert len(vocab_store.list_words(u, s, tag="Paper A (2026)")) == 2


def test_vocab_api_and_trash_roundtrip():
    """API 로 넣고 지우면 휴지통에 가고, 복원하면 같은 id 로 돌아온다."""
    _login()
    r = client.post("/api/vocab/words/bulk", json={
        "words": [
            {"word": "persona", "meanings": ["페르소나"], "pos": "명사"},
            {"word": "hinder", "meanings": ["방해하다"]},
            {"word": "", "meanings": ["빈 단어"]},
        ],
        "tags": ["Paper X"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert [w["word"] for w in body["added"]] == ["persona", "hinder"]
    assert len(body["failed"]) == 1
    assert all("Paper X" in w["tags"] for w in body["added"])

    board = client.get("/api/vocab/board").json()
    assert board["stats"]["total"] >= 2
    assert any(t["tag"] == "Paper X" for t in board["tags"])
    wid = next(w["id"] for w in board["words"] if w["word"] == "persona")

    r = client.put(f"/api/vocab/words/{wid}", json={"notes": "라틴어 '가면'에서", "tags": ["Paper X", "어원"]})
    assert r.status_code == 200 and r.json()["notes"].startswith("라틴어")
    assert client.get("/api/vocab/words", params={"tag": "어원"}).json()[0]["id"] == wid

    r = client.delete(f"/api/vocab/words/{wid}")
    assert r.status_code == 200
    assert not any(w["id"] == wid for w in client.get("/api/vocab/words").json())
    tr = client.get("/api/trash/list", params={"kind": "vocab"}).json()
    entry = next(e for e in tr if e["name"] == "persona")
    assert entry["kind"] == "vocab" and entry["vocab_tags"] == ["Paper X", "어원"]
    assert client.get("/api/trash/counts").json()["vocab"] >= 1
    r = client.post("/api/trash/restore", params={"id": entry["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "vocab" and r.json()["word"]["id"] == wid
    assert any(w["id"] == wid for w in client.get("/api/vocab/words").json())

    # 복습 큐와 채점
    q = client.get("/api/vocab/review", params={"tag": "Paper X"}).json()
    assert any(w["id"] == wid for w in q)
    assert client.post(f"/api/vocab/words/{wid}/review", json={"ok": True}).json()["level"] == 1


def test_vocab_skills_add_and_propose_with_context_tags():
    """스킬 계약: 화면(논문)이 정한 태그가 자동으로 붙고, 후보 제안은 저장하지 않는다."""
    from backend import vocab_store
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="vocabskill", display_name="VS", expires_at=0, remaining=0)
    reg = default_registry()
    ctx = SkillContext(user=u, settings=s, today="2026-09-05", mode="paper",
                       paper_id="x", vocab_tags=["Attention Is All You Need"])

    r = reg.dispatch("propose_vocab_words", {
        "words": [{"word": "attend", "meaning": "주목하다"}, {"word": "Attend", "meaning": "중복"}],
        "context": "The model attends to all positions.",
    }, ctx)
    assert r.ok and len(r.data["proposal"]) == 1
    assert r.data["proposal"][0]["exists"] is False
    assert r.data["tags"] == ["Attention Is All You Need"]
    assert vocab_store.list_words(u, s) == []  # 저장되지 않았다
    # 화면이 그리도록 data 를 SSE 로 내보내는 스킬이다
    assert reg.get("propose_vocab_words").expose_data is True

    r = reg.dispatch("add_vocab_words", {
        "words": [{"word": "attend", "meanings": ["주목하다", "참석하다"], "pos": "동사",
                   "examples": [{"en": "It attends to all positions.", "ko": "모든 위치에 주목한다."}]}],
        "tags": ["Transformer"],
    }, ctx)
    assert r.ok, r.message
    assert len(r.data["added"]) == 1
    saved = vocab_store.find_by_word(u, s, "attend")
    assert set(saved["tags"]) == {"Transformer", "Attention Is All You Need"}

    # 이미 있으면 후보에 표시된다
    r = reg.dispatch("propose_vocab_words", {"words": [{"word": "attend", "meaning": "x"}]}, ctx)
    assert r.data["proposal"][0]["exists"] is True

    # 조회가 준 id 로 수정·삭제
    lst = reg.dispatch("list_vocab", {"tag": "transformer"}, ctx)
    assert lst.ok and lst.data["items"][0]["word"] == "attend"
    wid = lst.data["items"][0]["id"]
    assert reg.dispatch("update_vocab_word", {"id": wid, "notes": "강세 뒤"}, ctx).ok
    assert vocab_store.get_word(u, s, wid)["notes"] == "강세 뒤"
    assert reg.dispatch("delete_vocab_word", {"id": wid}, ctx).ok
    assert vocab_store.get_word(u, s, wid) is None
    assert not reg.dispatch("delete_vocab_word", {"id": wid}, ctx).ok


def test_vocab_fill_only_saves_what_the_user_picked():
    """후보에서 **고른 것만** 들어간다.

    예전에는 고른 목록을 "단어장에 넣어줘: …" 채팅으로 되돌려 보냈다. 모델이
    직전 대화에 남은 후보 전체를 보고 고르지 않은 단어까지 넣는 일이 있었다
    (논문 화면에서 실제로 그랬다). 지금은 서버가 목록을 쥐고 모델 결과를 그
    목록으로 거른다 — 모델이 무엇을 얹어 보내도 통과하지 못해야 한다.
    """
    from backend import vocab_fill, vocab_store
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="vocabfill", display_name="VF", expires_at=0, remaining=0)

    def asker(settings, prompt, payload, model=""):
        return {"words": [
            {"word": "adequate", "kind": "word", "meanings": ["충분한"], "pos": "형용사"},
            {"word": "hinder", "meanings": ["방해하다"]},   # 고르지 않았다
            {"word": "persona", "meanings": ["페르소나"]},  # 고르지 않았다
        ]}

    job = vocab_fill._new_job(u, "fill", ["adequate"], ["논문 A"])
    vocab_fill.run_fill(u, s, job["id"], [{"word": "adequate", "meaning": "충분한"}],
                        ["논문 A"], "The food was adequate.", asker=asker)
    saved = vocab_store.list_words(u, s)
    assert [w["word"] for w in saved] == ["adequate"]
    assert saved[0]["tags"] == ["논문 A"]
    assert saved[0]["context"] == "The food was adequate."

    # 반대로 모델이 빠뜨려도 고른 것은 반드시 들어간다(뜻만이라도)
    job2 = vocab_fill._new_job(u, "fill", ["ablation"], [])
    vocab_fill.run_fill(u, s, job2["id"],
                        [{"word": "ablation", "meaning": "제거 실험", "kind": "term"}],
                        [], "", asker=lambda *a, **k: {"words": []})
    w = vocab_store.find_by_word(u, s, "ablation")
    assert w is not None and w["meanings"] == ["제거 실험"] and w["kind"] == "term"

    done = [j for j in vocab_fill.jobs_for(u) if j["id"] == job["id"]][0]
    assert done["status"] == vocab_fill.STATUS_DONE and done["added"] == ["adequate"]


def test_vocab_collect_splits_words_sentences_and_grammar():
    """나열해서 넣기: 갈래가 저장되고 갈래로 거를 수 있다.

    단어장은 영어 단어 전용이 아니다 — 문장·문법·전문 용어가 같은 곳에 쌓인다.
    """
    from backend import vocab_fill, vocab_store
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="vocabcollect", display_name="VC", expires_at=0, remaining=0)
    sentence = "He has been working here since 2020."

    def asker(settings, prompt, payload, model=""):
        return {"words": [
            {"word": "give up", "kind": "phrase", "meanings": ["포기하다"]},
            {"word": sentence, "kind": "sentence", "meanings": ["그는 2020년부터 여기서 일해 왔다."]},
            {"word": "현재완료진행", "kind": "grammar", "meanings": ["과거부터 지금까지 계속되는 동작"]},
        ]}

    job = vocab_fill._new_job(u, "collect", [], ["영어 학습"])
    vocab_fill.run_collect(u, s, job["id"], "give up\n" + sentence, ["영어 학습"], asker=asker)
    kinds = {w["word"]: w["kind"] for w in vocab_store.list_words(u, s)}
    assert kinds["give up"] == "phrase"
    assert kinds[sentence] == "sentence"
    assert kinds["현재완료진행"] == "grammar"
    assert [w["word"] for w in vocab_store.list_words(u, s, kind="sentence")] == [sentence]

    # 문장은 표제어 상한(200자)에 걸려 잘리면 안 된다
    long_one = ("The quick brown fox jumps over the lazy dog. " * 6).strip()
    got, _ = vocab_store.add_word(u, s, {"word": long_one, "meanings": ["긴 문장"]})
    assert got["word"] == long_one and got["kind"] == "sentence"


def test_paper_title_change_follows_into_vocab_tags():
    """논문 제목이 바뀌면 그 논문으로 넣은 단어의 태그도 따라가야 한다.

    올린 직후 제목은 파일 이름이고 정보 추출이 끝나면 진짜 제목으로 바뀐다.
    태그를 그대로 두면 그 사이에 넣은 단어가 논문 단어장 탭(제목으로 거른다)에서
    사라진다 — 사용자에게는 "단어가 안 들어갔다"로 보인다.
    """
    from backend import paper_store, vocab_store
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="papertag", display_name="PT", expires_at=0, remaining=0)
    meta = paper_store.register(u, s, "1706.03762v7.pdf", 10)
    assert meta["title"] == "1706.03762v7"
    vocab_store.add_words(u, s, [{"word": "transformer", "meanings": ["트랜스포머"]}],
                          extra_tags=[meta["title"]])
    paper_store.update_meta(u, s, meta["id"], {"title": "Attention Is All You Need"})
    assert vocab_store.find_by_word(u, s, "transformer")["tags"] == ["Attention Is All You Need"]


def test_paper_category_folders_and_filename_rename():
    """분류(폴더)는 논문에서 모으고, 파일 이름은 고칠 수 있되 경로가 되면 안 된다."""
    from backend import paper_store
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="papercat", display_name="PC", expires_at=0, remaining=0)
    a = paper_store.register(u, s, "attention.pdf", 10)
    b = paper_store.register(u, s, "bert.pdf", 10)
    assert a["category"] == ""

    paper_store.update_meta(u, s, a["id"], {"category": " 트랜스포머 "})
    paper_store.update_meta(u, s, b["id"], {"category": "트랜스포머"})
    assert paper_store.get_paper(u, s, a["id"])["category"] == "트랜스포머"
    # 폴더 목록은 따로 저장하지 않는다 — 논문에서 모으므로 빈 폴더가 남지 않는다
    assert paper_store.categories(u, s) == ["트랜스포머"]
    paper_store.update_meta(u, s, b["id"], {"category": ""})
    assert paper_store.get_paper(u, s, b["id"])["category"] == ""
    assert paper_store.brief(paper_store.get_paper(u, s, a["id"]))["category"] == "트랜스포머"
    assert [p["id"] for p in paper_store.search(u, s, "트랜스포머")] == [a["id"]]

    # 파일 이름: 확장자를 지키고, 경로 조각으로 폴더를 벗어날 수 없다
    paper_store.update_meta(u, s, a["id"], {"filename": "어텐션 논문"})
    assert paper_store.get_paper(u, s, a["id"])["filename"] == "어텐션 논문.pdf"
    paper_store.update_meta(u, s, a["id"], {"filename": "../../etc/passwd.pdf"})
    got = paper_store.get_paper(u, s, a["id"])["filename"]
    assert "/" not in got and "\\" not in got and ".." not in got, got
    paper_store.update_meta(u, s, a["id"], {"filename": ""})  # 빈 이름은 무시
    assert paper_store.get_paper(u, s, a["id"])["filename"] == got


def test_context_sessions_split_by_gap_and_recent_window():
    """세션은 시간 간격으로 나뉘고, 모델에 들어가는 '최근'은 하루로 잘린다."""
    import time as _t

    from backend import chat_store, context_store

    now = _t.time()
    day = 86400
    msgs = [
        {"id": "1", "role": "user", "text": "어제 아침", "ts": now - day - 3600, "meta": {}},
        {"id": "2", "role": "assistant", "text": "네", "ts": now - day - 3500, "meta": {}},
        # 30분 넘게 비었다 → 새 세션
        {"id": "3", "role": "user", "text": "오늘 낮", "ts": now - 3600, "meta": {}},
        {"id": "4", "role": "assistant", "text": "좋아요", "ts": now - 3500, "meta": {}},
    ]
    sessions = context_store.split_sessions(msgs)
    assert len(sessions) == 2, [len(s) for s in sessions]
    assert context_store.session_id(sessions[0]) == f"s-{int(now - day - 3600)}"

    rows = context_store.session_rows(msgs)
    assert len(rows) == 2 and rows[0]["started_at"] > rows[1]["started_at"]  # 최근 순
    assert rows[0]["preview"] == "오늘 낮"

    # 최근 창: 하루 밖의 메시지는 빠진다
    recent = context_store.recent_for_llm(msgs, window_sec=day, max_turns=20, max_chars=9999, now=now)
    assert [m["text"] for m in recent] == ["오늘 낮", "좋아요"]
    # 창을 넓히면 전부 들어온다
    wide = context_store.recent_for_llm(msgs, window_sec=3 * day, max_turns=20, max_chars=9999, now=now)
    assert len(wide) == 4
    # 시각이 없는 옛 기록은 잘라 내지 않는다(통째로 사라지면 안 된다)
    old = [{"id": "x", "role": "user", "text": "시각 없음", "meta": {}}]
    assert len(context_store.recent_for_llm(old, window_sec=day, max_turns=20, max_chars=999, now=now)) == 1

    # chat_store 의 턴 제한도 그대로 걸린다
    assert len(chat_store.history_for_llm(msgs, max_turns=2, max_chars=9999)) == 2


def test_context_search_across_spaces_and_skills():
    """공간을 가로질러 지난 대화를 찾고, 스킬로도 같은 것을 꺼낼 수 있다."""
    from backend import chat_store, context_store
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="ctxuser", display_name="CX", expires_at=0, remaining=0)
    reg = default_registry()
    ctx = SkillContext(user=u, settings=s, today="2026-09-06")

    a = context_store.space_path(u, s, "assistant")
    c = context_store.space_path(u, s, "calendar")
    chat_store.append(a, chat_store.message("user", "트랜스포머 논문 정리해 줘"),
                      chat_store.message("assistant", "정리했습니다", {"tools": [
                          {"name": "write_document", "ok": True, "message": "만듦",
                           "args": '{"path": "a.md"}', "result": '{"ok": true}'}]}))
    chat_store.append(c, chat_store.message("user", "내일 발표 일정 잡아 줘"))

    # 공간 목록: 대화가 있는 곳이 보인다
    r = reg.dispatch("list_context_spaces", {}, ctx)
    assert r.ok, r.message
    got = {x["space"] for x in r.data["spaces"]}
    assert {"assistant", "calendar"} <= got, got

    # 검색: 공간을 가로지른다
    hits = context_store.search(u, s, "트랜스포머")
    assert len(hits) == 1 and hits[0]["space"] == "assistant"
    # 낱말 하나만 걸려도 후보로 두되, 많이 걸린 쪽이 위로 온다
    # (모두 있어야 한다고 하면 모델이 문장으로 검색할 때 0건이 되어 "없다"고 단정한다)
    part = context_store.search(u, s, "트랜스포머 없는말")
    assert len(part) == 1 and part[0]["space"] == "assistant"

    r = reg.dispatch("search_context", {"query": "발표"}, ctx)
    assert r.ok and len(r.data["hits"]) == 1
    assert r.data["hits"][0]["space"] == "calendar"

    # 읽기: 스킬 기록도 함께 나온다(감사용)
    sid = r.data["hits"][0]["session"]
    r2 = reg.dispatch("read_context", {"space": "assistant"}, ctx)
    assert r2.ok and len(r2.data["messages"]) == 2
    assert r2.data["messages"][1]["tools"][0]["name"] == "write_document"
    # 세션 id 로 좁힐 수 있다
    r3 = reg.dispatch("read_context", {"space": "calendar", "session": sid}, ctx)
    assert r3.ok and len(r3.data["messages"]) == 1

    # 없는 공간은 404 가 아니라 스킬 실패로 온다(모델이 재시도할 수 있게)
    assert not reg.dispatch("read_context", {"space": "nope"}, ctx).ok

    # 많이 걸린 대화가 위로 온다(부분 일치라 0건 절벽이 없다)
    chat_store.append(a, chat_store.message("user", "트랜스포머 논문 구조"))
    ranked = context_store.search(u, s, "트랜스포머 논문")
    assert len(ranked) >= 2 and ranked[0]["score"] >= ranked[-1]["score"]


def test_write_document_never_leaves_an_empty_file():
    """모델이 "일단 빈 파일만 만들고 나중에 채우겠다" 하고 부르는 일이 있다(실측).

    그러면 문서 목록에 0바이트 문서가 남는다. 위키링크로 만들어지는 문서와 같은
    규칙으로 제목 한 줄을 넣어 준다.
    """
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings
    from backend.storage import user_data_root

    s = get_settings()
    u = SessionUser(username="emptydoc", display_name="ED", expires_at=0, remaining=0)
    reg = default_registry()
    ctx = SkillContext(user=u, settings=s, today="2026-09-06")

    assert reg.dispatch("write_document", {"path": "검증/빈문서", "content": ""}, ctx).ok
    body = (user_data_root(u, s) / "검증" / "빈문서.md").read_text(encoding="utf-8")
    assert body.strip() == "# 빈문서", repr(body)

    # 이미 있는 문서를 빈 내용으로 덮는 것은 사용자의 뜻일 수 있으므로 건드리지 않는다
    assert reg.dispatch("write_document", {"path": "검증/빈문서", "content": ""}, ctx).ok
    assert (user_data_root(u, s) / "검증" / "빈문서.md").read_text(encoding="utf-8") == ""

def test_calendar_mode_carries_only_what_that_screen_needs():
    """캘린더 패널에 스킬 58개를 다 주면 도구 설명만 매 요청 1만 4천 토큰이다(실측).

    스킬이 많을수록 모델이 엉뚱한 것을 고르기도 한다. 그 화면에서 쓰는 것만 준다 —
    다만 "논문 읽을 시간 잡아줘"가 막다른 길이 되지 않게 조회 스킬은 남긴다.
    """
    from backend.ai import modes

    cal = modes.get_mode("calendar")
    for name in ("create_calendar_event", "update_calendar_event", "delete_calendar_event",
                 "bulk_update_calendar_events", "find_free_slots",
                 "create_todo", "complete_todo", "get_diary", "set_diary",
                 "write_document", "search_context", "list_papers", "list_meetings"):
        assert cal.allows(name), name
    # 이 화면에서 할 일이 아닌 것은 뺀다
    for name in ("read_paper_text", "update_paper_info", "write_meeting_doc",
                 "add_vocab_words", "propose_vocab_words", "get_system_status"):
        assert not cal.allows(name), name
    # 비서는 여전히 전부 쓴다(범용 화면)
    assert modes.get_mode("assistant").allows("read_paper_text")

def test_assistant_and_calendar_modes_persist_conversations():
    """비서·캘린더 대화도 서버에 남는다 — 예전에는 브라우저에만 있었다."""
    from backend.ai import modes

    assert modes.get_mode("assistant") is not None
    assert modes.get_mode("calendar") is not None
    # 두 모드는 스킬을 가리지 않는다(빈 집합 = 전부 허용)
    assert modes.get_mode("assistant").allows("create_calendar_event")
    # 컨텍스트 스킬은 어느 모드에서나 쓸 수 있어야 한다
    for name in ("english", "paper", "meeting", "assistant", "calendar"):
        spec = modes.get_mode(name)
        assert spec.allows("search_context"), name
        assert spec.allows("read_context"), name


def test_a_made_up_id_falls_back_to_the_screen_you_are_looking_at():
    """모델이 id 를 지어내면 화면이 알려 준 id 로 돌아간다.

    회의 화면에서 모델이 없는 meeting_id 를 넘겨 "회의를 찾을 수 없습니다"로 끝난
    적이 있다(실측). 화면이 준 id 가 모델이 타이핑한 id 보다 믿을 만하다.
    실제로 있는 다른 id 를 준 경우는 그대로 존중한다 — 사용자가 다른 것을 물었을 수 있다.
    """
    from backend import meeting_store, paper_store
    from backend.ai.skill_base import SkillContext
    from backend.ai.skills.meetings import _mid
    from backend.ai.skills.papers import _pid
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="fallbackid", display_name="FB", expires_at=0, remaining=0)
    here = paper_store.register(u, s, "here.pdf", 10)
    other = paper_store.register(u, s, "other.pdf", 10)
    ctx = SkillContext(user=u, settings=s, today="2026-09-06", paper_id=here["id"])

    assert _pid({}, ctx) == here["id"]                       # 생략하면 지금 논문
    assert _pid({"paper_id": other["id"]}, ctx) == other["id"]  # 있는 것은 존중
    assert _pid({"paper_id": "f" * 32}, ctx) == here["id"]      # 없는 것이면 되돌아온다

    mid = meeting_store.new_id()
    meeting_store.meeting_dir(u, s, mid).mkdir(parents=True, exist_ok=True)
    meeting_store.register(u, s, filename="a.wav", mime="audio/wav", size=1, ext="wav",
                           day="2026-09-06", mid=mid)
    mctx = SkillContext(user=u, settings=s, today="2026-09-06", meeting_id=mid)
    assert _mid({}, mctx) == mid
    assert _mid({"meeting_id": "e" * 32}, mctx) == mid

def test_completion_claims_are_checked_against_what_actually_changed():
    """바꾼 것이 없는데 "삭제했습니다" 라고 하면 서버가 표시한다.

    가장 사람을 속이는 실패다 — 사용자는 다 된 줄 알고 넘어간다. 프롬프트로 막아
    봤지만 5회 중 1회는 여전히 샜다(list_todos 만 부르고 "삭제되었습니다").
    말과 실제를 서버가 맞춰 본다. 묻는 말과 인용은 주장이 아니므로 넘어간다.
    """
    from backend.ai.orchestrator import _claims_without_doing as claims

    # 능동·피동 둘 다 잡는다(모델이 섞어 쓴다 — 능동만 막았더니 피동으로 샜다)
    assert claims("할 일을 삭제했습니다.", False)
    assert claims("할 일이 삭제되었습니다.", False)
    assert claims("일정이 생성됐습니다.", False)
    assert claims("문서를 만들었습니다.", False)
    assert claims("받아쓰기가 완료되었습니다.", False)

    # 실제로 바꿨으면 아무 말도 붙이지 않는다
    assert not claims("할 일이 삭제되었습니다.", True)

    # 묻는 말·조회 결과·인용은 주장이 아니다(잘못 경고하면 더 나쁘다)
    assert not claims("이 할 일을 삭제할까요?", False)
    assert not claims("어떤 것을 지워드릴까요", False)
    assert not claims("논문 목록입니다. 3편이 있습니다.", False)
    assert not claims("메모에 삭제하라고 적혀 있습니다.", False)
    assert not claims("", False)

def test_unexpected_skill_errors_do_not_leak_internals():
    """예상 못 한 예외의 문자열이 그대로 나가면 안 된다.

    스킬 결과 메시지는 **세 곳**으로 간다 — 화면의 스킬 칩, 대화 기록(감사 로그),
    그리고 다음 차례의 모델 입력. 예외 문자열에는 경로·키·요청 본문이 섞일 수 있다.
    우리가 직접 쓴 HTTPException 문구는 그대로 내보낸다(모델이 스스로 고쳐야 한다).
    """
    from fastapi import HTTPException

    from backend.ai.skill_base import SkillBase, SkillContext, SkillResult
    from backend.ai.skill_registry import SkillRegistry
    from backend.auth import SessionUser
    from backend.config import get_settings

    secret = "/srv/secret/key-AIzaSyDEADBEEF"

    class Boom(SkillBase):
        name = "boom"
        description = "언제나 터진다"
        parameters = {"type": "object", "properties": {}}

        def run(self, args, ctx):
            raise RuntimeError(f"내부 오류 {secret}")

    class Refuse(SkillBase):
        name = "refuse"
        description = "우리가 쓴 문구로 거절한다"
        parameters = {"type": "object", "properties": {}}

        def run(self, args, ctx):
            raise HTTPException(status_code=404, detail="논문을 찾을 수 없습니다.")

    s = get_settings()
    u = SessionUser(username="leak", display_name="L", expires_at=0, remaining=0)
    reg = SkillRegistry()
    reg.register(Boom())
    reg.register(Refuse())
    ctx = SkillContext(user=u, settings=s, today="2026-09-06")

    # 운영 조건(DEBUG=false)에서는 자세한 내용이 나가지 않는다.
    # 이 테스트 모듈은 DEBUG=true 로 돌아가므로 잠깐 꺼서 확인한다.
    was = s.debug
    s.debug = False
    try:
        r = reg.dispatch("boom", {}, ctx)
    finally:
        s.debug = was
    assert r.ok is False and r.error_code == "internal"
    assert secret not in r.message and "AIzaSy" not in r.message, r.message
    assert "boom" in r.message  # 어느 스킬이 터졌는지는 알려 준다

    # DEBUG=true 인 개발 환경에서는 원인을 봐야 하므로 붙여 준다
    s.debug = True
    try:
        assert secret in reg.dispatch("boom", {}, ctx).message
    finally:
        s.debug = was

    # 우리가 쓴 문구는 그대로 — 모델이 그걸 보고 다시 조회해야 한다
    r = reg.dispatch("refuse", {}, ctx)
    assert r.error_code == "not_found" and "찾을 수 없습니다" in r.message

    # 없는 스킬도 스트림을 죽이지 않고 실패로만 돌아온다
    assert reg.dispatch("없는스킬", {}, ctx).error_code == "not_found"

def test_truncated_history_tells_the_model_there_is_more():
    """창 밖으로 밀려난 대화가 있으면 **그 사실을 알린다.**

    모르면 모델은 보이는 앞부분을 "대화의 시작"으로 단정한다 — 32턴 중 20턴만
    보이는데 "맨 처음에 …라고 하셨습니다" 하고 엉뚱한 말을 골랐다(실측).
    안내를 넣은 뒤에는 스스로 search_context/read_context 로 꺼내 3회 중 3회 맞혔다.
    """
    from backend import context_store

    # 잘린 게 없으면 군더더기를 붙이지 않는다
    assert context_store.truncation_note(20, 20, "assistant", "비서") == ""
    assert context_store.truncation_note(5, 20, "assistant", "비서") == ""

    note = context_store.truncation_note(32, 20, "assistant", "비서")
    assert "최근 20턴" in note and "12턴" in note, note
    assert "대화의 시작이 아닙니다" in note, note
    assert 'read_context(space="assistant")' in note, note  # 꺼내는 법까지 적는다

def test_context_is_isolated_per_user_and_survives_concurrent_writes():
    """컨텍스트는 사용자별로 갇혀 있고, 동시에 써도 잃어버리지 않는다.

    대화 기록은 가장 사적인 자료다. 검색이 공간을 가로지르므로(search_context)
    **다른 사용자 것이 섞이면 안 된다.** 공간 이름으로 경로를 벗어나려는 시도도 막는다.
    """
    import threading

    from fastapi import HTTPException

    from backend import chat_store, context_store
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    a = SessionUser(username="ctxalice", display_name="A", expires_at=0, remaining=0)
    b = SessionUser(username="ctxbob", display_name="B", expires_at=0, remaining=0)

    chat_store.append(context_store.space_path(a, s, "assistant"),
                      chat_store.message("user", "앨리스의 비밀 alpha-secret"))
    chat_store.append(context_store.space_path(b, s, "assistant"),
                      chat_store.message("user", "밥의 일정"))
    assert context_store.search(b, s, "alpha-secret") == []
    assert len(context_store.search(a, s, "alpha-secret")) == 1
    assert [r["messages"] for r in context_store.space_rows(b, s) if r["space"] == "assistant"] == [1]

    # 공간 이름으로 남의 폴더에 닿을 수 없다. resolve_space 가 **스스로** 막아야 한다
    # (뒤의 경로 검사에만 기대면, 이 값을 그대로 믿는 코드가 생겼을 때 뚫린다).
    for evil in ("../ctxalice/chats/assistant", "paper:../../ctxalice", "assistant/../../ctxbob", ".."):
        try:
            context_store.resolve_space(b, s, evil)
        except HTTPException:
            continue
        raise AssertionError(f"막히지 않았다: {evil}")

    # 같은 공간에 여러 스레드가 써도 한 건도 잃지 않는다(원자적 쓰기 + 락)
    path = context_store.space_path(a, s, "calendar")

    def writer(n):
        for i in range(20):
            chat_store.append(path, chat_store.message("user", f"w{n}-{i}"))

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    got = chat_store.load(path)
    assert len(got) == 80, len(got)
    assert len({m["text"] for m in got}) == 80


def test_transcription_never_stores_an_invented_meeting():
    """못 들었으면 **지어낸 회의록을 저장하지 않는다.**

    깨진 WAV 를 넣었더니 모델이 그럴듯한 회의(AI 스피커 이야기)를 통째로 만들어
    내고 status=ready 로 저장됐다(실측). 회의록은 사용자가 그대로 믿는 기록이라,
    없는 것보다 지어낸 것이 훨씬 나쁘다. 무음 녹음(마이크를 잘못 잡은 경우)에서도
    같은 일이 난다.
    """
    from backend import meeting_store, meeting_transcribe
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="mtguard", display_name="MG", expires_at=0, remaining=0)
    mid = meeting_store.new_id()
    d = meeting_store.meeting_dir(u, s, mid)
    d.mkdir(parents=True, exist_ok=True)
    (d / "audio.wav").write_bytes(b"RIFF____WAVEfmt ")  # 내용은 상관없다(가짜 모델을 쓴다)
    meeting_store.register(u, s, filename="x.wav", mime="audio/wav", size=16, ext="wav",
                           day="2026-09-06", mid=mid)

    # 모델이 "못 들었다"고 하면 실패로 남고 받아쓰기 파일이 생기지 않아야 한다
    meeting_transcribe.run_sync(u, s, mid,
                                asker=lambda *a, **k: {"inaudible": True, "reason": "silent"})
    m = meeting_store.get_meeting(u, s, mid)
    assert m["status"] == meeting_store.STATUS_FAILED, m
    assert "알아듣지 못했" in m["error"], m["error"]
    assert not meeting_store.transcript_path(u, s, mid).exists(), "지어낸 받아쓰기가 저장되면 안 된다"
    assert not m.get("summary"), m.get("summary")

    # 제대로 들었을 때는 그대로 저장된다
    meeting_transcribe.run_sync(u, s, mid, asker=lambda *a, **k: {
        "summary": "검색 성능 개선을 논의했다",
        "segments": [{"start": "00:00", "end": "00:05", "speaker": "화자 1", "text": "회의 시작합니다"},
                     {"start": "00:05", "end": "00:10", "speaker": "화자 2", "text": "네 좋습니다"}],
    })
    m = meeting_store.get_meeting(u, s, mid)
    assert m["status"] == meeting_store.STATUS_READY and m["segments"] == 2, m
    assert "검색 성능" in m["summary"]


def test_prompts_anchor_today_with_a_weekday():
    """상대 날짜를 옮길 때 요일을 함께 준다.

    회의록에 "이번 주 금요일(2026-09-12)" 이라 적었는데 그날은 토요일이었다(실측).
    기준 요일을 프롬프트에 넣고 답에도 요일을 적게 하면 사람 눈에 바로 띈다.
    """
    from backend.ai import modes
    from backend.ai.prompt_builder import build_system, today_with_weekday
    from backend.auth import SessionUser

    assert today_with_weekday("2026-09-06") == "2026-09-06(일요일)"
    assert today_with_weekday("망가진 값") == "망가진 값"  # 실패해도 프롬프트는 만들어져야 한다

    u = SessionUser(username="x", display_name="X", expires_at=0, remaining=0)
    for text in (build_system(u, "assistant", "2026-09-06"), modes._head(u, "2026-09-06")):
        assert "2026-09-06(일요일)" in text
        assert "요일을 함께 적으세요" in text
        assert "하지 않은 일을 했다고 말하지 마세요" in text


def test_diary_and_paper_skills_cover_the_new_screens():
    """새 화면(기록·논문 폴더)을 AI 도 다룰 수 있어야 한다.

    없을 때는 모델이 "오늘 힘들었다고 기록해 줘"를 문서 만들기로 처리했고(실측),
    논문을 폴더로 옮겨 달라면 문서를 뒤지다 포기했다.
    """
    from backend import diary_store, paper_store
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    u = SessionUser(username="newscreens", display_name="NS", expires_at=0, remaining=0)
    reg = default_registry()
    ctx = SkillContext(user=u, settings=s, today="2026-09-06")

    # 기록: 사람 말("힘듦")도 도형 이름("square")도 받는다
    r = reg.dispatch("set_diary", {"date": "2026-09-06", "body": "힘듦", "heart": "좋음",
                                   "text": "하루 종일 코딩했다"}, ctx)
    assert r.ok, r.message
    e = diary_store.get_day(u, s, "2026-09-06")
    assert e["body"] == "square" and e["heart"] == "circle"
    assert e["mind"] == "", "말하지 않은 축은 비어 있어야 한다(화면에 - 로 나온다)"
    assert e["text"] == "하루 종일 코딩했다"

    r = reg.dispatch("set_diary", {"date": "2026-09-06", "mind": "star",
                                   "text": "저녁엔 산책", "append": True}, ctx)
    assert r.ok and diary_store.get_day(u, s, "2026-09-06")["mind"] == "star"
    assert "산책" in diary_store.get_day(u, s, "2026-09-06")["text"]
    assert "코딩" in diary_store.get_day(u, s, "2026-09-06")["text"], "append 는 덧붙여야 한다"

    r = reg.dispatch("get_diary", {"date": "2026-09-06"}, ctx)
    assert r.ok and r.data["육체"].startswith("힘듦")

    # 논문 폴더·제목: 폴더는 미리 만들지 않는다
    meta = paper_store.register(u, s, "x.pdf", 10)
    r = reg.dispatch("update_paper_info", {"paper_id": meta["id"], "category": "강화학습"}, ctx)
    assert r.ok, r.message
    assert paper_store.get_paper(u, s, meta["id"])["category"] == "강화학습"
    assert paper_store.categories(u, s) == ["강화학습"]
    # 빈 문자열이면 폴더에서 뺀다 → 빈 폴더는 저절로 사라진다
    assert reg.dispatch("update_paper_info", {"paper_id": meta["id"], "category": ""}, ctx).ok
    assert paper_store.categories(u, s) == []
    # 바꿀 내용이 없으면 실패로 알린다(모델이 되풀이하지 않게)
    assert not reg.dispatch("update_paper_info", {"paper_id": meta["id"]}, ctx).ok


# ── 논문 ────────────────────────────────────────────────────────────

def _tiny_pdf(text: str = "Hello paper") -> bytes:
    """글자가 든 한 쪽짜리 PDF(pypdf 가 본문을 뽑을 수 있게 표준 폰트로)."""
    from pypdf import PdfWriter

    w = PdfWriter()
    page = w.add_blank_page(width=300, height=300)
    from pypdf.generic import DictionaryObject, NameObject, StreamObject

    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    font_ref = w._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref}),
    })
    stream = StreamObject()
    stream._data = f"BT /F1 18 Tf 20 150 Td ({text}) Tj ET".encode("latin-1")
    page[NameObject("/Contents")] = w._add_object(stream)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def test_paper_upload_extracts_in_background_and_ai_context(monkeypatch):
    """업로드하면 백그라운드 추출이 돌고, 논문 모드 대화는 서버에 남으며
    다른 논문의 대화도 검색된다."""
    from backend import chat_store, paper_extract, paper_store
    from backend.ai import orchestrator
    from backend.ai.orchestrator import LLMResult
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    # 모델 대신 가짜 추출기: 스레드를 띄우지 않고 그 자리에서 돌린다
    def fake_ask(settings, pdf, text):
        assert "[[page 1]]" in text and pdf.exists()
        if "Second one" in text:
            return {"title": "Second Paper", "summary": "두 번째"}
        assert "Hello paper" in text
        return {"title": "Hello Paper: A Study", "authors": ["A. Author"], "year": "2026",
                "summary": "인사에 대한 연구", "key_findings": ["인사는 중요하다"],
                "keywords": ["greeting"], "sections": ["1 Intro"]}

    started = []

    def fake_start(user, settings, pid):
        started.append(pid)
        paper_extract.run_sync(user, settings, pid, asker=fake_ask)
        return True

    monkeypatch.setattr(paper_extract, "start", fake_start)

    _login()
    r = client.post("/api/papers/upload", files={"file": ("hello.pdf", _tiny_pdf(), "application/pdf")})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert started == [pid]
    p = client.get(f"/api/papers/{pid}").json()
    assert p["status"] == "ready" and p["title"] == "Hello Paper: A Study" and p["pages"] == 1
    assert p["summary"] == "인사에 대한 연구"

    # PDF 가 아닌 것은 거절
    r = client.post("/api/papers/upload", files={"file": ("x.pdf", b"not a pdf", "application/pdf")})
    assert r.status_code == 415
    # 원본 내려받기(inline)
    f = client.get(f"/api/papers/{pid}/file")
    assert f.status_code == 200 and f.headers["content-type"].startswith("application/pdf")
    assert f.headers["content-disposition"] == "inline"

    # 두 번째 논문 + 그 논문에서 나눈 대화
    r = client.post("/api/papers/upload", files={"file": ("second.pdf", _tiny_pdf("Second one"), "application/pdf")})
    pid2 = r.json()["id"]
    u = SessionUser(username="tester", display_name="Tester", expires_at=0, remaining=0)
    chat_store.append(paper_store.chat_path(u, s, pid2),
                      chat_store.message("user", "positional encoding 이 뭐야"),
                      chat_store.message("assistant", "위치 정보를 더하는 방식입니다."))

    # 논문 모드 대화: 시스템 프롬프트에 이 논문 정보와 다른 논문 목록이 들어가고,
    # 영역 이미지가 inline_data 로 붙고, 논문 태그가 스킬 컨텍스트에 실린다
    seen = {}

    class FakeLLM:
        def __init__(self):
            self.n = 0

        def chat(self, contents, catalog, system):
            self.n += 1
            seen["system"] = system
            seen["catalog"] = [c["name"] for c in catalog]
            seen["contents"] = contents
            if self.n == 1:
                return LLMResult(text="", tool_use={"name": "search_paper_chats", "args": {"query": "positional"}})
            if self.n == 2:
                return LLMResult(text="", tool_use={"name": "propose_vocab_words", "args": {
                    "words": [{"word": "encode", "meaning": "부호화하다"}]}})
            return LLMResult(text="다른 논문에서 설명했었습니다.", tool_use=None)

    monkeypatch.setattr(orchestrator, "GeminiLLM", lambda settings, model="": FakeLLM())
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    import base64 as _b64
    r = client.post("/api/ai/chat", json={
        "message": "이 그림 설명해줘", "mode": "paper", "paper_id": pid,
        "attachments": [{"mime": "image/png", "data": _b64.b64encode(png).decode(), "label": "2쪽 영역"}],
        "selections": [{"text": "We propose a greeting.", "page": 1}],
    })
    assert r.status_code == 200, r.text
    events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    assert "Hello Paper: A Study" in seen["system"]
    assert pid2 in seen["system"] and "Second Paper" in seen["system"]  # 다른 논문 목록
    assert "read_paper_text" in seen["catalog"] and "get_system_status" not in seen["catalog"]
    # 마지막 LLM 호출의 대화에는 [사용자 메시지, 도구 호출, 도구 결과, …] 순으로 쌓인다
    user_turn = next(c for c in seen["contents"] if c["role"] == "user" and "text" in c["parts"][0]
                     and "이 그림 설명해줘" in c["parts"][0]["text"])
    assert any("inline_data" in p and p["inline_data"]["data"] == png for p in user_turn["parts"])
    assert "We propose a greeting." in user_turn["parts"][0]["text"] and "1쪽" in user_turn["parts"][0]["text"]
    hits = next(e for e in events if e["type"] == "tool_result" and e["name"] == "search_paper_chats")
    assert hits["ok"]
    prop = next(e for e in events if e["type"] == "tool_result" and e["name"] == "propose_vocab_words")
    assert prop["data"]["proposal"][0]["word"] == "encode"
    assert prop["data"]["tags"] == ["Hello Paper: A Study"]

    # 대화가 서버에 남았고(선택 글 메타 포함), 다시 열면 그대로 온다
    msgs = client.get(f"/api/ai/space/paper:{pid}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[0]["text"] == "이 그림 설명해줘"
    assert msgs[0]["meta"]["selections"][0]["page"] == 1
    assert msgs[0]["meta"]["attachments"][0]["label"] == "2쪽 영역"
    assert msgs[1]["meta"]["tools"][-1]["data"]["proposal"][0]["word"] == "encode"
    # 다음 요청은 서버 기록을 history 로 쓴다(브라우저 history 는 무시)
    client.post("/api/ai/chat", json={"message": "고마워", "mode": "paper", "paper_id": pid,
                                      "history": [{"role": "user", "text": "가짜 기록"}]})
    texts = [p.get("text", "") for c in seen["contents"] for p in c["parts"]]
    assert any("이 그림 설명해줘" in t for t in texts) and not any("가짜 기록" in t for t in texts)

    # 영역 이미지는 논문 모드에서만: PNG·JPEG·WebP 만, 크기 제한
    r = client.post("/api/ai/chat", json={"message": "x", "mode": "paper", "paper_id": pid,
                                          "attachments": [{"mime": "image/gif", "data": "AAAA"}]})
    assert r.status_code == 415
    assert client.post("/api/ai/chat", json={"message": "x", "mode": "nope"}).status_code == 400

    # 삭제 → 휴지통(폴더째) → 복원(같은 id, 대화도 함께)
    r = client.delete(f"/api/papers/{pid2}")
    assert r.status_code == 200
    assert client.get(f"/api/papers/{pid2}").status_code == 404
    entry = next(e for e in client.get("/api/trash/list", params={"kind": "paper"}).json() if e["paper_id"] == pid2)
    assert entry["is_dir"] is True and entry["paper_filename"] == "second.pdf"
    r = client.post("/api/trash/restore", params={"id": entry["id"]})
    assert r.status_code == 200 and r.json()["paper_id"] == pid2, r.text
    assert client.get(f"/api/papers/{pid2}/file").status_code == 200
    assert len(client.get(f"/api/ai/space/paper:{pid2}").json()["messages"]) == 2


def test_english_mode_persists_chat_and_limits_skills(monkeypatch):
    """영어 학습 모드: 단어장 스킬만 보이고 대화가 서버에 남는다."""
    from backend.ai import orchestrator
    from backend.ai.orchestrator import LLMResult

    seen = {}

    class FakeLLM:
        def __init__(self):
            self.n = 0

        def chat(self, contents, catalog, system):
            self.n += 1
            seen["system"] = system
            seen["catalog"] = set(c["name"] for c in catalog)
            if self.n == 1:
                return LLMResult(text="", tool_use={"name": "add_vocab_words", "args": {
                    "words": [{"word": "adequate", "meanings": ["충분한"], "pos": "형용사"}],
                    "tags": ["영어 학습"]}})
            return LLMResult(text="adequate 를 넣었습니다.", tool_use=None)

    monkeypatch.setattr(orchestrator, "GeminiLLM", lambda settings, model="": FakeLLM())
    _login()
    client.delete("/api/ai/space/english")
    r = client.post("/api/ai/chat", json={"message": "adequate 단어장에 넣어줘", "mode": "english"})
    assert r.status_code == 200, r.text
    events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    added = next(e for e in events if e["type"] == "tool_result" and e["name"] == "add_vocab_words")
    assert added["ok"] and added["mutates"] == "vocab" and added["data"]["added"][0]["word"] == "adequate"
    assert "add_vocab_words" in seen["catalog"] and "create_calendar_event" not in seen["catalog"]
    assert "영어 학습 튜터" in seen["system"]
    msgs = client.get("/api/ai/space/english").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert any(w["word"] == "adequate" for w in client.get("/api/vocab/words", params={"tag": "영어 학습"}).json())
    # 한 줄 지우기·비우기
    assert client.delete(f"/api/ai/space/english/{msgs[0]['id']}").status_code == 200
    assert len(client.get("/api/ai/space/english").json()["messages"]) == 1
    client.delete("/api/ai/space/english")
    assert client.get("/api/ai/space/english").json()["messages"] == []


def test_answers_stream_out_word_by_word(monkeypatch):
    """답이 다 만들어질 때까지 기다리지 않고 조각으로 흘러야 한다.

    함께 확인하는 것: (1) 조각의 합이 최종본과 같다, (2) 저장되는 것은 조각이
    아니라 완성본 하나다, (3) 도구를 쓴 뒤 다시 쓰는 답도 흘러나온다,
    (4) `stream()` 이 없는 모델도 예전처럼 동작한다.
    """
    from backend.ai import orchestrator
    from backend.ai.orchestrator import LLMResult

    _login()

    class StreamingLLM:
        def __init__(self):
            self.n = 0

        def stream(self, contents, catalog, system):
            self.n += 1
            if self.n == 1:  # 도구를 부르는 차례 — 흘릴 글이 없다
                return LLMResult(text="", tool_uses=[{"name": "list_todos", "args": {}}])
                yield  # noqa: W0101 - 생성기로 만들기 위한 표시
            for piece in ("오늘 ", "할 일은 ", "없습니다."):
                yield piece
            return LLMResult(text="오늘 할 일은 없습니다.", tool_uses=[])

    monkeypatch.setattr(orchestrator, "GeminiLLM", lambda settings, model="": StreamingLLM())
    client.delete("/api/ai/space/assistant")
    r = client.post("/api/ai/chat", json={"message": "오늘 할 일 알려줘", "mode": "assistant"})
    assert r.status_code == 200, r.text
    events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    kinds = [e["type"] for e in events]
    assert kinds.count("text_delta") == 3, kinds
    assert kinds.index("tool_call") < kinds.index("text_delta"), kinds
    joined = "".join(e["text"] for e in events if e["type"] == "text_delta")
    final = next(e for e in events if e["type"] == "text")
    assert joined == final["text"] == "오늘 할 일은 없습니다.", (joined, final["text"])

    msgs = client.get("/api/ai/space/assistant").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"], msgs
    assert msgs[1]["text"] == "오늘 할 일은 없습니다.", msgs[1]

    # stream() 이 없는 모델(옛 경로)도 그대로 답한다 — 조각은 없고 최종본만 온다
    class PlainLLM:
        def chat(self, contents, catalog, system):
            return LLMResult(text="예전 방식 답변입니다.", tool_use=None)

    monkeypatch.setattr(orchestrator, "GeminiLLM", lambda settings, model="": PlainLLM())
    client.delete("/api/ai/space/assistant")
    r = client.post("/api/ai/chat", json={"message": "안녕", "mode": "assistant"})
    events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    assert not [e for e in events if e["type"] == "text_delta"]
    assert next(e for e in events if e["type"] == "text")["text"] == "예전 방식 답변입니다."


def test_stream_chunks_stop_flowing_once_a_tool_call_appears():
    """모델이 말하다가 도구를 부르면, 그 뒤 글은 화면으로 흘리지 않는다.

    흘려 보내면 사용자는 답이 시작된 줄 알았다가 지워지는 것을 본다. 그 말은
    버리지 않고 LLMResult 에는 담아 둔다(단계 한도에 걸렸을 때 쓴다).
    """
    from backend.ai.orchestrator import consume_stream

    class Part:
        def __init__(self, text="", call=None):
            self.text = text
            self.function_call = call

    class Call:
        def __init__(self, name, args):
            self.name, self.args = name, args

    def chunk(*parts):
        return type("C", (), {"candidates": [type("X", (), {
            "content": type("Y", (), {"parts": list(parts)})()})()]})()

    chunks = [chunk(Part("생각해 ")), chunk(Part("볼게요. ")),
              chunk(Part(call=Call("list_todos", {}))), chunk(Part("잠시만요."))]
    gen = consume_stream(chunks)
    flowed = []
    while True:
        try:
            flowed.append(next(gen))
        except StopIteration as stop:
            res = stop.value
            break
    assert flowed == ["생각해 ", "볼게요. "], flowed  # 호출 뒤의 "잠시만요."는 안 흘린다
    assert res.text == "생각해 볼게요. 잠시만요.", res.text
    assert [c["name"] for c in res.calls()] == ["list_todos"], res.calls()


def test_global_search_finds_the_same_word_across_every_screen():
    """화면을 몰라도 찾을 수 있어야 한다 — 노트·논문·회의·단어·할 일·일정을 한 번에.

    이 검색이 없을 때는 "저번에 그 회의에서 나온 그 용어"를 찾으려면 어느 화면에
    넣었는지를 먼저 기억해야 했다. 기억하려고 쓰는 도구가 기억을 요구한 셈이다.
    """
    from backend import calendar_store, paper_store, search_all, todo_store, vocab_store
    from backend.storage import user_data_root

    u, _ctx, st = _todo_ctx("searchall")
    seed = "형광체"

    root = user_data_root(u, st)
    (root / f"{seed}메모.md").write_text(f"# {seed}\n\n{seed}는 빛을 낸다.", encoding="utf-8")
    (root / "딴것.md").write_text("여기엔 그 낱말이 없다.", encoding="utf-8")
    todo_store.create_todo(u, st, {"title": f"{seed} 논문 읽기"})
    todo_store.create_todo(u, st, {"title": "관계없는 할 일"})
    vocab_store.add_words(u, st, [{"word": seed, "meanings": ["빛을 내는 물질"]}])
    calendar_store.create_event(u, st, {"title": f"{seed} 세미나", "start": "2026-09-10",
                                        "allDay": True})
    search_all._EVENT_CACHE.pop(u.username, None)   # 앞 테스트의 30초 캐시를 비운다

    hits = search_all.search(u, st, seed)
    kinds = {h["kind"] for h in hits}
    assert {"note", "todo", "vocab", "event"} <= kinds, kinds
    assert all(seed in h["title"] or seed in h["snippet"] for h in hits), hits
    assert hits[0]["title"] == seed and hits[0]["kind"] == "vocab", hits[0]  # 정확 일치가 1등

    # 갈래를 지정하면 그것만
    only = search_all.search(u, st, seed, kinds=("todo",))
    assert {h["kind"] for h in only} == {"todo"}, only

    # 없는 낱말은 조용히 0건, 빈 검색어도 0건(예외가 아니다)
    assert search_all.search(u, st, "없는낱말zzzz") == []
    assert search_all.search(u, st, "   ") == []

    # 한 갈래가 통째로 깨져도 나머지는 나온다
    broken = dict(search_all._SOURCES)
    broken["paper"] = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("깨짐"))
    saved, search_all._SOURCES = search_all._SOURCES, broken
    try:
        assert {h["kind"] for h in search_all.search(u, st, seed)} >= {"note", "todo"}
    finally:
        search_all._SOURCES = saved

    # 논문 제목을 바꾸면 검색도 따라온다(색인을 따로 두지 않기 때문)
    papers = paper_store.list_papers(u, st)
    if papers:
        paper_store.update_meta(u, st, papers[0]["id"], {"title": f"{seed} 총설"})
        assert any(h["kind"] == "paper" for h in search_all.search(u, st, seed))


def test_list_vocab_does_not_scold_a_limit_it_was_given():
    """모델이 스스로 limit 을 주면 잘린 게 아니라 시킨 대로 낸 것이다.

    그때까지 "tag/query 로 좁히세요"라고 하면, 이미 태그로 좁혀 놓고 세 개만
    달라고 한 모델에게 엉뚱한 훈수를 두는 셈이다(47차에서 실제로 봤다).
    """
    from backend.ai.skill_registry import default_registry

    reg = default_registry()
    _u, ctx, _st = _todo_ctx("vocablimit")
    reg.dispatch("add_vocab_words", {"words": [
        {"word": f"w{i}", "meanings": ["뜻"]} for i in range(6)]}, ctx)

    asked = reg.dispatch("list_vocab", {"limit": 3}, ctx)
    assert "요청한 3개만" in asked.message, asked.message
    assert "좁히세요" not in asked.message, asked.message
    assert len(asked.data["items"]) == 3 and asked.data["total"] == 6

    # 스스로 정하지 않았는데 상한에 닿았으면 그때는 좁히라고 알려 준다
    import backend.ai.skills.vocab as vsk
    old = vsk._MAX_ROWS
    try:
        vsk._MAX_ROWS = 2
        auto = reg.dispatch("list_vocab", {}, ctx)
        assert "좁히세요" in auto.message, auto.message
    finally:
        vsk._MAX_ROWS = old


def test_adding_many_words_touches_the_file_once():
    """단어를 묶음으로 넣을 때 단어장 전체를 개수만큼 다시 쓰면 안 된다.

    예전에는 낱개 add_word 를 반복해서 넣는 개수 × 단어 수만큼 일했다
    (2000건에 191초). 지금은 한 번 읽고 한 번 쓴다.
    한 묶음 안의 중복·병합 결과는 낱개로 넣던 때와 같아야 한다.
    """
    from backend import json_store, vocab_store

    u, _ctx, st = _todo_ctx("vocabbatch")
    writes = {"n": 0}
    real = json_store.write_atomic

    def counting(path, data, **kw):
        writes["n"] += 1
        return real(path, data, **kw)

    import unittest.mock as _mock
    with _mock.patch.object(json_store, "write_atomic", counting):
        res = vocab_store.add_words(u, st, [
            {"word": "alpha", "meanings": ["처음"]},
            {"word": "beta", "meanings": ["둘째"]},
            {"word": "alpha", "meanings": ["처음", "첫째"]},   # 같은 묶음 안의 중복
            "잘못된 형식",
        ], extra_tags=["묶음"])

    assert writes["n"] == 1, f"파일을 {writes['n']}번 썼다"
    assert [w["word"] for w in res["added"]] == ["alpha", "beta"], res["added"]
    assert [w["word"] for w in res["merged"]] == ["alpha"], res["merged"]
    assert res["failed"] and res["failed"][0]["reason"], res["failed"]

    words = vocab_store.list_words(u, st)
    assert len(words) == 2, [w["word"] for w in words]
    alpha = next(w for w in words if w["word"] == "alpha")
    assert "첫째" in alpha["meanings"], alpha        # 뒤엣것이 합쳐졌다
    assert "묶음" in alpha["tags"], alpha            # extra_tags 도 그대로


def test_every_mode_can_search_outside_its_own_screen():
    """모드마다 스킬을 줄이는 이유는 엉뚱한 도구를 막으려는 것이지만,
    전체 검색만은 예외다 — 화면 밖을 찾는 유일한 길이라 모든 모드에 있어야 한다."""
    from backend.ai import modes

    for name, mode in modes.MODES.items():
        assert mode.allows("search_everything"), name


def test_recurring_events_appear_once_in_search():
    """매년 오는 생일이 스무 줄로 나오면 검색 결과가 그것만으로 찬다."""
    from backend import calendar_store, search_all

    u, _ctx, st = _todo_ctx("searchrecur")
    calendar_store.create_event(u, st, {
        "title": "생일 축하합니다", "start": "2020-11-12", "allDay": True,
        "recurrence": "yearly", "interval": 1})
    search_all._EVENT_CACHE.pop(u.username, None)

    hits = [h for h in search_all.search(u, st, "생일") if h["kind"] == "event"]
    assert len(hits) == 1, [h["when"] for h in hits]
    # 남는 것은 오늘에 가장 가까운 회차여야 한다(1년 전 것이 아니라)
    assert hits[0]["when"].endswith("-11-12"), hits[0]


def test_an_empty_answer_is_retried_once_before_giving_up(monkeypatch):
    """모델이 이따금 글도 호출도 없는 답을 준다(실제로 겪었다).

    예전에는 그대로 "응답을 생성하지 못했습니다"를 내밀어 사용자가 같은 말을 다시
    쳐야 했다. 사람이 할 일을 서버가 한다 — 한 번만 다시 부른다.
    """
    from backend.ai import orchestrator
    from backend.ai.orchestrator import LLMResult, _empty_answer_note

    _login()

    class EmptyThenFine:
        def __init__(self):
            self.n = 0

        def chat(self, contents, catalog, system):
            self.n += 1
            if self.n == 1:
                return LLMResult(text="", tool_use=None, finish_reason="STOP")
            return LLMResult(text="두 번째에 제대로 답했습니다.", tool_use=None)

    llm = EmptyThenFine()
    monkeypatch.setattr(orchestrator, "GeminiLLM", lambda settings, model="": llm)
    client.delete("/api/ai/space/assistant")
    r = client.post("/api/ai/chat", json={"message": "안녕", "mode": "assistant"})
    events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    assert next(e for e in events if e["type"] == "text")["text"] == "두 번째에 제대로 답했습니다."
    assert llm.n == 2, llm.n            # 한 번만 더 부른다
    # 한 단계 안에서 다시 부른 것이지 단계를 쓴 것이 아니다(대화도 한 벌만 남는다)
    msgs = client.get("/api/ai/space/assistant").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"], msgs

    class AlwaysEmpty:
        def __init__(self):
            self.n = 0

        def chat(self, contents, catalog, system):
            self.n += 1
            return LLMResult(text="", tool_use=None, finish_reason="SAFETY")

    llm2 = AlwaysEmpty()
    monkeypatch.setattr(orchestrator, "GeminiLLM", lambda settings, model="": llm2)
    client.delete("/api/ai/space/assistant")
    r = client.post("/api/ai/chat", json={"message": "안녕", "mode": "assistant"})
    events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    text = next(e for e in events if e["type"] == "text")["text"]
    assert "안전 필터" in text, text        # 왜 막혔는지 말해 준다
    assert llm2.n == 2, llm2.n            # 끝없이 다시 부르지 않는다

    # 이유별 안내
    assert "안전 필터" in _empty_answer_note("SAFETY")
    assert "잘렸습니다" in _empty_answer_note("MAX_TOKENS")
    assert "요약해" in _empty_answer_note("RECITATION")
    assert _empty_answer_note("") == "응답을 생성하지 못했습니다. 다시 말씀해 주세요."


def test_a_stopped_turn_records_what_it_already_did():
    """중단된 차례는 '무엇까지 했는지'를 남겨야 다음 차례가 두 번 하지 않는다."""
    from backend.routers.ai import _stopped_note

    assert _stopped_note("", []) == ""              # 남길 것이 없으면 안 남긴다
    assert _stopped_note("", [{"name": "list_todos", "ok": False}]) == ""
    only_text = _stopped_note("조선 전기는", [])
    assert only_text.startswith("조선 전기는") and "멈췄습니다" in only_text

    did = _stopped_note("", [{"name": "create_todo", "ok": True},
                             {"name": "create_todo", "ok": True},
                             {"name": "list_todos", "ok": True},
                             {"name": "delete_todo", "ok": False}])
    assert "create_todo×2" in did and "list_todos" in did, did
    assert "delete_todo" not in did, did       # 실패한 것은 '끝낸 일'이 아니다
    assert "다시 하지 마세요" in did, did


def test_streaming_failure_does_not_become_an_answer(monkeypatch):
    """스트림 도중 끊기면 '오류'로 알린다 — 반쯤 온 글을 답으로 저장하면 안 된다."""
    from backend.ai import orchestrator

    _login()

    from backend.ai.orchestrator import LLMResult

    class BrokenLLM:
        """진짜 GeminiLLM 처럼, 끊긴 스트림은 예외가 아니라 error 로 돌려준다."""

        def stream(self, contents, catalog, system):
            yield "여기까지 쓰다가"
            return LLMResult(text="", tool_use=None,
                             error="upstream 503 /srv/key-AIzaSyDEADBEEF")

    monkeypatch.setattr(orchestrator, "GeminiLLM", lambda settings, model="": BrokenLLM())
    monkeypatch.setattr(get_settings(), "debug", False, raising=False)
    client.delete("/api/ai/space/assistant")
    r = client.post("/api/ai/chat", json={"message": "길게 설명해줘", "mode": "assistant"})
    assert r.status_code == 200, r.text
    events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    err = next(e for e in events if e["type"] == "error")
    assert "AIzaSy" not in err["message"] and "/srv/" not in err["message"], err
    assert not [e for e in events if e["type"] == "text"]
    # 반쯤 온 글은 저장하지 않는다(다음 차례의 맥락으로 들어가면 안 된다)
    msgs = client.get("/api/ai/space/assistant").json()["messages"]
    assert [m["role"] for m in msgs] == ["user"], msgs


if __name__ == "__main__":
    # 손으로 적은 호출 목록이었다. 목록이 파일 중간에 있어서 그 아래에 새로 쓴
    # 테스트는 하나도 돌지 않았는데(100개 중 54개만), 끝에 "ALL SMOKE TESTS PASSED"
    # 를 찍어 다 통과한 것처럼 보였다. 이제 모듈 안의 test_* 를 전부 찾아 돌리고,
    # 못 돌린 것(pytest 픽스처가 필요한 것)은 숨기지 않고 센다.
    import inspect
    import sys as _sys

    _mod = _sys.modules[__name__]
    _ran = _failed = _skipped = 0
    for _name, _fn in list(vars(_mod).items()):
        if not _name.startswith("test_") or not callable(_fn):
            continue
        if inspect.signature(_fn).parameters:
            _skipped += 1  # monkeypatch 등 픽스처가 필요하다
            continue
        try:
            _fn()
            _ran += 1
        except Exception as _e:  # noqa: BLE001 - 무엇이 깨졌는지 그대로 보여준다
            _failed += 1
            print(f"FAIL {_name}: {type(_e).__name__}: {_e}")
    print(f"{_ran}개 통과, {_failed}개 실패, {_skipped}개 건너뜀")
    if _skipped:
        print("전부 돌리려면: python -m pytest backend/test_smoke.py")
    raise SystemExit(1 if _failed else 0)
