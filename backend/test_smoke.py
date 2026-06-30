"""기본 동작 스모크 테스트. 인증 + 파일 + 시스템 검증."""
import io
import json
import os
import tempfile

os.environ["STORAGE_ROOT"] = tempfile.mkdtemp(prefix="twoems_test_")
os.environ["AUTH_USERS"] = json.dumps(
    [{"username": "tester", "password": "pw123", "display_name": "Tester"}]
)
os.environ["SESSION_SECRET"] = "test-secret-please-change"
os.environ["SESSION_TTL_SECONDS"] = "3600"
os.environ["DEBUG"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

client = TestClient(app)


def _login():
    r = client.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    assert r.status_code == 200, r.text
    return r


# ── 인증 ──
def test_unauthenticated_blocked():
    fresh = TestClient(app)
    assert fresh.get("/api/files/list").status_code == 401
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
    _login()
    assert client.get("/api/files/list").json()["entries"] == []
    assert client.post("/api/files/mkdir", json={"path": "docs"}).status_code == 200
    r = client.post(
        "/api/files/upload?path=docs",
        files={"file": ("hello.txt", io.BytesIO(b"hi twoems"), "text/plain")},
    )
    assert r.status_code == 200
    names = [e["name"] for e in client.get("/api/files/list?path=docs").json()["entries"]]
    assert "hello.txt" in names
    assert client.get("/api/files/download?path=docs/hello.txt").content == b"hi twoems"
    assert client.delete("/api/files/delete?path=docs/hello.txt").status_code == 200


def test_path_traversal_blocked():
    _login()
    assert client.get("/api/files/list?path=../../etc").status_code == 400


def test_upload_illegal_filename_sanitized():
    _login()
    client.post("/api/files/mkdir", json={"path": "san"})
    r = client.post(
        "/api/files/upload?path=san",
        files={"file": ("re*port?.txt", io.BytesIO(b"x"), "text/plain")},
    )
    assert r.status_code == 200, r.text
    names = [e["name"] for e in client.get("/api/files/list?path=san").json()["entries"]]
    assert "re_port_.txt" in names


if __name__ == "__main__":
    test_unauthenticated_blocked()
    test_login_and_session()
    test_wrong_password()
    test_logout()
    test_health()
    test_system()
    test_file_lifecycle()
    test_path_traversal_blocked()
    test_upload_illegal_filename_sanitized()
    print("ALL SMOKE TESTS PASSED")
