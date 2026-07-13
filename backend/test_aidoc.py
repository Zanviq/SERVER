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


def test_search_special_chars_safe():
    """FTS5 특수문자/예약어/불균형 따옴표가 예외 없이 안전하게 처리되는지."""
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("t")
    service.create(s, a, CreateDoc(title="검색 안전성 문서", content="colon quote paren test",
                                   project="nodi"))
    dangerous = ['project:home "unclosed AND', 'a AND b OR NOT c', 'C++', '"', '-foo',
                 '*', 'x:y', '()', 'NEAR(a b)', '\\', "''", 'a"b']
    for q in dangerous:
        res = service.search(s, q)
        assert isinstance(res, list)  # 어떤 입력에도 크래시 없음
    assert service.search(s, "") == []       # 빈 쿼리
    assert service.search(s, "   ") == []     # 공백만
    # 정상 토큰은 여전히 매칭(본문 색인)
    hits = service.search(s, "colon")
    assert any(h["title"] == "검색 안전성 문서" for h in hits)


def test_append_concurrent_no_loss():
    """동시 append가 스냅샷 경쟁으로 쓰기를 잃지 않는지(임계구역 내 재계산 + 재시도)."""
    import threading
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc, AppendDoc
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("t")
    did = service.create(s, a, CreateDoc(title="concat", content="", project="nodi"))["id"]
    n = 5
    errors = []

    def worker(i):
        try:
            service.append(s, a, did, AppendDoc(content=f"L{i}\n"))
        except Exception as e:  # noqa: BLE001
            errors.append((i, repr(e)))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors
    final = service.get(s, did)["content"]
    for i in range(n):
        assert f"L{i}\n" in final, f"lost L{i}: {final!r}"  # 모든 append 보존
    assert service.get(s, did)["version"] == n + 1  # v1(생성) + n회 append


def test_embeddings_math():
    from backend.aidoc import embeddings as E
    assert E.unpack(E.pack([3.0, 4.0])) == [3.0, 4.0]  # float32 왕복(정확값)
    n = E.normalize([3.0, 4.0])
    assert abs((n[0] ** 2 + n[1] ** 2) - 1.0) < 1e-6  # 단위길이
    assert abs(E.dot([1.0, 0.0], [1.0, 0.0]) - 1.0) < 1e-9
    assert abs(E.dot(E.normalize([1.0, 1.0]), E.normalize([1.0, 1.0])) - 1.0) < 1e-6
    assert E.normalize([0.0, 0.0]) == [0.0, 0.0]  # 영벡터 안전


def test_semantic_search_ranking():
    """가짜 임베더 주입 → 의미가 가까운 문서가 상위. 임베딩 불가 시 FTS 폴백."""
    from backend.config import Settings
    from backend.aidoc import db, paths, service, embeddings
    from backend.aidoc.schemas import CreateDoc
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("t")
    vocab = ("gpu", "cuda", "database", "sql")
    orig = embeddings.embed_text
    embeddings.embed_text = lambda st, t: [float((t or "").lower().count(w)) for w in vocab]
    try:
        d1 = service.create(s, a, CreateDoc(title="GPU 커널", content="gpu cuda kernel tuning", project="nodi"))
        d2 = service.create(s, a, CreateDoc(title="DB 인덱스", content="database sql index", project="nodi"))
        res = service.semantic_search(s, "cuda gpu programming", limit=5)
        ids = [r["id"] for r in res]
        assert d1["id"] in ids and d2["id"] in ids
        assert ids[0] == d1["id"]  # GPU 문서가 1위
        assert "score" in res[0] and res[0]["score"] >= res[-1]["score"]
    finally:
        embeddings.embed_text = orig
    # 임베딩 불가(키 없음) → FTS 폴백(예외 없이 리스트)
    assert isinstance(service.semantic_search(s, "gpu", limit=5), list)


