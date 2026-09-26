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
  const session = useAuth((s) => s.session);
  const logout = useAuth((s) => s.logout);
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 모바일에서는 테마·로그아웃을 "더보기" 시트로 옮겼다 — 좁은 폭에서 이것들이
            자리를 다 먹으면 페이지별 actions(업로드·받기 등)가 밀려난다. */}
        <header className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2.5 sm:gap-3 sm:px-5">
          {/* 제목은 줄이지 않고, 오른쪽 단추 글은 꺾지 않는다 — 320px 휴대폰에서 제목이 "문…", 단추 글이 "전체 받 / 기"·
              "대 / 화" 처럼 한 글자씩 꺾였다(디자인 37차). 좁은 화면(360px 미만)에서는 각 화면이 단추 글을 sr-only 로
              감춰 아이콘만 남긴다. */}
          <h1 className="shrink-0 text-base font-semibold tracking-tight">{title}</h1>
          <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
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
          {/* 폭을 1280px 로 묶어 두었다. 화면을 축소하면(=CSS 픽셀 폭이 커지면)
              내용은 그대로 1280px 인 채 남는 자리가 전부 좌우 여백이 되어, 넓게
              보려고 축소할수록 쓸 수 있는 자리가 줄어드는 꼴이었다. 이제 폭은
              화면을 따라가고, 좌우 여백은 위 여백과 같은 값으로 고정된다
              (md 이상에서 둘 다 32px). */}
          <div className="px-4 py-5 pb-24 sm:px-6 sm:pb-8 md:px-8 md:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
