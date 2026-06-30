import { Cpu, MemoryStick, Thermometer, HardDrive } from "lucide-react";
import { api } from "../../lib/api";
import { usePolling } from "../../hooks/usePolling";
import { formatBytes, formatUptime } from "../../lib/format";
import { Gauge } from "./Gauge";

export function SystemMonitor() {
  const { data, error } = usePolling(api.system, 2500);
  const temp = data?.temperature_c ?? null;

  return (
    <section className="card overflow-hidden">
      <header className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <HardDrive size={15} className="text-accent" />
          <h2 className="text-sm font-semibold">시스템 상태</h2>
        </div>
        <span className="label flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${error ? "bg-danger" : "bg-positive"}`}
          />
          {error ? "오프라인" : "실시간"}
        </span>
      </header>
      <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
        <div className="bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-1.5">
            <Cpu size={13} className="text-fg-muted" />
            <span className="label">CPU · {data?.cpu_count ?? "–"}코어</span>
          </div>
          <Gauge value={data?.cpu_percent ?? 0} label="부하" />
        </div>
        <div className="bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-1.5">
            <MemoryStick size={13} className="text-fg-muted" />
            <span className="label">메모리</span>
          </div>
          <Gauge
            value={data?.mem_percent ?? 0}
            label="사용"
            sub={data ? `${formatBytes(data.mem_used)}/${formatBytes(data.mem_total)}` : ""}
          />
        </div>
        <div className="flex flex-col bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-1.5">
            <Thermometer size={13} className="text-fg-muted" />
            <span className="label">온도</span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center py-2">
            <span
              className="font-mono font-semibold leading-none tabular-nums"
              style={{
                fontSize: "clamp(1.75rem, 9vw, 2.4rem)",
                color:
                  temp == null
                    ? "rgb(var(--fg-subtle))"
                    : temp >= 75
                      ? "rgb(var(--danger))"
                      : temp >= 60
                        ? "rgb(var(--warning))"
                        : "rgb(var(--info))",
              }}
            >
              {temp == null ? "—" : temp.toFixed(1)}
              <span className="text-[0.45em] text-fg-subtle">°C</span>
            </span>
            <span className="label mt-2">
              {temp == null ? "센서없음" : temp >= 75 ? "높음" : temp >= 60 ? "보통" : "양호"}
            </span>
          </div>
        </div>
        <div className="flex flex-col bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-1.5">
            <HardDrive size={13} className="text-fg-muted" />
            <span className="label">디스크</span>
          </div>
          <Gauge value={data?.disk_percent ?? 0} label="사용" />
          <div className="mt-3 space-y-1 text-center">
            <p className="font-mono text-[0.7rem] text-fg2">
              {data ? `${formatBytes(data.disk_used)} / ${formatBytes(data.disk_total)}` : "—"}
            </p>
            <p className="label">가동 {data ? formatUptime(data.uptime_seconds) : "—"}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