def test_aidoc_folders():
    """프로젝트 하위 폴더 생성 + 폴더 지정 생성 + 폴더로 이동 + 폴더 목록."""
    from backend.config import Settings
    from backend.aidoc import db, paths, service
    from backend.aidoc.schemas import CreateDoc
    from backend.aidoc.errors import BadRequest
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("t")
    # 폴더 생성
    res = service.create_folder(s, "nodi", "설계/초안")
    assert res["folder"] == "projects/nodi/설계/초안"
    assert (s.document_root / "projects/nodi/설계/초안").is_dir()
    # 폴더 지정 생성 → storage_path에 하위폴더 반영
    d = service.create(s, a, CreateDoc(title="폴더문서", content="x", project="nodi", folder="설계/초안"))
    assert d["storage_path"] == "projects/nodi/설계/초안/폴더문서.md"
    # 경로 조작 폴더 차단
    try:
        service.create_folder(s, "nodi", "../../etc"); assert False
    except BadRequest:
        pass
    # inbox 문서를 프로젝트 하위 폴더로 이동
    d2 = service.create(s, a, CreateDoc(title="이동대상", content="y"))  # inbox
    moved = service.move(s, a, d2["id"], target_folder="projects/nodi/설계")
    assert moved["storage_path"].startswith("projects/nodi/설계/") and moved["project"] == "nodi"
    # 폴더 목록에 생성한 폴더 포함
    folders = service.list_folders(s, project="nodi")
    assert "설계" in folders and "설계/초안" in folders


def test_aidoc_graph():
    """그래프: 노드=문서, 엣지=임베딩 유사도 + [[제목]] 링크."""
    from backend.config import Settings
    from backend.aidoc import db, paths, service, embeddings, graph
    from backend.aidoc.schemas import CreateDoc
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    a = service.Actor("t")
    vocab = ("alpha", "beta", "gamma")
    orig = embeddings.embed_text
    embeddings.embed_text = lambda st, t: [float((t or "").lower().count(w)) for w in vocab]
    try:
        g1 = service.create(s, a, CreateDoc(title="GraphAlpha", content="alpha alpha alpha", project="nodi"))
        service.create(s, a, CreateDoc(title="GraphAlpha2", content="alpha alpha", project="nodi"))
        # 본문에 [[GraphAlpha]] 링크
        service.create(s, a, CreateDoc(title="GraphLinker", content="beta [[GraphAlpha]] 참조", project="nodi"))
        gr = graph.build_graph(s, project="nodi", threshold=0.5, max_edges=4)
        node_ids = {n["id"] for n in gr["nodes"]}
        assert g1["id"] in node_ids and len(gr["nodes"]) >= 3
        kinds = {l["kind"] for l in gr["links"]}
        assert "similar" in kinds  # 알파 문서끼리 유사도 엣지
        assert any(l["kind"] == "link" and l["target"] == g1["id"] for l in gr["links"])  # [[링크]] 엣지
    finally:
        embeddings.embed_text = orig


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
    # 잘못된 기대버전 → 409, 그리고 충돌 시 파일이 손상되지 않아야 함
    try:
        service.update(s, a, doc["id"], UpdateDoc(expected_version=1, content="three\n")); assert False
    except VersionConflict as e:
        assert e.extra == {"expected_version": 1, "current_version": 2}
    assert service.get(s, doc["id"])["content"] == "two\n"  # 충돌은 파일을 건드리지 않음
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
    # 웹 UI(AidocWorkspace)가 쓰는 보조 엔드포인트
    assert "nodi" in c.get("/api/aidoc/projects").json()
    assert isinstance(c.get("/api/aidoc/audit-logs").json(), list)
    assert c.get(f"/api/aidoc/documents/{did}/history").status_code == 200
    # 웹 검색이 특수문자 입력에도 500이 아니라 200(빈/결과 리스트)
    r = c.get("/api/aidoc/documents/search", params={"q": 'a:b "c AND'})
    assert r.status_code == 200 and isinstance(r.json(), list)
    # Phase A/B 엔드포인트 배선 확인
    assert c.get("/api/aidoc/documents/semantic-search", params={"q": "hi"}).status_code == 200
    assert c.post("/api/aidoc/reindex").status_code == 200
    gr = c.get("/api/aidoc/graph")
    assert gr.status_code == 200 and "nodes" in gr.json() and "links" in gr.json()
    # 폴더 생성/목록
    assert c.post("/api/aidoc/folders", json={"project": "nodi", "path": "웹폴더"}).status_code == 200
    assert "웹폴더" in c.get("/api/aidoc/folders", params={"project": "nodi"}).json()

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


