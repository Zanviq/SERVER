import { CheckCircle2, AlertTriangle } from "lucide-react";
import { useToast } from "../../store/toast";

export function Toaster() {
  const toasts = useToast((s) => s.toasts);
  return (
    <div
      className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2"
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
