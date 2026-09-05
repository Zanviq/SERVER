import { useDismissable } from "../../lib/useDismissable";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import { LogOut, Search, User, X } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { openSearch } from "../search/SearchPalette";
import { useAuth } from "../../store/auth";

export interface SheetItem {
  to: string;
  icon: typeof User;
  label: string;
  end?: boolean;
}

/**
 * 모바일 하단 탭바의 "더보기" 시트.
 *
 * 탭바에 9개를 다 넣으면 좁은 화면에서 뒤쪽 항목이 잘려 나가고, 스크롤바를 숨겨
 * 놨던 탓에 가로로 밀 수 있다는 단서조차 없었다(설정·프로필이 아예 안 보였다).
 * 자주 쓰는 것만 탭으로 두고 나머지는 여기 모은다 — 항목이 늘어도 안 깨진다.
 */
export function MoreSheet({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: SheetItem[];
}) {
  const { session, logout } = useAuth();

  useDismissable(open, onClose);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-[var(--bg-overlay)] backdrop-blur-sm sm:hidden"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="더보기"
        className="animate-in rounded-t-2xl border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pt-3">
          <span className="text-sm font-semibold">더보기</span>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="grid h-9 w-9 place-items-center rounded-md text-fg-muted hover:bg-hovered hover:text-fg"
          >
            <X size={17} />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-1 px-3 py-3">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={onClose}
              className={({ isActive }) =>
                `flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-lg px-1 py-2 text-[11px] ${
                  isActive ? "bg-accent-muted text-accent-fg" : "text-fg-muted hover:bg-hovered"
                }`
              }
            >
              <n.icon size={20} />
              <span className="w-full truncate text-center">{n.label}</span>
            </NavLink>
          ))}
        </div>

        {/* 테마·로그아웃은 모바일 헤더에서 빼고 여기로 모았다(헤더가 너무 좁다) */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          {/* 휴대폰에는 Ctrl+K 가 없다 — 전역 검색으로 들어가는 유일한 문 */}
          <button
            onClick={() => { onClose(); openSearch(); }}
            className="btn btn-ghost h-9 gap-1.5 px-3 text-[13px]"
          >
            <Search size={15} /> 검색
          </button>
          <ThemeToggle />
          <button
            onClick={() => {
              onClose();
              logout();
            }}
            className="btn btn-ghost h-9 gap-1.5 px-3 text-[13px]"
            title={`${session?.display_name} 로그아웃`}
          >
            <LogOut size={15} /> 로그아웃
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
