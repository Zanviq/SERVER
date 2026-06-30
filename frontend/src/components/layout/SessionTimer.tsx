import { Clock } from "lucide-react";
import { useAuth } from "../../store/auth";
import { useSettings } from "../../store/settings";

function fmt(sec: number, showSeconds: boolean): string {
  const m = Math.floor(sec / 60);
  if (!showSeconds) return `${m}분`;
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function SessionTimer() {
  const remaining = useAuth((s) => s.remaining);
  const showSeconds = useSettings((s) => s.settings?.display.show_seconds_in_timer ?? true);
  const low = remaining < 300; // 5분 미만 경고
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs ${
        low ? "border-danger/40 text-danger" : "border-line text-fg-muted"
      }`}
      title="세션 남은 시간"
    >
      <Clock size={13} />
      {fmt(remaining, showSeconds)}
    </div>
  );
}
