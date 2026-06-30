import { ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: string;
}

export function Modal({ open, onClose, title, children, width = "max-w-lg" }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // 모달 열림 동안 배경 스크롤 잠금
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  // transform 가진 조상(애니메이션 패널) 안에서 fixed가 깨지지 않도록 body로 포탈
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-sm sm:p-6 md:p-10"
      onMouseDown={onClose}
    >
      <div
        className={`panel my-auto flex max-h-[92vh] w-full flex-col ${width} animate-fade-up`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && (
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3 sm:px-5">
            <h3 className="truncate font-display text-sm font-bold uppercase tracking-wider">
              {title}
            </h3>
            <button
              onClick={onClose}
              aria-label="닫기"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ash-500 hover:bg-white/5 hover:text-ash-100"
            >
              <X size={16} />
            </button>
          </header>
        )}
        <div className="scroll-y p-4 sm:p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
