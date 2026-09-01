import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  NotebookPen,
  Share2,
  CalendarDays,
  ListTodo,
  Settings,
  User,
  Bot,
  Trash2,
  TerminalSquare,
  MoreHorizontal,
} from "lucide-react";
import { useAuth } from "../../store/auth";
import { api } from "../../lib/api";
import { MoreSheet, SheetItem } from "./MoreSheet";

// 터미널 가용 여부 캐시. 계정별로 키를 둔다 —
// 모듈 전역 캐시로 두면 주인이 로그아웃한 뒤 같은 탭에서 가입 사용자가 로그인해도
// 이전 결과가 남아 터미널 탭이 그대로 보인다(로그아웃은 페이지를 새로고침하지 않는다).
let _termAvail: { user: string; p: Promise<boolean> } | null = null;
const terminalAvailable = (user: string): Promise<boolean> => {
  if (!_termAvail || _termAvail.user !== user) {
    _termAvail = { user, p: api.terminalStatus().then((s) => s.available).catch(() => false) };
  }
  return _termAvail.p;
};

// 대시보드는 서버 주인 전용(시스템 상태를 담고 있다) — 아래에서 걸러낸다.
// primary는 모바일 하단 탭에 직접 나오는 것. 나머지는 "더보기" 시트로 간다.
// 할 일이 늘면서 모바일 탭 4칸이 꽉 찼다. 대시보드는 주인 전용이고 매일 쓰는
// 화면이 아니라 더보기로 내린다 — 그러지 않으면 주인 계정에서 AI 비서가 탭바
// 밖으로 밀린다(실측). 데스크톱 레일에는 그대로 다 보인다.
const NAV = [
  { to: "/", icon: LayoutDashboard, label: "대시보드", end: true, ownerOnly: true },
  { to: "/notes", icon: NotebookPen, label: "문서", primary: true },
  { to: "/calendar", icon: CalendarDays, label: "캘린더", primary: true },
  { to: "/todo", icon: ListTodo, label: "할 일", primary: true },
  { to: "/assistant", icon: Bot, label: "AI 비서", primary: true },
  { to: "/graph", icon: Share2, label: "그래프" },
  { to: "/trash", icon: Trash2, label: "휴지통" },
];

/** 모바일 탭바에 직접 놓을 개수. 나머지 한 칸은 "더보기"가 쓴다. */
const MOBILE_TABS = 4;

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
  const [termAvail, setTermAvail] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const u = session?.username;
    if (!u) { setTermAvail(false); return; }
    let alive = true;
    terminalAvailable(u).then((v) => { if (alive) setTermAvail(v); });
    return () => { alive = false; };
  }, [session?.username]);

  // 데스크톱 레일과 모바일 탭바가 같은 배열을 두 번 렌더하므로,
  // JSX가 아니라 배열에서 걸러야 양쪽에 동시에 반영된다.
  const isOwner = session?.origin === "bootstrap" && session?.role === "admin";
  const visible = NAV.filter((n) => !n.ownerOnly || isOwner);
  const nav: SheetItem[] = termAvail
    ? [...visible, { to: "/terminal", icon: TerminalSquare, label: "터미널" }]
    : visible;

  // 모바일: primary 먼저 채우고, 모자라면(가입 사용자는 대시보드가 없다) 뒤에서 끌어온다.
  const primary = nav.filter((n) => (n as { primary?: boolean }).primary);
  const secondary = nav.filter((n) => !(n as { primary?: boolean }).primary);
  const tabs = [...primary, ...secondary].slice(0, MOBILE_TABS);
  const sheetItems: SheetItem[] = [
    ...[...primary, ...secondary].slice(MOBILE_TABS),
    { to: "/settings", icon: Settings, label: "설정" },
    { to: "/profile", icon: User, label: "프로필" },
  ];

  return (
    <>
      {/* 데스크톱 사이드바 */}
      <aside className="hidden w-16 shrink-0 flex-col items-center gap-1 border-r border-line/40 bg-sidebar py-3 sm:flex">
        <div className="mb-2 grid h-9 w-9 place-items-center rounded-md bg-[var(--sidebar-icon-active)] font-mono text-xs font-bold text-sidebar-fg-active">
          SV
        </div>
        <nav className="flex flex-1 flex-col items-center gap-1">
          {nav.map((n) => (
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

      {/* 모바일 하단 탭바 — 5칸을 폭에 맞춰 나눠 쓴다(잘리는 항목이 없어야 한다) */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-line bg-sidebar px-1 pb-[env(safe-area-inset-bottom)] pt-1 sm:hidden">
        {tabs.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            aria-label={n.label}
            className={({ isActive }) =>
              `flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md py-1.5 text-[10px] transition-colors ${
                isActive ? "text-sidebar-fg-active" : "text-sidebar-fg"
              }`
            }
          >
            <n.icon size={19} />
            <span className="w-full truncate px-0.5 text-center">{n.label}</span>
          </NavLink>
        ))}
        <button
          onClick={() => setMoreOpen(true)}
          aria-label="더보기"
          aria-expanded={moreOpen}
          className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md py-1.5 text-[10px] transition-colors ${
            moreOpen || sheetItems.some((n) => n.to === pathname) ? "text-sidebar-fg-active" : "text-sidebar-fg"
          }`}
        >
          <MoreHorizontal size={19} />
          <span className="w-full truncate px-0.5 text-center">더보기</span>
        </button>
      </nav>

      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} items={sheetItems} />
    </>
  );
}
