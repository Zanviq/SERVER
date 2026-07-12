"""AI 문서 시스템(aidoc) 테스트. assert 함수 + __main__ 러너."""
import os, tempfile, json

os.environ["STORAGE_ROOT"] = tempfile.mkdtemp(prefix="aidoc_test_")
os.environ["AUTH_USERS"] = json.dumps([{"username": "tester", "password": "pw", "display_name": "T"}])
os.environ["SESSION_SECRET"] = "aidoc-test-secret"
os.environ["DOCUMENT_ROOT"] = os.path.join(os.environ["STORAGE_ROOT"], "AI_documents")
os.environ["AIDOC_DB_PATH"] = os.path.join(os.environ["STORAGE_ROOT"], "aidoc", "documents.db")
os.environ["AIDOC_TOKENS_FILE"] = os.path.join(os.environ["STORAGE_ROOT"], "aidoc", "tokens.json")
os.environ["AIDOC_PROJECTS"] = "orchestra-room,nodi"

from backend.config import Settings  # noqa: E402


def test_settings_aidoc():
    s = Settings()
    assert s.document_root.name == "AI_documents"
    assert str(s.aidoc_db_path).endswith("documents.db")
    assert s.aidoc_projects == ["orchestra-room", "nodi"]
    assert s.aidoc_max_bytes == 1048576


def test_ids():
    from backend.aidoc.ids import new_document_id, safe_slug, unique_filename
    a, b = new_document_id(), new_document_id()
    assert a.startswith("doc_") and len(a) == 30 and a != b
    assert a[4:14] <= b[4:14]  # 시간정렬(ms 타임스탬프 prefix 단조 증가; 랜덤 접미사는 무관)
    assert safe_slug("API 설계/문서: v2!") == "api-설계-문서-v2"
    assert safe_slug("   ") == "untitled"
    assert unique_filename("inbox", "note", set()) == "note.md"
    assert unique_filename("inbox", "note", {"note.md"}) == "note-2.md"


def test_errors():
    from backend.aidoc.errors import VersionConflict, NotFound
    e = VersionConflict(4, 5)
    assert e.status == 409 and e.code == "DOCUMENT_VERSION_CONFLICT"
    assert e.extra == {"expected_version": 4, "current_version": 5}
    assert NotFound("x").status == 404


def test_paths():
    from backend.config import Settings
    from backend.aidoc import paths
    from backend.aidoc.errors import BadRequest
    s = Settings()
    paths.ensure_layout(s)
    for f in ("inbox", "projects", "knowledge", "templates", "archive", "trash", ".history"):
        assert (s.document_root / f).is_dir()
    assert paths.new_doc_dir(s, None) == "inbox"
    assert paths.new_doc_dir(s, "orchestra-room") == "projects/orchestra-room"
    try:
        paths.new_doc_dir(s, "not-registered"); assert False
    except BadRequest:
        pass
    # 경로 탈출 차단
    try:
        paths.resolve_rel(s, "../../etc/passwd"); assert False
    except Exception:
        pass


if __name__ == "__main__":
    test_settings_aidoc()
    test_ids()
    test_errors()
    test_paths()
    print("ALL AIDOC TESTS PASSED")
