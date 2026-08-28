"""기본 동작 스모크 테스트. 인증 + 파일 + 시스템 검증."""
import io
import json
import os
import tempfile

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
    _login()
    client.put("/api/notes/save", json={"path": "A.md", "content": "see [[B]] and [[C|alias]]"})
    client.put("/api/notes/save", json={"path": "B.md", "content": "back to [[A]]"})
    client.put("/api/notes/save", json={"path": "C.md", "content": "leaf"})
    # A의 outgoing 링크 + backlinks
    a = client.get("/api/notes/get?path=A").json()
    assert set(a["links"]) == {"B", "C"}
    assert a["backlinks"] == ["B"]  # B가 A를 가리킴
    # 그래프: 노드 3, 링크 A->B, A->C, B->A
    g = client.get("/api/notes/graph").json()
    assert len(g["nodes"]) == 3
    pairs = {(l["source"], l["target"]) for l in g["links"]}
    assert ("A", "B") in pairs and ("A", "C") in pairs and ("B", "A") in pairs
    # 전문 검색: 내용("alias")으로 매칭
    hits = client.get("/api/notes/search?q=alias").json()
    assert any(h["title"] == "A" for h in hits)
    assert all("snippet" in h for h in hits)


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
    # 알림 due 엔드포인트 동작
    assert isinstance(client.get("/api/calendar/reminders?within=100000").json(), list)


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
    """Google 캘린더 부분 수정이 나머지 필드를 지우면 안 된다.

    회귀: update가 부분 payload를 그대로 _to_google에 넘겨 전체 본문을 만들었다.
    시작만 옮기면 summary/description이 ''로, colorId가 '2'로 덮이고 end가 start로
    무너졌으며, 제목만 바꾸면 p["start"]에서 KeyError(500)가 났다.
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

    # 시작만 이동 → 제목·설명·색 유지, 길이(1시간) 유지
    gc.update("evt1", {"start": "2026-09-15T15:00:00"})
    body = svc.events().last_body
    assert body["summary"] == "치과 진료", f"제목이 지워짐: {body}"
    assert body["description"] == "2층 접수", f"설명이 지워짐: {body}"
    assert body["colorId"] == "7", f"색이 초기화됨: {body}"
    assert body["end"]["dateTime"] == "2026-09-15T16:00:00", f"길이 유지 실패: {body}"

    # 제목만 수정 → 500이 아니라 정상 처리되고 시각은 그대로
    gc.update("evt1", {"title": "치과 재진"})
    body = svc.events().last_body
    assert body["summary"] == "치과 재진"
    assert body["start"]["dateTime"] == "2026-09-15T10:00:00", f"시각이 변경됨: {body}"
    assert body["end"]["dateTime"] == "2026-09-15T11:00:00", f"시각이 변경됨: {body}"


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


def test_terminal_status_gate():
    _login()
    st = client.get("/api/terminal/status").json()
    # 응답 형태 검증(값은 서버 .env에 의존하므로 형태만 확인)
    assert isinstance(st["enabled"], bool)
    assert isinstance(st["is_admin"], bool)
    assert isinstance(st["available"], bool)


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

    reg.dispatch("bulk_create_calendar_events", {"events": [
        {"title": f"e{i}", "start": f"2026-09-{(i % 28) + 1:02d}T10:00:00"}
        for i in range(_MAX_LIST + 20)
    ]}, ctx)
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

    # 목록은 대화용만 — 이미지/TTS/전사/로봇 모델이 섞이면 고르는 순간 비서가 망가진다
    listed = [m["id"] for m in ai_models.list_models(s)]
    assert listed, "목록이 비면 드롭다운이 빈칸이 된다"
    banned = ("-image", "-tts", "transcribe", "robotics", "computer-use", "omni")
    assert not [m for m in listed if any(b in m for b in banned)], listed
    assert all(m.startswith("gemini") for m in listed), listed
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

    # 없는 모델은 저장 자체를 막는다(저장되면 그 뒤 AI가 통째로 실패한다)
    bad = client.patch("/api/settings", json={"changes": {"ai": {"model": "gemini-없는모델"}}})
    assert bad.status_code == 400, bad.text
    assert client.get("/api/settings").json()["settings"]["ai"]["model"] == pick  # 그대로

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
    fr = reg.dispatch("find_free_slots", {"date": "2026-09-01", "duration_minutes": 60}, ctx)
    assert fr.ok and len(fr.data["free_slots"]) >= 1
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

    # 저장소 파일에 평문이 없다
    s = get_settings()
    raw = (s.storage_root / "accounts.json").read_text(encoding="utf-8")
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

    # 다른 사용자의 state로 콜백하면 403 (남의 계정에 내 구글을 붙일 수 없다)
    other = google_oauth.make_state("tester2", st)
    r = c.get(f"/api/google/callback?code=abc&state={other}", follow_redirects=False)
    assert r.status_code == 403, r.text

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
    test_notes_rename_and_move()
    test_notes_graph_cache()
    test_save_keeps_extension_verbatim()
    test_notes_folders_and_tree()
    test_trash_restore_flow()
    test_unified_document_space()
    test_google_allday_end_conversion()
    test_calendar_colors_names_and_prefs()
    test_calendar_list_default_window()
    test_calendar_list_date_only_end_is_inclusive()
    test_ai_notes_in_folders_are_usable()
    test_ai_deletes_go_to_trash()
    test_ai_find_free_slots_robustness()
    test_calendar_update_start_preserves_duration()
    test_google_partial_update_preserves_fields()
    test_google_recurrence_and_reminders_round_trip()
    test_terminal_status_gate()
    test_settings_get_patch()
    test_session_ttl_setting()
    test_calendar_recurrence_and_reminders()
    test_calendar_lifecycle()
    test_ai_react_chains_skills()
    test_ai_react_runs_all_parallel_calls()
    test_ai_can_undo_its_own_deletions()
    test_ai_model_selectable_in_settings()
    test_bulk_update_uses_one_batched_call()
    test_calendar_bulk_create_delete_and_trash_restore()
    test_calendar_color_filter_guardrails()
    test_bulk_update_calendar_events()
    test_ai_skill_catalog_and_ops()
    test_ai_blocks_sensitive_files()
    test_google_oauth_state_and_isolation()
    test_password_hashing()
    test_signup_requires_admin_approval()
    test_last_admin_cannot_lock_out()
    test_raw_serve_blocks_stored_xss()
    test_origin_backfill()
    test_owner_cannot_lock_themselves_out()
    test_system_stats_not_leaked_via_ai_skill()
    test_archive_survives_bad_files()
    test_owner_only_surfaces()
    test_settings_prunes_dead_keys()
    test_folder_archive_download()
    test_user_isolation()
    print("ALL SMOKE TESTS PASSED")
