import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface DropdownProps {
  /** 여닫는 버튼. open 상태를 받아 모양을 바꿀 수 있다. */
  trigger: (open: boolean) => ReactNode;
  /** 패널 내용. 닫는 함수를 받는다(항목을 고르면 닫도록). */
  children: (close: () => void) => ReactNode;
  /** 패널 폭(px). 안 주면 내용만큼. */
  width?: number;
  align?: "start" | "end";
  disabled?: boolean;
  className?: string;
}

/**
 * 버튼 아래(자리가 없으면 위)에 뜨는 드롭다운.
 *
 * **포털로 body 에 그린다.** 카드 안에 absolute 로 두면 카드 바닥의 입력칸에서
 * 연 패널이 카드 밖으로 나가면서 부모의 overflow 에 잘린다(할 일 화면이 그렇다).
 * 위치는 버튼의 화면 좌표로 매번 계산하고, 스크롤·리사이즈에 따라간다.
 */
export function Dropdown({
  trigger, children, width, align = "start", disabled, className = "",
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);

  const close = useCallback(() => setOpen(false), []);

  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    const p = panelRef.current;
    if (!b || !p) return;
    const ph = p.offsetHeight;
    const pw = p.offsetWidth;
    const gap = 6;
    // 아래에 자리가 없고 위에 더 여유가 있으면 위로 편다
    const spaceBelow = window.innerHeight - b.bottom;
    const up = spaceBelow < ph + gap && b.top > spaceBelow;
    const top = up ? b.top - ph - gap : b.bottom + gap;
    let left = align === "end" ? b.right - pw : b.left;
    // 화면 밖으로 나가지 않게
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    setPos({ top: Math.max(8, top), left, up });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    // 스크롤하면 버튼이 움직이므로 따라가야 한다(닫아 버리면 date 입력의 달력을
    // 여는 순간 닫히는 브라우저가 있다)
    window.addEventListener("mousedown", onDown);
    window.addEventListener("touchstart", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("touchstart", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={className}
      >
        {trigger(open)}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            className="card fixed z-[60] max-h-[70vh] overflow-auto p-1.5 shadow-lg animate-in"
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width,
              // 위치를 아직 못 쟀을 때 잠깐 보이지 않게
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

/** 드롭다운 안의 한 줄 항목(공용 모양). */
export function DropdownItem({
  active, onClick, children, className = "",
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] ${
        active ? "bg-accent-muted text-accent-fg" : "text-fg hover:bg-hovered"
      } ${className}`}
    >
      {children}
    </button>
  );
}
