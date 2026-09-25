import { ReactNode, useEffect, useRef } from "react";
import { useDismissable } from "../../lib/useDismissable";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** 화면 낭독기에 읽히는 이름. header 를 끄더라도 **이름은 남는다**. */
  title?: string;
  children: ReactNode;
  width?: string;
  /** 높이 클래스. 기본은 내용만큼(최대 92vh), 지도처럼 꽉 채울 것은 `h-[92vh]`. */
  height?: string;
  /**
   * 제목줄(제목 + 닫기)을 그릴까. 안쪽 내용이 **제 머리글을 이미 가진** 경우
   * (대화 지도처럼 검색·확대 단추가 한 줄에 있는 것)에는 끈다 — 두 줄이 겹치고
   * 닫기 단추가 둘이 된다.
   */
  chrome?: boolean;
  /**
   * 본문 칸의 클래스. 기본은 스크롤 + 여백이지만, 제 높이를 꽉 채워야 하는
   * 내용(지도·그래프)은 `flex min-h-0 flex-1 flex-col` 처럼 바꿔 준다.
   */
  bodyClass?: string;
}

/** 대화상자 **밖에서** 마지막으로 포커스를 가졌던 요소.
 *
 *  "열릴 때의 activeElement"를 효과 안에서 읽으면 안 된다. 안쪽 입력칸의
 *  `autoFocus` 는 리액트가 **커밋 중에** 실행하므로, 효과가 도는 시점엔 이미
 *  포커스가 대화상자 안이다(그래서 닫을 때 사라진 입력칸으로 되돌리려다
 *  포커스가 body 로 떨어졌다). 바깥에서 마지막으로 포커스를 받은 곳을 계속
 *  따라 두면 그 타이밍과 무관하다.
 *
 *  떠 있는 메뉴의 항목은 치지 않는다. 대화상자는 흔히 메뉴 항목("이름 변경")이 여는데, 그 항목은
 *  대화상자가 열리는 커밋에서 메뉴와 함께 사라진다 — 거기로 돌아가려다 포커스가 body 로 떨어졌다
 *  (39차: 키보드로 이름 변경을 열고 Esc). 그 앞의 자리, 곧 메뉴를 연 단추가 남는다. */
let lastOutsideDialog: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && !t.closest('[role="dialog"], [role="menu"]')) {
        lastOutsideDialog = t;
      }
    },
    true,
  );
}

export function Modal({
  open, onClose, title, children, width = "max-w-lg",
  height = "max-h-[92vh]", chrome = true, bodyClass = "overflow-y-auto p-4 sm:p-5",
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc 닫기 + 배경 스크롤 잠금은 바텀시트와 공유한다
  useDismissable(open, onClose);

  useEffect(() => {
    if (!open) return;
    // 닫고 나서 열기 전 자리로 돌려주지 않으면, 키보드만 쓰는 사람은 다음 Tab 이
    // 페이지 맨 위에서 다시 시작한다.
    const opener = lastOutsideDialog;
    // 열릴 때 첫 입력 요소로 포커스 이동
    const focusTimer = window.setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(
        "input, textarea, select, button:not([aria-label='닫기'])",
      );
      el?.focus();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
      // 한 박자 늦춘다. 포커스를 가진 요소가 DOM 에서 사라지면 브라우저가 focus 를
      // body 로 되돌리는데, 그 일이 이 정리 코드 뒤에 일어날 수 있다.
      if (opener) {
        window.setTimeout(() => {
          if (document.contains(opener)) opener.focus();
        }, 0);
      }
    };
  }, [open]);

  /** Tab 이 대화상자 밖으로 빠져나가지 않게 가둔다.
   *
   *  `aria-modal` 은 화면 낭독기에게만 뒤쪽을 감춘다. 키보드 Tab 은 그대로
   *  뒤 화면의 버튼으로 넘어가서, 보이지도 않는 곳에 포커스가 가 있게 된다
   *  (그 상태로 Enter 를 누르면 뒤에서 무슨 일이 일어난다). */
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const all = panelRef.current.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), textarea:not([disabled]), " +
      "input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    const list = Array.from(all).filter((el) => el.offsetParent !== null);
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey ? active === first : active === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--bg-overlay)] p-3 backdrop-blur-sm sm:p-6 md:p-10"
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`card my-auto flex w-full flex-col ${height} ${width} animate-in shadow-lg`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        {chrome && title && (
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
            <h3 className="truncate text-sm font-semibold">{title}</h3>
            <button
              onClick={onClose}
              aria-label="닫기"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-hovered hover:text-fg"
            >
              <X size={16} />
            </button>
          </header>
        )}
        <div className={bodyClass}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