def _mcp_setup():
    import hashlib, json, os
    from backend.config import Settings
    from backend.aidoc import db, paths, tokens
    s = Settings(); db.init_db(s); paths.ensure_layout(s)
    raw = "mcp-tok"
    os.makedirs(os.path.dirname(s.aidoc_tokens_file), exist_ok=True)
    json.dump([{"name": "claude", "token_sha256": hashlib.sha256(raw.encode()).hexdigest(),
                "actor": "claude-code",
                "scopes": ["documents:read", "documents:create", "documents:update",
                           "documents:append", "documents:move", "documents:trash"],
                "allowed_projects": ["nodi"]}], open(s.aidoc_tokens_file, "w"))
    tokens.reload_cache()
    return raw


def test_mcp_handshake_and_tools():
    import json
    from fastapi.testclient import TestClient
    from backend.main import app
    raw = _mcp_setup()
    c = TestClient(app)
    h = {"Authorization": f"Bearer {raw}"}
    # 토큰 없음 → 401
    assert c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    # initialize
    r = c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize",
                             "params": {"protocolVersion": "2025-06-18", "capabilities": {}}}, headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["result"]["serverInfo"]["name"] == "aidoc"
    assert body["result"]["protocolVersion"] == "2025-06-18"
    assert "tools" in body["result"]["capabilities"]
    # notifications/initialized → 202, 본문 없음
    n = c.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=h)
    assert n.status_code == 202
    # tools/list → 11개 도구
    tl = c.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=h).json()
    names = {t["name"] for t in tl["result"]["tools"]}
    assert "create_document" in names and "search_documents" in names
    assert "semantic_search" in names
    assert len(tl["result"]["tools"]) == 12
    # 알 수 없는 메서드 → -32601
    err = c.post("/mcp", json={"jsonrpc": "2.0", "id": 3, "method": "no/such"}, headers=h).json()
    assert err["error"]["code"] == -32601


