import { ReactNode } from "react";
import { LogOut } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { SessionTimer } from "./SessionTimer";
import { ThemeToggle } from "./ThemeToggle";
import { useAuth } from "../../store/auth";

export function Shell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { session, logout } = useAuth();
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 모바일에서는 테마·로그아웃을 "더보기" 시트로 옮겼다 — 좁은 폭에서 이것들이
            자리를 다 먹으면 페이지별 actions(업로드·받기 등)가 밀려난다. */}
        <header className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2.5 sm:gap-3 sm:px-5">
          <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
          <div className="flex min-w-0 items-center gap-2">
            {actions}
            <SessionTimer />
            <div className="hidden items-center gap-2 sm:flex">
              <ThemeToggle />
              <button
                onClick={logout}
                className="btn btn-ghost h-8 px-2"
                title={`${session?.display_name} 로그아웃`}
              >
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[1280px] px-4 py-5 pb-24 sm:px-6 sm:pb-8 md:px-8 md:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
