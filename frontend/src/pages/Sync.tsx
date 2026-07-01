import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  FolderSync, Loader2, RefreshCw, Link as LinkIcon, Unlink, AlertTriangle,
  CheckCircle2, MonitorSmartphone, ArrowUp, ArrowDown, GitMerge, FolderOpen, Plus,
} from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { Modal } from "../components/ui/Modal";
import { useSync, MappingState } from "../store/sync";
import { Scope } from "../lib/api";
import { toast } from "../store/toast";

const scopeName = (s: Scope) => (s === "me" ? "내 파일" : s === "notes" ? "노트" : "공통");
const webLabel = (scope: Scope, path: string) => `${scopeName(scope)} / ${path || "(루트)"}`;

const STATUS: Record<string, { label: string; cls: string; icon: JSX.Element }> = {
  syncing: { label: "연동중…", cls: "text-accent", icon: <Loader2 size={13} className="animate-spin" /> },
  idle: { label: "연동됨", cls: "text-positive", icon: <CheckCircle2 size={13} /> },
  resume: { label: "재개 필요", cls: "text-warning", icon: <AlertTriangle size={13} /> },
  conflict: { label: "충돌", cls: "text-warning", icon: <AlertTriangle size={13} /> },
  error: { label: "오류", cls: "text-danger", icon: <AlertTriangle size={13} /> },
};

