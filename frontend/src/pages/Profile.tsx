import { LogOut, Clock, User as UserIcon, Shield } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { useAuth } from "../store/auth";

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}분 ${sec % 60}초`;
}

export function Profile() {
  const { session, remaining, logout } = useAuth();
  const initial = (session?.display_name || "?").charAt(0).toUpperCase();
  return (
    <Shell title="프로필">
      <div className="mx-auto max-w-xl space-y-4">
        <div className="card flex items-center gap-4 p-6">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-accent text-2xl font-bold text-accent-contrast">
            {initial}
          </div>
          <div>
            <h2 className="text-lg font-bold">{session?.display_name}</h2>
            <p className="text-[13px] text-fg-muted">@{session?.username}</p>
          </div>
        </div>

        <div className="card divide-y divide-line">
          <div className="flex items-center gap-3 px-5 py-3">
            <UserIcon size={16} className="text-fg-muted" />
            <span className="flex-1 text-[13.5px]">아이디</span>
            <span className="font-mono text-[13px] text-fg2">{session?.username}</span>
          </div>
          <div className="flex items-center gap-3 px-5 py-3">
            <Clock size={16} className="text-fg-muted" />
            <span className="flex-1 text-[13.5px]">세션 남은 시간</span>
            <span className="font-mono text-[13px] text-accent">{fmt(remaining)}</span>
          </div>
          <div className="flex items-center gap-3 px-5 py-3">
            <Shield size={16} className="text-fg-muted" />
            <span className="flex-1 text-[13.5px]">인증 방식</span>
            <span className="text-[13px] text-fg2">.env 계정 (1시간 세션)</span>
          </div>
        </div>

        <button onClick={logout} className="btn btn-danger w-full">
          <LogOut size={15} /> 로그아웃
        </button>
      </div>
    </Shell>
  );
}
