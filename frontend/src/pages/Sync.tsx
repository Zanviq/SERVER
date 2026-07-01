import { useState } from "react";
import {
  FolderSync, Loader2, RefreshCw, Link as LinkIcon, Unlink, AlertTriangle,
  CheckCircle2, MonitorSmartphone, ArrowUp, ArrowDown, GitMerge,
} from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { Modal } from "../components/ui/Modal";
import { useSync } from "../store/sync";
import { Scope } from "../lib/api";
import { toast } from "../store/toast";

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: JSX.Element }> = {
    unsupported: { label: "미지원 브라우저", cls: "text-fg-muted", icon: <MonitorSmartphone size={14} /> },
    unsynced: { label: "연동 안됨", cls: "text-fg-muted", icon: <Unlink size={14} /> },
    resume: { label: "연동 재개 필요", cls: "text-warning", icon: <AlertTriangle size={14} /> },
    syncing: { label: "연동중…", cls: "text-accent", icon: <Loader2 size={14} className="animate-spin" /> },
    idle: { label: "연동됨", cls: "text-positive", icon: <CheckCircle2 size={14} /> },
    conflict: { label: "충돌 해결 필요", cls: "text-warning", icon: <AlertTriangle size={14} /> },
    error: { label: "오류", cls: "text-danger", icon: <AlertTriangle size={14} /> },
  };
  const m = map[status] ?? map.unsynced;
  return <span className={`inline-flex items-center gap-1.5 text-[13px] font-semibold ${m.cls}`}>{m.icon} {m.label}</span>;
}

export function Sync() {
  const st = useSync();
  const [scope, setScope] = useState<Scope>("me");
  const [path, setPath] = useState("");

  const connect = async () => {
    try {
      await st.connect(scope, path.trim());
    } catch (e) {
      // 사용자가 폴더 선택을 취소하면 AbortError → 조용히 무시
      if ((e as Error).name !== "AbortError") {
        toast.error(e instanceof Error ? e.message : "연동 실패");
      }
    }
  };

  return (
    <Shell title="로컬 연동" actions={<StatusBadge status={st.status} />}>
      <div className="mx-auto max-w-2xl space-y-4">
        {/* 안내 */}
        <div className="card p-4 text-[13px] text-fg2">
          <p className="flex items-center gap-2 font-semibold text-fg">
            <FolderSync size={16} className="text-accent" /> 내 로컬 폴더 ↔ 웹 폴더 연동
          </p>
          <p className="mt-2 text-fg-muted">
            PC의 폴더를 선택하면 웹 폴더와 동기화됩니다. 로그인 시 자동으로 이어집니다.
            <br />
            ⚠️ 이 기능은 <b>PC 크롬/엣지</b> 전용입니다 (폰·사파리 미지원). 로컬 파일을 우선하며,
            둘 다 수정된 텍스트 파일은 차이를 보여주고 선택하게 합니다.
          </p>
        </div>

        {st.status === "unsupported" && (
          <div className="card border-warning/30 bg-warning/5 p-4 text-[13px] text-warning">
            이 브라우저는 File System Access API를 지원하지 않습니다. PC의 <b>Chrome</b> 또는 <b>Edge</b>로 접속해 주세요.
          </div>
        )}

        {/* 현재 연동 상태 */}
        {(st.status === "idle" || st.status === "syncing" || st.status === "conflict") && st.localName && (
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">연동된 폴더</p>
                <p className="mt-1 flex items-center gap-2 text-[13px] text-fg-muted">
                  <span className="badge">{st.localName}</span>
                  <span>↔</span>
                  <span className="badge">{st.scope === "me" ? "내 파일" : "공통"}/{st.path || "(루트)"}</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => st.runSync()} disabled={st.status === "syncing"} className="btn btn-secondary h-8">
                  {st.status === "syncing" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  지금 동기화
                </button>
                <button onClick={() => st.disconnect()} className="btn btn-ghost h-8 px-2 hover:text-danger" title="연동 해제">
                  <Unlink size={15} />
                </button>
              </div>
            </div>
            {st.stats && (
              <p className="mt-3 flex items-center gap-3 text-[12px] text-fg-muted">
                <span className="inline-flex items-center gap-1"><ArrowUp size={12} className="text-positive" /> 업로드 {st.stats.up}</span>
                <span className="inline-flex items-center gap-1"><ArrowDown size={12} className="text-accent" /> 다운로드 {st.stats.down}</span>
              </p>
            )}
          </div>
        )}

        {/* 연동 재개 (권한 재요청) */}
        {st.status === "resume" && (
          <div className="card p-4">
            <p className="text-[13px] text-fg2">
              이전에 연동한 폴더가 있습니다. 보안상 폴더 접근 권한을 다시 허용해야 합니다.
            </p>
            <button onClick={() => st.resume()} className="btn btn-primary mt-3">
              <LinkIcon size={15} /> 연동 재개 ({st.localName})
            </button>
          </div>
        )}

        {/* 새 연동 설정 */}
        {(st.status === "unsynced" || st.status === "error") && (
          <div className="card space-y-3 p-4">
            <p className="text-[13px] font-semibold">새 폴더 연동</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="label">웹 공간</span>
                <select className="input w-32" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
                  <option value="me">내 파일</option>
                  <option value="common">공통</option>
                </select>
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="label">웹 폴더 경로 (비우면 루트)</span>
                <input className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="예: docs/sync" />
              </label>
              <button onClick={connect} disabled={st.status === "unsynced" && !("showDirectoryPicker" in window)} className="btn btn-primary">
                <FolderSync size={15} /> 폴더 선택 & 연동
              </button>
            </div>
            {st.status === "error" && st.error && (
              <p className="text-[12.5px] text-danger">{st.error}</p>
            )}
          </div>
        )}
      </div>

      {/* 충돌 해결 모달 */}
      <Modal
        open={st.status === "conflict" && st.conflicts.length > 0}
        onClose={() => {}}
        title={`충돌 ${st.conflicts.length}건 — 어떻게 처리할까요?`}
        width="max-w-3xl"
      >
        <div className="space-y-4">
          {st.conflicts.slice(0, 1).map((c) => (
            <div key={c.rel} className="space-y-3">
              <p className="text-[13px] font-semibold">
                <span className="font-mono text-accent">{c.rel}</span> 이(가) 로컬과 웹에서 모두 수정되었습니다.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="overflow-hidden rounded-md border border-line">
                  <div className="border-b border-line bg-subtle px-3 py-1.5 text-[12px] font-semibold text-positive">로컬 (원본)</div>
                  <pre className="max-h-64 overflow-auto p-3 text-[12px] leading-relaxed">{c.localText || "(빈 파일)"}</pre>
                </div>
                <div className="overflow-hidden rounded-md border border-line">
                  <div className="border-b border-line bg-subtle px-3 py-1.5 text-[12px] font-semibold text-accent">웹</div>
                  <pre className="max-h-64 overflow-auto p-3 text-[12px] leading-relaxed">{c.webText || "(빈 파일)"}</pre>
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button onClick={() => st.resolveConflict(c.rel, "local")} className="btn btn-secondary">
                  <ArrowUp size={14} /> 로컬로 덮기
                </button>
                <button onClick={() => st.resolveConflict(c.rel, "web")} className="btn btn-secondary">
                  <ArrowDown size={14} /> 웹으로 덮기
                </button>
                <button onClick={() => st.resolveConflict(c.rel, "merge")} className="btn btn-primary">
                  <GitMerge size={14} /> 병합 (로컬 위 · 웹 아래)
                </button>
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </Shell>
  );
}
