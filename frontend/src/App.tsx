import { useCallback, useEffect, useState } from "react";
import { Terminal, Wifi, WifiOff, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "./lib/api";
import { SystemMonitor } from "./components/system/SystemMonitor";
import { FileExplorer } from "./components/files/FileExplorer";
import { AIPanel } from "./components/ai/AIPanel";

interface Toast {
  id: number;
  msg: string;
  kind: "ok" | "error";
}

let toastId = 0;

export default function App() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [storageRoot, setStorageRoot] = useState("");
  const [jumpTo, setJumpTo] = useState<string | null>(null);

  const push = useCallback((msg: string, kind: "ok" | "error") => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const onError = useCallback((m: string) => push(m, "error"), [push]);
  const onToast = useCallback((m: string) => push(m, "ok"), [push]);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setOnline(true);
        setStorageRoot(h.storage_root);
      })
      .catch(() => setOnline(false));
  }, []);

  // AI 검색 결과 클릭 시 탐색기로 점프 (값 변화를 강제하려 타임스탬프 프리픽스)
  const handleJump = (path: string) => setJumpTo(path);

  return (
    <div
      className="mx-auto max-w-7xl px-4 py-6 sm:px-6 md:px-8 md:py-10"
      style={{
        paddingLeft: "max(1rem, env(safe-area-inset-left))",
        paddingRight: "max(1rem, env(safe-area-inset-right))",
      }}
    >
      {/* Header */}
      <header className="mb-7 flex flex-col gap-4 border-b border-white/[0.06] pb-6 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
        <div className="animate-fade-up">
          <div className="mb-1 flex items-center gap-2">
            <Terminal size={16} className="text-phosphor" />
            <span className="label-mono text-phosphor">TwoEMS · Raspberry Pi 5</span>
          </div>
          <h1
            className="font-display font-black uppercase leading-[0.95] tracking-tight text-ash-100"
            style={{ fontSize: "clamp(2.25rem, 7vw, 3.25rem)" }}
          >
            Control<span className="text-phosphor">.</span>Deck
          </h1>
          <p className="mt-2 font-mono text-xs text-ash-500">
            자작 홈서버 통합 대시보드 — 파일 · 시스템 · AI
          </p>
        </div>

        <div
          className="flex w-full animate-fade-up items-center gap-3 self-start rounded-lg border border-white/[0.06] bg-carbon-800 px-4 py-2.5 sm:w-auto sm:self-auto"
          style={{ animationDelay: "80ms" }}
        >
          {online == null ? (
            <span className="label-mono text-ash-500">연결 중…</span>
          ) : online ? (
            <>
              <Wifi size={15} className="shrink-0 text-phosphor" />
              <div className="min-w-0 leading-tight">
                <p className="label-mono text-phosphor">online</p>
                <p className="truncate font-mono text-[10px] text-ash-500">{storageRoot}</p>
              </div>
              <span className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-phosphor sm:ml-1" />
            </>
          ) : (
            <>
              <WifiOff size={15} className="text-signal-red" />
              <div className="leading-tight">
                <p className="label-mono text-signal-red">offline</p>
                <p className="font-mono text-[10px] text-ash-500">백엔드 미응답</p>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Main grid */}
      <div className="space-y-4 sm:space-y-6">
        <SystemMonitor />
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-[1.6fr_1fr]">
          <FileExplorer onError={onError} onToast={onToast} jumpTo={jumpTo} />
          <AIPanel onError={onError} onJump={handleJump} />
        </div>
      </div>

      <footer className="mt-10 flex items-center justify-between border-t border-white/[0.06] pt-5">
        <span className="label-mono">TwoEMS Home Server · FastAPI + React</span>
        <span className="label-mono">Cloudflare Tunnel ready</span>
      </footer>

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex animate-fade-up items-center gap-2 rounded-lg border px-4 py-3 font-mono text-xs shadow-panel backdrop-blur ${
              t.kind === "ok"
                ? "border-phosphor/30 bg-carbon-800/95 text-phosphor"
                : "border-signal-red/30 bg-carbon-800/95 text-signal-red"
            }`}
          >
            {t.kind === "ok" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
