import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  FolderOpen,
  NotebookPen,
  Share2,
  CalendarDays,
  Settings,
  User,
  Bot,
} from "lucide-react";
import { useAuth } from "../../store/auth";

const NAV = [
  { to: "/", icon: LayoutDashboard, label: "대시보드", end: true },
  { to: "/files", icon: FolderOpen, label: "파일" },
  { to: "/notes", icon: NotebookPen, label: "노트" },
  { to: "/graph", icon: Share2, label: "그래프" },
  { to: "/calendar", icon: CalendarDays, label: "캘린더" },
  { to: "/assistant", icon: Bot, label: "AI 비서" },
];

/** 데스크톱: 좌측 64px 아이콘 사이드바 (호버 툴팁 + aria-label) */
function DesktopItem({
  to,
  icon: Icon,
  label,
  end,
}: {
  to: string;
  icon: typeof User;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      title={label}
      className={({ isActive }) =>
        `group relative grid h-10 w-10 place-items-center rounded-md transition-colors ${
          isActive
            ? "bg-[var(--sidebar-icon-active)] text-sidebar-fg-active"
            : "text-sidebar-fg hover:bg-[var(--sidebar-icon)] hover:text-sidebar-fg-active"
        }`
      }
    >
      <Icon size={19} />
      <span className="pointer-events-none absolute left-[calc(100%+12px)] z-50 whitespace-nowrap rounded-sm bg-fg px-2 py-1 text-xs font-medium text-bg opacity-0 shadow-md transition-opacity group-hover:opacity-100">
        {label}
      </span>
    </NavLink>
  );
}

export function Sidebar() {
  const session = useAuth((s) => s.session);
  const initial = (session?.display_name || "?").charAt(0).toUpperCase();

  return (
    <>
      {/* 데스크톱 사이드바 */}
      <aside className="hidden w-16 shrink-0 flex-col items-center gap-1 border-r border-line/40 bg-sidebar py-3 sm:flex">
        <div className="mb-2 grid h-9 w-9 place-items-center rounded-md bg-[var(--sidebar-icon-active)] font-mono text-sm font-bold text-sidebar-fg-active">
          2M
        </div>
        <nav className="flex flex-1 flex-col items-center gap-1">
          {NAV.map((n) => (
            <DesktopItem key={n.to} {...n} />
          ))}
        </nav>
        <div className="flex flex-col items-center gap-1">
          <DesktopItem to="/settings" icon={Settings} label="설정" />
          <NavLink
            to="/profile"
            aria-label={`${session?.display_name} 프로필`}
            title={`${session?.display_name} · 프로필`}
            className="grid h-9 w-9 place-items-center rounded-full bg-accent text-[13px] font-bold text-accent-contrast"
          >
            {initial}
          </NavLink>
        </div>
      </aside>

      {/* 모바일 하단 탭바 (라벨 표시) */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-line bg-sidebar px-1 py-1 sm:hidden">
        {[...NAV, { to: "/settings", icon: Settings, label: "설정" }, { to: "/profile", icon: User, label: "프로필" }].map(
          (n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={(n as { end?: boolean }).end}
              aria-label={n.label}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center gap-0.5 rounded-md py-1.5 text-[10px] transition-colors ${
                  isActive ? "text-sidebar-fg-active" : "text-sidebar-fg"
                }`
              }
            >
              <n.icon size={18} />
              <span className="truncate">{n.label}</span>
            </NavLink>
          ),
        )}
      </nav>
    </>
  );
}
