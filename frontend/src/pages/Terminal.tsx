import { useEffect, useRef, useState } from "react";
import { Terminal as TermIcon, Loader2, ShieldAlert, Wifi, WifiOff } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Shell } from "../components/layout/Shell";
import { api } from "../lib/api";

type Gate = "loading" | "unavailable" | "ready";

export function TerminalPage() {
  const [gate, setGate] = useState<Gate>("loading");
  const [connected, setConnected] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.terminalStatus().then((s) => setGate(s.available ? "ready" : "unavailable")).catch(() => setGate("unavailable"));
  }, []);

  useEffect(() => {
    if (gate !== "ready" || !hostRef.current) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "JetBrains Mono, monospace",
      cursorBlink: true,
      theme: { background: "#0b0f0a", foreground: "#d7e0d0" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/term/ws`);
    ws.binaryType = "arraybuffer";

    const sendResize = () => {
      try {
        fit.fit();
        ws.readyState === WebSocket.OPEN &&
          ws.send(JSON.stringify({ resize: [term.cols, term.rows] }));
      } catch {
        /* ignore */
      }
    };

    ws.onopen = () => {
      setConnected(true);
      sendResize();
      term.focus();
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
      else term.write(ev.data);
    };
    ws.onclose = (ev) => {
      setConnected(false);
      term.write(
        ev.code === 4403
          ? "\r\n\x1b[31m[접근 거부됨 — admin 세션/Origin 확인]\x1b[0m\r\n"
          : "\r\n\x1b[33m[연결이 종료되었습니다]\x1b[0m\r\n",
      );
    };
    ws.onerror = () => term.write("\r\n\x1b[31m[연결 오류]\x1b[0m\r\n");

    const enc = new TextEncoder();
    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });

    const ro = new ResizeObserver(sendResize);
    ro.observe(hostRef.current);

    return () => {
      dataSub.dispose();
      ro.disconnect();
      ws.close();
      term.dispose();
    };
  }, [gate]);

  return (
    <Shell
      title="터미널"
      actions={
        gate === "ready" ? (
          <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${connected ? "text-positive" : "text-fg-muted"}`}>
            {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
            {connected ? "연결됨" : "연결 대기"}
          </span>
        ) : null
      }
    >
      {gate === "loading" && (
        <div className="flex h-64 items-center justify-center text-fg-muted">
          <Loader2 className="animate-spin" />
        </div>
      )}

      {gate === "unavailable" && (
        <div className="card flex flex-col items-center justify-center gap-3 p-10 text-center">
          <ShieldAlert size={30} className="text-warning" />
          <p className="text-[14px] font-semibold">터미널을 사용할 수 없습니다</p>
          <p className="max-w-md text-[13px] text-fg-muted">
            admin 계정으로 로그인하고, 서버에서 <code className="rounded bg-subtle px-1">ENABLE_TERMINAL=true</code> 설정 후
            <code className="ml-1 rounded bg-subtle px-1">docker compose --profile terminal up -d</code> 로 실행해야 합니다.
          </p>
        </div>
      )}

      {gate === "ready" && (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <TermIcon size={15} className="text-accent" />
            <span className="text-[13px] font-medium">라즈베리파이 셸 (admin)</span>
            <span className="ml-auto text-[11.5px] text-fg-subtle">⚠️ 호스트 루트 셸 — 주의해서 사용</span>
          </div>
          <div ref={hostRef} className="h-[calc(100vh-13rem)] w-full bg-[#0b0f0a] p-2" />
        </div>
      )}
    </Shell>
  );
}
