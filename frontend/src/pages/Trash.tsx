import { useCallback, useEffect, useState } from "react";
import { Trash2, RotateCcw, XCircle, Loader2, FolderOpen, FileText, NotebookPen } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { Modal } from "../components/ui/Modal";
import { api, TrashEntry } from "../lib/api";
import { toast } from "../store/toast";

function fmt(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function Trash() {
  const [items, setItems] = useState<TrashEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      setItems(await api.trashList());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "휴지통 로드 실패");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const restore = async (id: string) => {
    setBusy(id);
    try {
      await api.trashRestore(id);
      toast.ok("복원됨");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "복원 실패");
    } finally {
      setBusy(null);
    }
  };

  const purge = async (id: string) => {
    setBusy(id);
    try {
      await api.trashPurge(id);
      toast.ok("영구 삭제됨");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setBusy(null);
    }
  };

  const doEmpty = async () => {
    setEmptyOpen(false);
    try {
      await api.trashEmpty();
      toast.ok("휴지통을 비웠습니다");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "비우기 실패");
    }
  };

  const icon = (e: TrashEntry) =>
    e.is_dir ? FolderOpen : e.kind === "note" ? NotebookPen : FileText;

  return (
    <Shell
      title="휴지통"
      actions={
        items && items.length > 0 ? (
          <button onClick={() => setEmptyOpen(true)} className="btn btn-danger h-8">
            <Trash2 size={14} /> 비우기
          </button>
        ) : null
      }
    >
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="label">삭제된 항목 {items?.length ?? 0}</span>
          <span className="text-[12px] text-fg-muted">복원하면 원래 위치로 돌아갑니다</span>
        </div>

        {items === null ? (
          <div className="flex h-40 items-center justify-center text-fg-muted">
            <Loader2 className="animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-fg-muted">
            <Trash2 size={28} className="text-fg-subtle" />
            <span className="text-[13px]">휴지통이 비어 있습니다</span>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((e) => {
              const Icon = icon(e);
              return (
                <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon size={16} className="shrink-0 text-fg-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium">{e.name}</p>
                    <p className="truncate text-[11.5px] text-fg-muted">
                      {e.scope === "me" ? "내 공간" : "공통"} · {e.orig_rel} · {fmt(e.deleted_at)}
                    </p>
                  </div>
                  <button
                    onClick={() => restore(e.id)}
                    disabled={busy === e.id}
                    className="btn btn-secondary h-8"
                    title="복원"
                  >
                    {busy === e.id ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                    복원
                  </button>
                  <button
                    onClick={() => purge(e.id)}
                    disabled={busy === e.id}
                    className="btn btn-ghost h-8 px-2 hover:text-danger"
                    title="영구 삭제"
                  >
                    <XCircle size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Modal open={emptyOpen} onClose={() => setEmptyOpen(false)} title="휴지통 비우기" width="max-w-sm">
        <div className="space-y-4">
          <p className="text-[13.5px] text-fg2">
            모든 항목이 <span className="font-semibold text-danger">영구적으로</span> 삭제됩니다. 되돌릴 수 없습니다.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setEmptyOpen(false)} className="btn btn-ghost">취소</button>
            <button onClick={doEmpty} className="btn btn-danger"><Trash2 size={14} /> 모두 삭제</button>
          </div>
        </div>
      </Modal>
    </Shell>
  );
}