def test_mcp_tools_call_roundtrip():
    import json
    from fastapi.testclient import TestClient
    from backend.main import app
    raw = _mcp_setup()
    c = TestClient(app)
    h = {"Authorization": f"Bearer {raw}"}
    # create
    cr = c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                              "params": {"name": "create_document",
                                         "arguments": {"title": "MCP문서", "content": "본문",
                                                       "project": "nodi", "tags": ["x"]}}}, headers=h).json()
    assert cr["result"]["isError"] is False
    doc = json.loads(cr["result"]["content"][0]["text"])
    did = doc["id"]
    assert doc["version"] == 1 and doc["project"] == "nodi"
    # get
    g = c.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                             "params": {"name": "get_document", "arguments": {"document_id": did}}},
               headers=h).json()
    assert json.loads(g["result"]["content"][0]["text"])["content"] == "본문"
    # 권한 밖 프로젝트 생성 → isError 텍스트에 FORBIDDEN
    bad = c.post("/mcp", json={"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                               "params": {"name": "create_document",
                                          "arguments": {"title": "T", "project": "orchestra-room"}}},
                 headers=h).json()
    assert bad["result"]["isError"] is True
    assert "FORBIDDEN" in bad["result"]["content"][0]["text"]
    # 필수 인자 누락 → isError
    miss = c.post("/mcp", json={"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                                "params": {"name": "get_document", "arguments": {}}}, headers=h).json()
    assert miss["result"]["isError"] is True
    # 잘못된 타입 인자(expected_version 비정수) → 500이 아니라 JSON-RPC isError로
    r = c.post("/mcp", json={"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                             "params": {"name": "update_document",
                                        "arguments": {"document_id": did, "expected_version": "x", "content": "y"}}},
               headers=h)
    assert r.status_code == 200
    assert r.json()["result"]["isError"] is True


def _make_access_credentials(team: str, aud: str, *, exp_delta=300, iss=None):
    """테스트용 RSA 자체서명 인증서 + 서명된 Access JWT를 만든다.

    반환: (jwt_str, {kid: cert_pem}). 실제 Cloudflare 없이 검증 경로를 시험.
    """
    import datetime as dt
    import time
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    from google.auth import crypt, jwt as gjwt

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv_pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test-access")])
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(dt.datetime.utcnow() - dt.timedelta(days=1))
        .not_valid_after(dt.datetime.utcnow() + dt.timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode("utf-8")
    kid = "kid-test-1"
    signer = crypt.RSASigner.from_string(priv_pem, key_id=kid)
    now = int(time.time())
    payload = {"aud": aud, "iss": iss or f"https://{team}", "exp": now + exp_delta, "iat": now, "email": "m@x"}
    token = gjwt.encode(signer, payload)
    return (token.decode("utf-8") if isinstance(token, bytes) else token), {kid: cert_pem}


def test_cf_access_verify():
    import os
    from backend.config import Settings
    from backend.aidoc import cf_access
    team, aud = "testteam.cloudflareaccess.com", "aud-tag-123"
    os.environ["AIDOC_ACCESS_TEAM_DOMAIN"] = team
    os.environ["AIDOC_ACCESS_AUD"] = aud
    try:
        s = Settings()
        assert cf_access.enabled(s)
        good, certs = _make_access_credentials(team, aud)
        assert cf_access.verify(s, good, certs=certs) is not None  # 정상
        assert cf_access.verify(s, "", certs=certs) is None        # 빈 토큰
        # 잘못된 aud (다른 aud로 서명)
        bad_aud, c2 = _make_access_credentials(team, "other-aud")
        assert cf_access.verify(s, bad_aud, certs=c2) is None
        # 잘못된 iss
        bad_iss, c3 = _make_access_credentials(team, aud, iss="https://evil.example")
        assert cf_access.verify(s, bad_iss, certs=c3) is None
        # 만료
        expired, c4 = _make_access_credentials(team, aud, exp_delta=-10)
        assert cf_access.verify(s, expired, certs=c4) is None
        # 인증서 불일치(다른 키로 서명) → 서명 검증 실패
        other_tok, _ = _make_access_credentials(team, aud)
        assert cf_access.verify(s, other_tok, certs=certs) is None
    finally:
        os.environ.pop("AIDOC_ACCESS_TEAM_DOMAIN", None)
        os.environ.pop("AIDOC_ACCESS_AUD", None)


def test_cf_access_router_enforced():
    import os
    from fastapi.testclient import TestClient
    from backend.config import get_settings
    from backend.aidoc import cf_access
    from backend.main import app
    raw = _mcp_setup()
    team, aud = "testteam.cloudflareaccess.com", "aud-tag-123"
    os.environ["AIDOC_ACCESS_TEAM_DOMAIN"] = team
    os.environ["AIDOC_ACCESS_AUD"] = aud
    get_settings.cache_clear()  # 라우터의 Depends(get_settings)가 Access 설정을 보게
    cf_access.reset_cache()
    try:
        c = TestClient(app)
        h = {"Authorization": f"Bearer {raw}"}
        # Access 헤더 없음 → 403 (Bearer가 유효해도 Access 미통과)
        assert c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers=h).status_code == 403
        assert c.get("/mcp/api/documents", headers=h).status_code == 403
        # 유효한 Access JWT 주입(인증서 캐시 사전 주입) → Access 통과 후 정상 처리
        good, certs = _make_access_credentials(team, aud)
        import time as _t
        cf_access._cache[team] = (_t.time(), certs)
        h2 = {**h, "Cf-Access-Jwt-Assertion": good}
        assert c.get("/mcp/api/documents", headers=h2).status_code == 200
        pong = c.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "ping"}, headers=h2)
        assert pong.status_code == 200 and pong.json()["result"] == {}
    finally:
        os.environ.pop("AIDOC_ACCESS_TEAM_DOMAIN", None)
        os.environ.pop("AIDOC_ACCESS_AUD", None)
        cf_access.reset_cache()
        get_settings.cache_clear()


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
    test_search_special_chars_safe()
    test_embeddings_math()
    test_semantic_search_ranking()
    test_aidoc_folders()
    test_aidoc_graph()
    test_append_concurrent_no_loss()
    test_service_move_trash_restore()
    test_service_list_search()
    test_path_traversal_defense()
    test_routers_web_and_token()
    test_token_project_isolation()
    test_mcp_handshake_and_tools()
    test_mcp_tools_call_roundtrip()
    test_cf_access_verify()
    test_cf_access_router_enforced()
    print("ALL AIDOC TESTS PASSED")
