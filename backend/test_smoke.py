"""기본 동작 스모크 테스트. 인증 + 파일 + 시스템 검증."""
import io
import json
import os
import tempfile

os.environ["STORAGE_ROOT"] = tempfile.mkdtemp(prefix="twomes_test_")
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
        files={"file": ("hello.txt", io.BytesIO(b"hi twomes"), "text/plain")},
    )
    assert r.status_code == 200
    names = [e["name"] for e in client.get("/api/files/list?path=docs").json()["entries"]]
    assert "hello.txt" in names
    assert client.get("/api/files/download?path=docs/hello.txt").content == b"hi twomes"
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
    # 전문 검색: 내용("alias")으로 매칭
    hits = client.get("/api/notes/search?scope=me&q=alias").json()
    assert any(h["title"] == "A" for h in hits)
    assert all("snippet" in h for h in hits)


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


def test_settings_get_patch():
    _login()
    s = client.get("/api/settings").json()
    assert s["settings"]["ai"]["tone"] == "assistant"
    client.patch("/api/settings", json={"changes": {"ai": {"tone": "friend"}}})
    after = client.get("/api/settings").json()
    assert after["settings"]["ai"]["tone"] == "friend"
    # 다른 기본값은 유지(병합)
    assert after["settings"]["calendar"]["default_view"] == "dayGridMonth"


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
    from backend.storage import notes_root
    from backend import calendar_store

    s = get_settings()
    user = SessionUser(username="tester", display_name="Tester", expires_at=0, remaining=0)

    class FakeLLM:
        def __init__(self):
            self.n = 0

        def chat(self, contents, catalog, system):
            self.n += 1
            if self.n == 1:
                return LLMResult(text="", tool_use={"name": "write_note", "args": {"scope": "me", "title": "plan", "content": "# plan\n[[meeting]]"}})
            if self.n == 2:
                return LLMResult(text="", tool_use={"name": "create_calendar_event", "args": {"title": "미팅", "start": "2026-07-05T10:00:00"}})
            return LLMResult(text="노트와 일정을 만들었습니다.", tool_use=None)

    events = list(orchestrator.run(user, s, "계획 노트 만들고 일정 잡아줘", "2026-07-01", llm=FakeLLM()))
    types = [e["type"] for e in events]
    assert types.count("tool_call") == 2  # 스킬 2개 연속 실행
    assert any(e["type"] == "text" and "일정" in e["text"] for e in events)
    # 실제 생성 확인 (사용자 스코프)
    assert (notes_root("me", user, s) / "plan.md").exists()
    assert any(ev["title"] == "미팅" for ev in calendar_store.list_events(user, s))


def test_ai_skill_catalog_and_ops():
    from backend.ai.skill_base import SkillContext
    from backend.ai.skill_registry import default_registry
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    reg = default_registry()
    catalog = reg.build_catalog()
    # 대량 스킬 등록 확인 (20개 이상)
    assert len(catalog) >= 20
    names = {c["name"] for c in catalog}
    for expected in ("delete_note", "append_note", "rename_note", "update_calendar_event",
                     "delete_calendar_event", "find_free_slots", "get_system_status", "move_path"):
        assert expected in names, expected

    ctx = SkillContext(
        user=SessionUser(username="tester", display_name="T", expires_at=0, remaining=0),
        settings=s,
    )
    # append_note → read_note 반영
    reg.dispatch("write_note", {"scope": "me", "title": "log", "content": "# log\n"}, ctx)
    reg.dispatch("append_note", {"scope": "me", "title": "log", "content": "라인2"}, ctx)
    r = reg.dispatch("read_note", {"scope": "me", "title": "log"}, ctx)
    assert "라인2" in r.data["content"]
    # delete_note
    assert reg.dispatch("delete_note", {"scope": "me", "title": "log"}, ctx).ok
    # find_free_slots (일정 없으면 근무시간 전체가 빈 시간)
    fr = reg.dispatch("find_free_slots", {"date": "2026-09-01", "duration_minutes": 60}, ctx)
    assert fr.ok and len(fr.data["free_slots"]) >= 1
    # get_system_status
    st = reg.dispatch("get_system_status", {}, ctx)
    assert st.ok and "cpu_percent" in st.data
    # 캘린더 update/delete 스킬
    ev = reg.dispatch("create_calendar_event", {"title": "회의", "start": "2026-09-02T10:00:00"}, ctx)
    eid = ev.data["event"]["id"]
    up = reg.dispatch("update_calendar_event", {"event_id": eid, "title": "수정회의"}, ctx)
    assert up.ok and up.data["event"]["title"] == "수정회의"
    assert reg.dispatch("delete_calendar_event", {"event_id": eid}, ctx).ok


def test_ai_blocks_sensitive_files():
    from backend.ai.skill_base import SkillContext
    from backend.ai.skills import ReadFile, ReadNote
    from backend.auth import SessionUser
    from backend.config import get_settings

    s = get_settings()
    ctx = SkillContext(
        user=SessionUser(username="tester", display_name="T", expires_at=0, remaining=0),
        settings=s,
    )
    r = ReadFile().run({"scope": "me", "path": "password.txt"}, ctx)
    assert r.ok is False and r.error_code == "blocked"
    r2 = ReadNote().run({"scope": "me", "title": "내 비밀번호"}, ctx)
    assert r2.ok is False and r2.error_code == "blocked"
    # .env는 텍스트 확장자에서 제외되어 AI가 읽지 못함
    from backend.gemini_client import TEXT_EXTENSIONS
    assert ".env" not in TEXT_EXTENSIONS


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
    test_settings_get_patch()
    test_calendar_recurrence_and_reminders()
    test_calendar_lifecycle()
    test_ai_react_chains_skills()
    test_ai_skill_catalog_and_ops()
    test_ai_blocks_sensitive_files()
    test_scope_isolation()
    print("ALL SMOKE TESTS PASSED")
