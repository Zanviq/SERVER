import { CheckCircle2, AlertTriangle } from "lucide-react";
import { useToast } from "../../store/toast";

export function Toaster() {
  const toasts = useToast((s) => s.toasts);
  return (
    // 모바일에서는 하단 탭바(약 53px + safe-area) 위로 띄운다. bottom-6(24px)이면
    // 탭바를 덮는데 z-60이라 위에 깔리고, 토스트가 떠 있는 동안 탭이 안 먹는다
    // (elementFromPoint로 '더보기' 자리에서 토스트가 잡히는 것을 확인했다).
    // pointer-events-none도 함께 — 토스트는 누를 일이 없으므로 절대 탭을 삼키면 안 된다.
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(4.25rem+env(safe-area-inset-bottom))]
        z-[60] flex flex-col items-end gap-2 px-4 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:px-0"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={`flex animate-in-right items-center gap-2 rounded-md border px-4 py-3 text-[13px] shadow-lg ${
            t.kind === "ok"
              ? "border-accent/30 bg-surface text-accent-fg"
              : "border-danger/30 bg-surface text-danger"
          }`}
        >
          {t.kind === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          {t.msg}
        </div>
      ))}
    </div>
  );
}