export function Sync() {
  const st = useSync();
  const [disc, setDisc] = useState<MappingState | null>(null);
  // 목적지 지정 폼 (폴더 선택 후 모달)
  const [scope, setScope] = useState<Scope>("me");
  const [parent, setParent] = useState("");
  const [wrap, setWrap] = useState(true);
  const [wrapName, setWrapName] = useState("");

  useEffect(() => {
    if (st.pickPending) {
      setScope("me");
      setParent("");
      setWrap(true);
      setWrapName(st.pickPending.localName); // 기본: 로컬 폴더 이름으로 새 폴더
    }
  }, [st.pickPending]);

  const finalPath = () => {
    const p = parent.trim().replace(/^\/+|\/+$/g, "");
    const w = wrapName.trim().replace(/\//g, "-");
    return [p, wrap && w ? w : ""].filter(Boolean).join("/");
  };

  const beginAdd = async () => {
    try {
      await st.beginAdd();
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast.error(e instanceof Error ? e.message : "폴더 선택 실패");
    }
  };

  const conflictMapping = st.mappings.find((m) => m.status === "conflict" && m.conflicts.length);
  const conflict = conflictMapping?.conflicts[0];

  return (
    <Shell title="로컬 연동">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="card p-4 text-[13px] text-fg2">
          <p className="flex items-center gap-2 font-semibold text-fg">
            <FolderSync size={16} className="text-accent" /> 로컬 폴더 ↔ 웹 폴더 연동 (여러 개 가능)
          </p>
          <p className="mt-2 text-fg-muted">
            PC의 폴더를 원하는 웹 위치(내 파일/공통/노트)에 연동합니다. 로그인 시 자동으로 이어집니다.
            <br />⚠️ <b>PC 크롬/엣지</b> 전용. 로컬 우선 · 텍스트 충돌은 선택(로컬/웹/병합).
          </p>
        </div>

        {!st.supported && (
          <div className="card border-warning/30 bg-warning/5 p-4 text-[13px] text-warning">
            <MonitorSmartphone size={16} className="mb-1 inline" /> 이 브라우저는 File System Access API를 지원하지 않습니다.
            PC의 <b>Chrome</b>/<b>Edge</b>로 접속해 주세요.
          </div>
        )}

        {/* 연동 목록 */}
        {st.mappings.map((m) => {
          const s = STATUS[m.status] ?? STATUS.idle;
          return (
            <div key={m.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[13px] font-semibold">
                    <span className={`inline-flex items-center gap-1 ${s.cls}`}>{s.icon} {s.label}</span>
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
                    <span className="badge">{m.localName}</span>
                    <span>↔</span>
                    <span className="badge">{webLabel(m.scope, m.path)}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {m.status === "resume" ? (
                    <button onClick={() => st.resumeOne(m.id)} className="btn btn-primary h-8">
                      <LinkIcon size={14} /> 재개
                    </button>
                  ) : (
                    <>
                      <Link to={`/files?scope=${m.scope}&path=${encodeURIComponent(m.path)}`} className="btn btn-ghost h-8 px-2" title="파일에서 열기">
                        <FolderOpen size={15} />
                      </Link>
                      <button onClick={() => st.syncOne(m.id)} disabled={m.status === "syncing"} className="btn btn-secondary h-8">
                        {m.status === "syncing" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        동기화
                      </button>
                    </>
                  )}
                  <button onClick={() => setDisc(m)} className="btn btn-ghost h-8 px-2 hover:text-danger" title="연동 해제">
                    <Unlink size={15} />
                  </button>
                </div>
              </div>
              {m.stats && (
                <p className="mt-3 flex flex-wrap items-center gap-3 text-[12px] text-fg-muted">
                  <span className="inline-flex items-center gap-1"><ArrowUp size={12} className="text-positive" /> 업로드 {m.stats.up}</span>
                  <span className="inline-flex items-center gap-1"><ArrowDown size={12} className="text-accent" /> 다운로드 {m.stats.down}</span>
                  <span>· <b className="text-accent">{webLabel(m.scope, m.path)}</b> 에 저장됨</span>
                </p>
              )}
              {m.status === "error" && m.error && <p className="mt-2 text-[12.5px] text-danger">{m.error}</p>}
            </div>
          );
        })}

        {/* 새 연동 추가 */}
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[13px] font-semibold"><Plus size={15} /> 새 폴더 연동</p>
              <p className="mt-1 text-[12px] text-fg-muted">로컬 폴더를 고르면 <b>어느 폴더에 풀지</b> 정할 수 있어요.</p>
            </div>
            <button onClick={beginAdd} disabled={!st.supported} className="btn btn-primary shrink-0">
              <FolderSync size={15} /> 폴더 선택
            </button>
          </div>
        </div>
      </div>

      {/* 목적지 지정 모달 (압축 풀 위치 선택) */}
      <Modal open={!!st.pickPending} onClose={st.cancelAdd}
        title={`「${st.pickPending?.localName ?? ""}」 폴더를 어디에 풀까요?`} width="max-w-md">
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="label">웹 위치</span>
              <select className="input w-32" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
                <option value="me">내 파일</option>
                <option value="common">공통</option>
                <option value="notes">노트</option>
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="label">상위 폴더 (선택)</span>
              <input className="input" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="예: docs (비우면 최상위)" />
            </label>
          </div>

          <div className="space-y-2 rounded-md border border-line p-3">
            <label className="flex items-center gap-2 text-[13px] font-medium">
              <input type="radio" name="wrapmode" checked={wrap} onChange={() => setWrap(true)} />
              새 폴더로 풀기 (권장)
            </label>
            {wrap && (
              <input className="input ml-6 w-[calc(100%-1.5rem)]" value={wrapName}
                onChange={(e) => setWrapName(e.target.value)} placeholder="새 폴더 이름" />
            )}
            <label className="flex items-center gap-2 text-[13px] font-medium">
              <input type="radio" name="wrapmode" checked={!wrap} onChange={() => setWrap(false)} />
              상위 폴더에 내용물 그대로 풀기
            </label>
          </div>

          <p className="rounded-md bg-subtle px-3 py-2 text-[12.5px] text-fg2">
            → <b className="text-accent">{webLabel(scope, finalPath())}</b> 에 동기화됩니다.
            {scope === "notes" && <span className="text-fg-muted"> (노트 페이지에서도 보임)</span>}
          </p>

          <div className="flex justify-end gap-2">
            <button onClick={st.cancelAdd} className="btn btn-ghost">취소</button>
            <button onClick={() => st.confirmAdd(scope, finalPath())} disabled={wrap && !wrapName.trim()} className="btn btn-primary">
              <FolderSync size={15} /> 연동 시작
            </button>
          </div>
        </div>
      </Modal>

      {/* 해제 확인 (업로드 파일 삭제 여부) */}
      <Modal open={!!disc} onClose={() => setDisc(null)} title="연동 해제" width="max-w-md">
        {disc && (
          <div className="space-y-4">
            <p className="text-[13.5px] text-fg2">
              <span className="badge">{disc.localName}</span> 연동을 해제합니다.
              <br />
              이 연동은 <b>{webLabel(disc.scope, disc.path)}</b> 에 파일 <b className="text-accent">{disc.uploaded.length}개</b>를 올렸습니다.
              <br />
              {disc.path
                ? <>이 <b>폴더(하위 폴더 포함)</b>를 <b>삭제(휴지통)</b> 하시겠습니까?</>
                : <>업로드한 <b>파일·폴더</b>를 <b>삭제(휴지통)</b> 하시겠습니까?</>}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={() => setDisc(null)} className="btn btn-ghost">취소</button>
              <button onClick={async () => { const d = disc; setDisc(null); await st.disconnect(d.id, false); toast.ok("연동을 해제했습니다 (파일 유지)"); }}
                className="btn btn-secondary">연동만 해제</button>
              <button onClick={async () => { const d = disc; setDisc(null); await st.disconnect(d.id, true); toast.ok("연동 해제 + 파일을 휴지통으로 이동"); }}
                className="btn btn-danger">파일도 휴지통으로</button>
            </div>
          </div>
        )}
      </Modal>

      {/* 충돌 해결 */}
      <Modal open={!!conflict} onClose={() => {}} title={`충돌 — ${conflictMapping?.localName ?? ""}`} width="max-w-3xl">
        {conflict && conflictMapping && (
          <div className="space-y-3">
            <p className="text-[13px] font-semibold">
              <span className="font-mono text-accent">{conflict.rel}</span> 이(가) 로컬과 웹에서 모두 수정되었습니다.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="overflow-hidden rounded-md border border-line">
                <div className="border-b border-line bg-subtle px-3 py-1.5 text-[12px] font-semibold text-positive">로컬 (원본)</div>
                <pre className="max-h-64 overflow-auto p-3 text-[12px] leading-relaxed">{conflict.localText || "(빈 파일)"}</pre>
              </div>
              <div className="overflow-hidden rounded-md border border-line">
                <div className="border-b border-line bg-subtle px-3 py-1.5 text-[12px] font-semibold text-accent">웹</div>
                <pre className="max-h-64 overflow-auto p-3 text-[12px] leading-relaxed">{conflict.webText || "(빈 파일)"}</pre>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={() => st.resolveConflict(conflictMapping.id, conflict.rel, "local")} className="btn btn-secondary"><ArrowUp size={14} /> 로컬로 덮기</button>
              <button onClick={() => st.resolveConflict(conflictMapping.id, conflict.rel, "web")} className="btn btn-secondary"><ArrowDown size={14} /> 웹으로 덮기</button>
              <button onClick={() => st.resolveConflict(conflictMapping.id, conflict.rel, "merge")} className="btn btn-primary"><GitMerge size={14} /> 병합</button>
            </div>
          </div>
        )}
      </Modal>
    </Shell>
  );
}
