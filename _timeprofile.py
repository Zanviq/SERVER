"""시간·파일시스템 접근 실측 — 어디가 진짜 느린가."""
import json, os, tempfile, time
from collections import Counter

os.environ["STORAGE_ROOT"] = tempfile.mkdtemp(prefix="tp_")
os.environ["AUTH_USERS"] = json.dumps([{"username": "tester", "password": "pw123"}])
os.environ["SESSION_SECRET"] = "x"
os.environ["SESSION_TTL_SECONDS"] = "3600"

from fastapi.testclient import TestClient
from backend.main import app

c = TestClient(app)
c.post("/api/auth/login", json={"username": "tester", "password": "pw123"})

# 현실적인 규모로 채운다
N_DOCS, N_TODOS, N_EVENTS = 200, 300, 200
for i in range(N_DOCS):
    folder = f"폴더{i % 10}/" if i % 3 else ""
    c.put("/api/notes/save", json={
        "path": f"{folder}문서{i}.md",
        "content": f"# 문서 {i}\n\n[[문서{(i+1) % N_DOCS}]] 참고\n" + ("내용 " * 200),
    })
cat = c.post("/api/todo/categories", json={"name": "루트"}).json()
subs = [c.post("/api/todo/categories", json={"name": f"하위{i}", "parent_id": cat["id"]}).json()
        for i in range(5)]
for i in range(N_TODOS):
    c.post("/api/todo/create", json={"title": f"할일{i}", "due": f"2026-09-{(i%28)+1:02d}",
                                     "all_day": True, "category_id": subs[i % 5]["id"]})
for i in range(N_EVENTS):
    c.post("/api/calendar/events", json={"title": f"일정{i}",
                                         "start": f"2026-09-{(i%28)+1:02d}T10:00:00"})

print(f"규모: 문서 {N_DOCS} · 할 일 {N_TODOS} · 일정 {N_EVENTS}")
print("=" * 78)
print("엔드포인트 응답 시간(5회 중앙값, ms)")
print("=" * 78)


def bench(label, fn, n=5):
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        r = fn()
        ts.append((time.perf_counter() - t0) * 1000)
    ts.sort()
    size = len(r.content) if hasattr(r, "content") else 0
    print(f"  {ts[len(ts)//2]:>7.1f} ms  {label:<40} ({size/1024:.0f} KB)")
    return ts[len(ts)//2]


bench("GET /api/notes/list", lambda: c.get("/api/notes/list"))
bench("GET /api/notes/tree", lambda: c.get("/api/notes/tree"))
bench("GET /api/notes/graph", lambda: c.get("/api/notes/graph"))
bench("GET /api/notes/graph (2번째=캐시)", lambda: c.get("/api/notes/graph"))
bench("GET /api/notes/search?query=문서1", lambda: c.get("/api/notes/search?query=문서1"))
bench("GET /api/todo/list", lambda: c.get("/api/todo/list"))
bench("GET /api/calendar/events(한 달)",
      lambda: c.get("/api/calendar/events?from=2026-09-01&to=2026-09-30"))
bench("GET /api/trash/list", lambda: c.get("/api/trash/list"))

print()
print("=" * 78)
print("AI 스킬 실행 시간(ms)")
print("=" * 78)
from backend.ai.skill_base import SkillContext
from backend.ai.skill_registry import default_registry
from backend.auth import SessionUser
from backend.config import get_settings

st = get_settings()
u = SessionUser(username="tester", display_name="T", expires_at=0, remaining=0)
ctx = SkillContext(user=u, settings=st, today="2026-09-01")
reg = default_registry()


def bench_skill(name, args, n=5):
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        r = reg.dispatch(name, args, ctx)
        ts.append((time.perf_counter() - t0) * 1000)
    ts.sort()
    print(f"  {ts[len(ts)//2]:>7.1f} ms  {name:<34} ok={r.ok}")


bench_skill("list_todos", {})
bench_skill("list_todo_categories", {})
bench_skill("list_documents", {})
bench_skill("search_documents", {"query": "내용"})
bench_skill("list_calendar_events", {"from_date": "2026-09-01", "to_date": "2026-09-30"})
