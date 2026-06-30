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
        <header className="flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-5 py-2.5">
          <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
          <div className="flex items-center gap-2">
            {actions}
            <SessionTimer />
            <ThemeToggle />
            <button
              onClick={logout}
              className="btn btn-ghost h-8 px-2"
              title={`${session?.display_name} 로그아웃`}
            >
              <LogOut size={15} />
            </button>
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
