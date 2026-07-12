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


def test_db_init():
    from backend.config import Settings
    from backend.aidoc import db
    s = Settings()
    db.init_db(s)
    conn = db.connect(s)
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
    assert {"documents", "document_versions", "audit_logs", "documents_fts"} <= tables
    assert db.has_fts5(conn) is True
    conn.close()


def test_store_atomic_and_history():
    from backend.config import Settings
    from backend.aidoc import store, paths
    s = Settings(); paths.ensure_layout(s)
    rel = "inbox/x.md"
    store.write_new(s, rel, "v1\n")
    assert store.read(s, rel) == "v1\n"
    hrel = store.backup_and_write(s, "doc_TEST", rel, "v2\n", "v1\n", 1)
    assert store.read(s, rel) == "v2\n"
    assert store.read(s, hrel) == "v1\n"  # 이전본 보존
    assert hrel == ".history/doc_TEST/0001.md"


def test_audit():
    from backend.config import Settings
    from backend.aidoc import db, audit
    s = Settings(); db.init_db(s)
    conn = db.connect(s)
    audit.log(conn, "tester", "create_document", doc_id="doc_A", project="nodi", to_version=1)
    conn.commit()
    rows = audit.list_logs(conn, limit=10)
    assert rows[0]["action"] == "create_document" and rows[0]["actor"] == "tester"
    conn.close()


def test_tokens():
    import hashlib, json, os
    from backend.config import Settings
    from backend.aidoc import tokens
    s = Settings()
    raw = "secrettoken123"
    os.makedirs(os.path.dirname(s.aidoc_tokens_file), exist_ok=True)
    with open(s.aidoc_tokens_file, "w", encoding="utf-8") as f:
        json.dump([{"name": "codex-nodi", "token_sha256": hashlib.sha256(raw.encode()).hexdigest(),
                    "actor": "codex", "scopes": ["documents:read", "documents:create"],
                    "allowed_projects": ["nodi"]}], f)
    tokens.reload_cache()
    p = tokens.verify_bearer(s, raw)
    assert p and p.actor == "codex"
    assert p.can("documents:read") and not p.can("documents:trash")
    assert p.project_ok("nodi") and not p.project_ok("orchestra-room")
    assert p.project_ok(None)  # inbox 허용
    assert tokens.verify_bearer(s, "wrong") is None


def test_schemas():
    from backend.aidoc.schemas import CreateDoc, UpdateDoc
    c = CreateDoc(title="T", content="x", project="nodi")
    assert c.status == "draft" and c.tags == []
    u = UpdateDoc(expected_version=3, change_summary="s", content="y")
    assert u.expected_version == 3


def test_service_list_search():
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("claude-code")
    service.create(s, a, CreateDoc(title="WriteLock 처리", content="낙관적 잠금과 WriteLock 충돌", project="nodi", tags=["lock"]))
    service.create(s, a, CreateDoc(title="다른 문서", content="관계 없음", project="orchestra-room"))
    # 태그 필터로 격리(테스트들이 DB를 공유하므로 project만으로는 개수가 누적됨)
    lst = service.list_docs(s, project="nodi", tag="lock")
    assert len(lst) == 1 and lst[0]["title"] == "WriteLock 처리"
    hits = service.search(s, "WriteLock")
    assert any("WriteLock" in h["title"] or "WriteLock" in h["snippet"] for h in hits)
    assert "nodi" in service.list_projects(s)


def test_service_move_trash_restore():
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("claude-code")
    doc = service.create(s, a, CreateDoc(title="M", content="c\n"))  # inbox
    moved = service.move(s, a, doc["id"], target_project="nodi", target_folder=None)
    assert moved["storage_path"].startswith("projects/nodi/") and moved["project"] == "nodi"
    tr = service.trash(s, a, doc["id"])
    assert tr["trashed"] is True and tr["storage_path"].startswith("trash/")
    rs = service.restore(s, a, doc["id"], version=None)  # 휴지통 복원
    assert rs["trashed"] is False and rs["storage_path"].startswith("projects/nodi/")


