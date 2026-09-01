import { useEffect } from "react";

/**
 * 열려 있는 오버레이의 공통 동작: Esc로 닫기 + 뒤 배경 스크롤 잠금.
 *
 * 모달과 바텀시트가 같은 코드를 각자 들고 있었다. 한쪽만 고치면 다른 쪽이
 * 조용히 다르게 동작한다(실제로 스크롤 잠금 해제 시점이 어긋날 뻔했다).
 */
export function useDismissable(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
}
