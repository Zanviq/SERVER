import { useEffect, useRef, useState } from "react";
import { Cpu, MemoryStick, Thermometer, HardDrive, Activity } from "lucide-react";
import { api } from "../../lib/api";
import { usePolling } from "../../hooks/usePolling";
import { formatBytes, formatUptime } from "../../lib/format";
import { Gauge } from "./Gauge";
import { Sparkline } from "./Sparkline";

const HISTORY = 40;

export function SystemMonitor() {
  const { data, error } = usePolling(api.system, 2000);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  const lastRef = useRef<number>(0);

  useEffect(() => {
    if (!data) return;
    // 중복 틱 방지 (StrictMode 등)
    const now = data.uptime_seconds;
    if (now === lastRef.current) return;
    lastRef.current = now;
    setCpuHist((h) => [...h, data.cpu_percent].slice(-HISTORY));
    setMemHist((h) => [...h, data.mem_percent].slice(-HISTORY));
  }, [data]);

  const temp = data?.temperature_c ?? null;
  const tempColor =
    temp == null ? "#6b7480" : temp >= 75 ? "#ff5d5d" : temp >= 60 ? "#ffb84d" : "#54e6ff";

  return (
    <section className="panel animate-fade-up overflow-hidden" style={{ animationDelay: "60ms" }}>
      <header className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-phosphor" />
          <h2 className="font-display text-sm font-bold uppercase tracking-wider">
            System Telemetry
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              error ? "bg-signal-red" : "bg-phosphor animate-pulse-dot"
            }`}
          />
          <span className="label-mono">{error ? "offline" : "live · 2s"}</span>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-px bg-white/[0.04] md:grid-cols-4">
        {/* CPU */}
        <div className="bg-carbon-800 p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-1.5">
            <Cpu size={13} className="shrink-0 text-ash-500" />
            <span className="label-mono truncate">CPU · {data?.cpu_count ?? "–"} core</span>
          </div>
          <Gauge value={data?.cpu_percent ?? 0} label="load" />
          <div className="mt-3">
            <Sparkline data={cpuHist} color="#c6f432" />
          </div>
        </div>

        {/* MEM */}
        <div className="bg-carbon-800 p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-1.5">
            <MemoryStick size={13} className="shrink-0 text-ash-500" />
            <span className="label-mono">Memory</span>
          </div>
          <Gauge
            value={data?.mem_percent ?? 0}
            label="used"
            sub={
              data ? `${formatBytes(data.mem_used)}/${formatBytes(data.mem_total)}` : ""
            }
          />
          <div className="mt-3">
            <Sparkline data={memHist} color="#54e6ff" />
          </div>
        </div>

        {/* TEMP */}
        <div className="flex flex-col bg-carbon-800 p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-1.5">
            <Thermometer size={13} className="shrink-0 text-ash-500" />
            <span className="label-mono">Temp</span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center py-2">
            <span
              className="font-mono font-semibold leading-none tabular-nums"
              style={{ color: tempColor, fontSize: "clamp(1.75rem, 9vw, 2.5rem)" }}
            >
              {temp == null ? "—" : temp.toFixed(1)}
              <span className="text-[0.45em] text-ash-500">°C</span>
            </span>
            <span className="label-mono mt-2">
              {temp == null ? "n/a" : temp >= 75 ? "hot" : temp >= 60 ? "warm" : "nominal"}
            </span>
          </div>
        </div>

        {/* DISK + uptime */}
        <div className="flex flex-col bg-carbon-800 p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-1.5">
            <HardDrive size={13} className="shrink-0 text-ash-500" />
            <span className="label-mono">Storage</span>
          </div>
          <Gauge value={data?.disk_percent ?? 0} label="disk" max={116} />
          <div className="mt-3 space-y-1 text-center">
            <p className="font-mono text-[0.7rem] text-ash-300">
              {data ? `${formatBytes(data.disk_used)} / ${formatBytes(data.disk_total)}` : "—"}
            </p>
            <p className="label-mono">
              up {data ? formatUptime(data.uptime_seconds) : "—"}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