def test_service_update_conflict_and_append():
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc, UpdateDoc, AppendDoc
    from backend.aidoc.errors import VersionConflict
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("claude-code")
    doc = service.create(s, a, CreateDoc(title="C", content="one\n", project="nodi"))
    up = service.update(s, service.Actor("codex"), doc["id"], UpdateDoc(expected_version=1, content="two\n", change_summary="교체"))
    assert up["version"] == 2 and up["content"] == "two\n"
    # 잘못된 기대버전 → 409
    try:
        service.update(s, a, doc["id"], UpdateDoc(expected_version=1, content="three\n")); assert False
    except VersionConflict as e:
        assert e.extra == {"expected_version": 1, "current_version": 2}
    # history 보존
    hist = service.get_history(s, doc["id"])
    assert any(h["version"] == 1 for h in hist)
    # append
    ap = service.append(s, a, doc["id"], AppendDoc(content="added"))
    assert ap["version"] == 3 and ap["content"].endswith("added")


def test_service_create_get():
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    actor = service.Actor("claude-code")
    doc = service.create(s, actor, CreateDoc(title="Nodi 설계", content="# Nodi\n본문", project="nodi", tags=["ai"]))
    assert doc["id"].startswith("doc_") and doc["version"] == 1
    assert doc["storage_path"].startswith("projects/nodi/")
    got = service.get(s, doc["id"])
    assert got["content"] == "# Nodi\n본문" and got["title"] == "Nodi 설계"
    # inbox (project 없음)
    d2 = service.create(s, actor, CreateDoc(title="임시", content="x"))
    assert d2["storage_path"].startswith("inbox/") and d2["project"] is None


def test_path_traversal_defense():
    """doc_id/target_folder를 통한 경로 조작이 도메인 계층에서 차단되는지."""
    from backend.config import Settings
    from backend.aidoc import db, paths, service, ids
    from backend.aidoc.schemas import CreateDoc
    from backend.aidoc.errors import NotFound, BadRequest
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("x")
    # id 형식 검증
    assert ids.is_document_id("doc_" + "0" * 26)
    assert not ids.is_document_id("../../etc/passwd")
    assert not ids.is_document_id("doc_short")
    # 조작 id는 NotFound(존재하지 않는 것으로 취급)
    for bad in ("../../../../etc/passwd", "..%2f..%2fx", "doc_/../x"):
        try:
            service.get(s, bad); assert False
        except NotFound:
            pass
        try:
            service.restore(s, a, bad, version=1); assert False
        except NotFound:
            pass
    # target_folder '..' 차단
    doc = service.create(s, a, CreateDoc(title="t", content="c"))
    try:
        service.move(s, a, doc["id"], target_folder="knowledge/../../../etc"); assert False
    except BadRequest:
        pass


def test_routers_web_and_token():
    import hashlib, json, os
    from fastapi.testclient import TestClient
    from backend.config import Settings
    from backend.aidoc import db, paths, tokens
    from backend.main import app
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    # 토큰 파일 준비
    raw = "tok-abc"
    os.makedirs(os.path.dirname(s.aidoc_tokens_file), exist_ok=True)
    json.dump([{"name": "codex-nodi", "token_sha256": hashlib.sha256(raw.encode()).hexdigest(),
                "actor": "codex", "scopes": ["documents:read", "documents:create", "documents:update"],
                "allowed_projects": ["nodi"]}], open(s.aidoc_tokens_file, "w"))
    tokens.reload_cache()

    # 세션(웹) 경로
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester", "password": "pw"})
    r = c.post("/api/aidoc/documents", json={"title": "웹문서", "content": "hi", "project": "nodi"})
    assert r.status_code == 200, r.text
    did = r.json()["id"]
    assert c.get(f"/api/aidoc/documents/{did}").json()["content"] == "hi"

    # 토큰(AI) 경로 — 헤더 인증
    h = {"Authorization": f"Bearer {raw}"}
    a = TestClient(app)
    cr = a.post("/mcp/api/documents", json={"title": "AI문서", "content": "x", "project": "nodi"}, headers=h)
    assert cr.status_code == 200, cr.text
    aid = cr.json()["id"]
    # 권한 밖 프로젝트 → 403
    bad = a.post("/mcp/api/documents", json={"title": "T", "content": "x", "project": "orchestra-room"}, headers=h)
    assert bad.status_code == 403
    # 버전 충돌 409
    a.put(f"/mcp/api/documents/{aid}", json={"expected_version": 1, "content": "y"}, headers=h)
    conflict = a.put(f"/mcp/api/documents/{aid}", json={"expected_version": 1, "content": "z"}, headers=h)
    assert conflict.status_code == 409 and conflict.json()["detail"]["error"] == "DOCUMENT_VERSION_CONFLICT"
    # 토큰 없음 → 401
    assert a.get("/mcp/api/documents").status_code == 401


