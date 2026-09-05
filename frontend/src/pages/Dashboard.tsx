import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  NotebookPen, CalendarDays, Bot, FileText, Clock, ChevronRight, ListTodo, Languages,
} from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { SystemMonitor } from "../components/system/SystemMonitor";
import { SshCard } from "../components/system/SshCard";
import { api, NoteSummary, CalEvent, Todo } from "../lib/api";
import { useAuth } from "../store/auth";

const SHORTCUTS = [
  { to: "/notes", icon: NotebookPen, label: "노트", desc: "마크다운·위키링크" },
  { to: "/calendar", icon: CalendarDays, label: "캘린더", desc: "일정 관리" },
  { to: "/assistant", icon: Bot, label: "AI 비서", desc: "파일·일정 자동화" },
];

function fmtEvent(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ko-KR", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function Dashboard() {
  const name = useAuth((s) => s.session?.display_name);
  const navigate = useNavigate();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [events, setEvents] = useState<CalEvent[]>([]);
  // 아침에 열었을 때 바로 손이 가는 두 가지 — 오늘까지 해야 할 일과 복습할 단어.
  const [todos, setTodos] = useState<Todo[]>([]);
  const [due, setDue] = useState<number | null>(null);

  useEffect(() => {
    api.noteList()
      .then((list) => setNotes([...list].sort((a, b) => b.modified - a.modified).slice(0, 5)))
      .catch(() => {});
    const now = new Date();
    const to = new Date(now.getTime() + 30 * 86400000);
    // toISOString 은 **UTC** 로 바꾼다. 저장된 일정 시각은 현지 시각이라, 한국에서
    // 오후에 열면 9시간 앞선 값으로 조회되어 오늘 이미 끝난 일정이 '다가오는 일정'
    // 으로 떴다. 현지 시각 그대로 만든다.
    const p = (n: number) => String(n).padStart(2, "0");
    const iso = (d: Date) =>
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
      `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    api.calEvents(iso(now), iso(to))
      .then((evs) =>
        setEvents([...evs].sort((a, b) => a.start.localeCompare(b.start)).slice(0, 5)),
      )
      .catch(() => {});
    // 마감이 지났거나 오늘까지인 것만. 기한 없는 할 일은 "오늘 해야 하는 것"이
    // 아니라서 뺀다 — 그것까지 넣으면 목록이 길어져 오늘 것이 묻힌다.
    const today = iso(now).slice(0, 10);
    api.todoList({ include_done: false, to: today, include_undated: false })
      .then((list) => setTodos([...list].sort((a, b) => (a.due || "").localeCompare(b.due || "")).slice(0, 5)))
      .catch(() => {});
    api.vocabBoard()
      .then((b) => setDue(b.stats.due))
      .catch(() => {});
  }, []);

  return (
    <Shell title="대시보드">
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-bold tracking-tight">안녕하세요, {name}님 👋</h2>
          <p className="mt-0.5 text-[13px] text-fg-muted">오늘도 좋은 하루 되세요.</p>
        </div>

        <SystemMonitor />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {SHORTCUTS.map((s) => (
            <Link key={s.to} to={s.to} className="card card-hover flex flex-col gap-2 p-4">
              <div className="grid h-9 w-9 place-items-center rounded-md bg-accent-muted text-accent">
                <s.icon size={18} />
              </div>
              <div>
                <p className="text-sm font-semibold">{s.label}</p>
                <p className="text-[12px] text-fg-muted">{s.desc}</p>
              </div>
            </Link>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {/* 최근 노트 */}
          <section className="card overflow-hidden">
            <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <NotebookPen size={15} className="text-accent" /> 최근 노트
              </span>
              {/* 화살표는 작아도 누를 자리는 28px — 휴대폰에서 16px 은 못 맞춘다 */}
              <Link to="/notes" aria-label="노트 전체 보기"
                className="-mr-1 grid h-7 w-7 place-items-center text-fg-muted hover:text-accent">
                <ChevronRight size={16} />
              </Link>
            </header>
            <ul className="divide-y divide-line">
              {notes.map((n) => (
                <li key={n.path}>
                  <button onClick={() => navigate(`/notes?open=${encodeURIComponent(n.title)}`)}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-hovered">
                    <FileText size={14} className="shrink-0 text-fg-muted" />
                    <span className="truncate text-[13px]">{n.title}</span>
                  </button>
                </li>
              ))}
              {notes.length === 0 && (
                <li className="px-4 py-6 text-center text-[12px] text-fg-muted">노트가 없습니다</li>
              )}
            </ul>
          </section>

          {/* 다가오는 일정 */}
          <section className="card overflow-hidden">
            <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <CalendarDays size={15} className="text-accent" /> 다가오는 일정
              </span>
              <Link to="/calendar" aria-label="캘린더 전체 보기"
                className="-mr-1 grid h-7 w-7 place-items-center text-fg-muted hover:text-accent">
                <ChevronRight size={16} />
              </Link>
            </header>
            <ul className="divide-y divide-line">
              {events.map((e) => (
                <li key={e.id} className="flex items-center gap-2 px-4 py-2.5">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{e.title}</span>
                  <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-fg-muted">
                    <Clock size={11} /> {fmtEvent(e.start)}
                  </span>
                </li>
              ))}
              {events.length === 0 && (
                <li className="px-4 py-6 text-center text-[12px] text-fg-muted">예정된 일정이 없습니다</li>
              )}
            </ul>
          </section>

          {/* 오늘까지 할 일 — 기한 없는 것은 빼서 '오늘 것'이 묻히지 않게 한다 */}
          <section className="card overflow-hidden">
            <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <ListTodo size={15} className="text-accent" /> 오늘까지 할 일
              </span>
              <Link to="/todo" aria-label="할 일 전체 보기"
                className="-mr-1 grid h-7 w-7 place-items-center text-fg-muted hover:text-accent">
                <ChevronRight size={16} />
              </Link>
            </header>
            <ul className="divide-y divide-line">
              {todos.map((t) => {
                const late = !!t.due && t.due.slice(0, 10) < new Date().toISOString().slice(0, 10);
                return (
                  <li key={t.id} className="flex items-center gap-2 px-4 py-2.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${late ? "bg-danger" : "bg-warning"}`} />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{t.title}</span>
                    <span className={`shrink-0 font-mono text-[11px] ${late ? "text-danger" : "text-fg-muted"}`}>
                      {late ? "지남" : "오늘"}
                    </span>
                  </li>
                );
              })}
              {todos.length === 0 && (
                <li className="px-4 py-6 text-center text-[12px] text-fg-muted">오늘까지 할 일이 없습니다</li>
              )}
            </ul>
          </section>

          {/* 오늘 복습할 단어 — 개수만 보여 주고 누르면 단어장으로 */}
          <section className="card overflow-hidden">
            <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <Languages size={15} className="text-accent" /> 오늘 복습
              </span>
              <Link to="/english" aria-label="영어 학습으로"
                className="-mr-1 grid h-7 w-7 place-items-center text-fg-muted hover:text-accent">
                <ChevronRight size={16} />
              </Link>
            </header>
            <div className="px-4 py-5 text-center">
              {due === null ? (
                <p className="text-[12px] text-fg-muted">불러오는 중…</p>
              ) : due === 0 ? (
                <p className="text-[12px] text-fg-muted">오늘 복습할 단어가 없습니다</p>
              ) : (
                <>
                  <p className="text-2xl font-bold tracking-tight">{due}<span className="ml-1 text-sm font-normal text-fg-muted">개</span></p>
                  <button onClick={() => navigate("/english?review=1")}
                    className="btn btn-primary mt-3 h-8 px-3 text-[12.5px]">복습하러 가기</button>
                </>
              )}
            </div>
          </section>
        </div>

        {/* 외부 SSH 접속 — 대시보드는 주인 전용이라 여기에만 둔다 */}
        <SshCard />
      </div>
    </Shell>
  );
}
