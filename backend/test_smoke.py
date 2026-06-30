"""기본 동작 스모크 테스트. STORAGE_ROOT를 임시폴더로 두고 검증."""
import io
import os
import tempfile

os.environ["STORAGE_ROOT"] = tempfile.mkdtemp(prefix="twoems_test_")

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

client = TestClient(app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_system():
    r = client.get("/api/system")
    assert r.status_code == 200
    body = r.json()
    assert "cpu_percent" in body and "mem_percent" in body


def test_file_lifecycle():
    # 빈 목록
    r = client.get("/api/files/list")
    assert r.status_code == 200
    assert r.json()["entries"] == []

    # 폴더 생성
    r = client.post("/api/files/mkdir", json={"path": "docs"})
    assert r.status_code == 200

    # 업로드
    r = client.post(
        "/api/files/upload?path=docs",
        files={"file": ("hello.txt", io.BytesIO(b"hi twoems"), "text/plain")},
    )
    assert r.status_code == 200

    # 목록에 보이는지
    r = client.get("/api/files/list?path=docs")
    names = [e["name"] for e in r.json()["entries"]]
    assert "hello.txt" in names

    # 다운로드 내용 일치
    r = client.get("/api/files/download?path=docs/hello.txt")
    assert r.status_code == 200
    assert r.content == b"hi twoems"

    # 이름변경
    r = client.post(
        "/api/files/rename", json={"src": "docs/hello.txt", "dst": "docs/world.txt"}
    )
    assert r.status_code == 200

    # 삭제
    r = client.delete("/api/files/delete?path=docs/world.txt")
    assert r.status_code == 200


def test_path_traversal_blocked():
    r = client.get("/api/files/list?path=../../etc")
    assert r.status_code == 400
    r = client.delete("/api/files/delete?path=../secret")
    assert r.status_code == 400


def test_upload_illegal_filename_sanitized():
    # OS 금지 문자가 포함된 파일명도 500 없이 새니타이즈되어 저장돼야 한다.
    client.post("/api/files/mkdir", json={"path": "san"})
    r = client.post(
        "/api/files/upload?path=san",
        files={"file": ("re*port?.txt", io.BytesIO(b"x"), "text/plain")},
    )
    assert r.status_code == 200, r.text
    names = [e["name"] for e in client.get("/api/files/list?path=san").json()["entries"]]
    assert "re_port_.txt" in names
    # 정상 파일명은 변형 없이 저장.
    client.post(
        "/api/files/upload?path=san",
        files={"file": ("s-team.md", io.BytesIO(b"x"), "text/markdown")},
    )
    names = [e["name"] for e in client.get("/api/files/list?path=san").json()["entries"]]
    assert "s-team.md" in names


if __name__ == "__main__":
    test_health()
    test_system()
    test_file_lifecycle()
    test_path_traversal_blocked()
    test_upload_illegal_filename_sanitized()
    print("ALL SMOKE TESTS PASSED")