def test_token_project_isolation():
    """교차 프로젝트 IDOR 방지: nodi 토큰이 orchestra-room 문서에 접근 못 함."""
    import hashlib, json, os
    from fastapi.testclient import TestClient
    from backend.config import Settings
    from backend.aidoc import db, paths, tokens
    from backend.main import app
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    raw = "tok-nodi-only"
    os.makedirs(os.path.dirname(s.aidoc_tokens_file), exist_ok=True)
    json.dump([{"name": "codex-nodi", "token_sha256": hashlib.sha256(raw.encode()).hexdigest(),
                "actor": "codex", "scopes": ["documents:read", "documents:create", "documents:update"],
                "allowed_projects": ["nodi"]}], open(s.aidoc_tokens_file, "w"))
    tokens.reload_cache()

    # 웹(admin 세션)으로 orchestra-room + inbox 문서 생성
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "tester", "password": "pw"})
    oid = c.post("/api/aidoc/documents", json={"title": "비밀", "content": "secret",
                                               "project": "orchestra-room"}).json()["id"]
    iid = c.post("/api/aidoc/documents", json={"title": "인박스", "content": "draft"}).json()["id"]

    h = {"Authorization": f"Bearer {raw}"}
    a = TestClient(app)
    # 직접 조회/수정/삭제/이력 → 403 (타 프로젝트)
    assert a.get(f"/mcp/api/documents/{oid}", headers=h).status_code == 403
    assert a.put(f"/mcp/api/documents/{oid}", json={"expected_version": 1, "content": "x"},
                 headers=h).status_code == 403
    assert a.get(f"/mcp/api/documents/{oid}/history", headers=h).status_code == 403
    # inbox(project 미지정) 문서도 스코프 토큰은 접근 불가 → 403
    assert a.get(f"/mcp/api/documents/{iid}", headers=h).status_code == 403
    # 목록/검색에 타 프로젝트·inbox 문서가 노출되지 않음
    lst = a.get("/mcp/api/documents", headers=h).json()
    assert all(d["project"] == "nodi" for d in lst)
    hits = a.get("/mcp/api/documents/search?q=secret", headers=h).json()
    assert all(d["project"] == "nodi" for d in hits)
    # 명시적으로 타 프로젝트 목록 요청 → 403
    assert a.get("/mcp/api/documents?project=orchestra-room", headers=h).status_code == 403
    # projects 목록도 허용된 것만
    assert a.get("/mcp/api/projects", headers=h).json() == ["nodi"]


if __name__ == "__main__":
    test_settings_aidoc()
    test_ids()
    test_errors()
    test_paths()
    test_db_init()
    test_store_atomic_and_history()
    test_audit()
    test_tokens()
    test_schemas()
    test_service_create_get()
    test_service_update_conflict_and_append()
    test_service_move_trash_restore()
    test_service_list_search()
    test_path_traversal_defense()
    test_routers_web_and_token()
    test_token_project_isolation()
    print("ALL AIDOC TESTS PASSED")
