"""기본 동작 스모크 테스트. 인증 + 파일 + 시스템 검증."""
import io
import json
import os
import tempfile

os.environ["STORAGE_ROOT"] = tempfile.mkdtemp(prefix="twoems_test_")
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


def test_notes_wikilinks_and_graph():
    _login()
    client.put("/api/notes/save?scope=me", json={"path": "A", "content": "see [[B]] and [[C|alias]]"})
    client.put("/api/notes/save?scope=me", json={"path": "B", "content": "back to [[A]]"})
    client.put("/api/notes/save?scope=me", json={"path": "C", "content": "leaf"})
    # A의 outgoing 링크 + backlinks
    a = client.get("/api/notes/get?scope=me&path=A").json()
    assert set(a["links"]) == {"B", "C"}
    assert a["backlinks"] == ["B"]  # B가 A를 가리킴
    # 그래프: 노드 3, 링크 A->B, A->C, B->A
    g = client.get("/api/notes/graph?scope=me").json()
    assert len(g["nodes"]) == 3
    pairs = {(l["source"], l["target"]) for l in g["links"]}
    assert ("A", "B") in pairs and ("A", "C") in pairs and ("B", "A") in pairs


def test_scope_isolation():
    # tester가 개인(me) 스코프에 파일 업로드
    a = TestClient(app)
    a.post("/api/auth/login", json={"username": "tester", "password": "pw123"})
    r = a.post(
        "/api/files/upload?scope=me&path=",
        files={"file": ("secret.txt", io.BytesIO(b"mine"), "text/plain")},
    )
    assert r.status_code == 200, r.text
    mine = [e["name"] for e in a.get("/api/files/list?scope=me").json()["entries"]]
    assert "secret.txt" in mine

    # tester2의 me 스코프에는 tester의 파일이 보이면 안 됨
    b = TestClient(app)
    b.post("/api/auth/login", json={"username": "tester2", "password": "pw456"})
    other = [e["name"] for e in b.get("/api/files/list?scope=me").json()["entries"]]
    assert "secret.txt" not in other


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
    test_notes_wikilinks_and_graph()
    test_scope_isolation()
    print("ALL SMOKE TESTS PASSED")
