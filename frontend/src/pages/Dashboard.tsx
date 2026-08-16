import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  NotebookPen, CalendarDays, Bot, FileText, Clock, ChevronRight,
} from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { SystemMonitor } from "../components/system/SystemMonitor";
import { api, NoteSummary, CalEvent } from "../lib/api";
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

  useEffect(() => {
    api.noteList()
      .then((list) => setNotes([...list].sort((a, b) => b.modified - a.modified).slice(0, 5)))
      .catch(() => {});
    const now = new Date();
    const to = new Date(now.getTime() + 30 * 86400000);
    const iso = (d: Date) => d.toISOString().slice(0, 19);
    api.calEvents(iso(now), iso(to))
      .then((evs) =>
        setEvents([...evs].sort((a, b) => a.start.localeCompare(b.start)).slice(0, 5)),
      )
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
              <Link to="/notes" className="text-fg-muted hover:text-accent"><ChevronRight size={16} /></Link>
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
              <Link to="/calendar" className="text-fg-muted hover:text-accent"><ChevronRight size={16} /></Link>
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
        </div>
      </div>
    </Shell>
  );
}
