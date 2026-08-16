import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, Link2, Loader2, Unlink } from "lucide-react";
import { api, GoogleStatus } from "../../lib/api";
import { useAuth } from "../../store/auth";
import { toast } from "../../store/toast";

/** 캘린더 탭 상단의 Google 연동 카드. */
export function GoogleConnect() {
  const session = useAuth((s) => s.session);
  const isOwner = session?.origin === "bootstrap" && session?.role === "admin";
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await api.googleStatus());
    } catch {
      setSt(null);
    }
  }, []);

  useEffect(() => {
    load();
    // 콜백에서 돌아오면 ?google=connected 가 붙는다
    const p = new URLSearchParams(window.location.search);
    const g = p.get("google");
    if (g === "connected") toast.ok("Google 캘린더가 연동되었습니다.");
    if (g === "denied") toast.error("Google 연동이 취소되었습니다.");
    if (g) {
      p.delete("google");
      const q = p.toString();
      window.history.replaceState({}, "", window.location.pathname + (q ? `?${q}` : ""));
    }
  }, [load]);

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await api.googleAuthUrl();
      window.location.href = url; // 구글 동의 화면으로
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "연동을 시작하지 못했습니다.");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm("Google 캘린더 연동을 해제할까요? 내부 캘린더로 돌아갑니다.")) return;
    setBusy(true);
    try {
      await api.googleDisconnect();
      toast.ok("연동을 해제했습니다.");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "해제에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;

  return (
    <div className="mb-4 rounded-md border border-line bg-subtle p-3">
      <div className="flex items-center gap-3">
        <CalendarCheck size={18} className={st.connected ? "text-positive" : "text-fg-subtle"} />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium">
            {st.connected ? "Google 캘린더 연동됨" : "Google 캘린더 미연동"}
          </p>
          <p className="truncate text-[12px] text-fg-muted">
            {st.connected
              ? st.email
                ? `${st.email} · ${st.via === "env" ? "환경변수 설정" : "웹 연동"}`
                : st.via === "env"
                  ? "환경변수로 설정됨"
                  : "연동됨"
              : !isOwner
                ? "Google 연동은 서버 관리자만 설정할 수 있습니다. 내부 캘린더는 그대로 사용하세요."
                : st.server_ready
                  ? "연동하면 일정이 Google 캘린더에 저장됩니다"
                  : "서버에 GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI 설정이 필요합니다"}
          </p>
        </div>

        {/* 연동 해제는 권한 축소라 본인이면 항상 가능해야 한다 —
            이 변경 전에 연동한 가입 사용자가 영영 못 끊는 상태가 되지 않도록. */}
        {st.connected && st.via === "oauth" ? (
          <button onClick={disconnect} disabled={busy} className="btn btn-ghost h-8 hover:text-danger">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Unlink size={14} />} 해제
          </button>
        ) : isOwner && st.server_ready ? (
          <button onClick={connect} disabled={busy} className="btn btn-primary h-8">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
            {st.connected ? "다시 연동" : "연동"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
