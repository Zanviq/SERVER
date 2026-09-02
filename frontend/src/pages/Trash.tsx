import { useCallback, useEffect, useState } from "react";
import { Trash2, RotateCcw, XCircle, Loader2, FolderOpen, FileText, NotebookPen, CalendarDays, ListChecks } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { Modal } from "../components/ui/Modal";
import { api, TrashEntry } from "../lib/api";
import { toast } from "../store/toast";

function fmt(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 휴지통 갈래. 문서·일정·할 일이 섞이면 찾기 어려워 탭으로 나눈다.
 *  백엔드(trash.KIND_*)와 **같은 갈래를 다 알아야 한다** — 빠진 갈래는
 *  '경로가 빈 문서'처럼 보이고 어느 탭으로도 걸러지지 않는다. */
const TABS = [
  { key: "", label: "전체" },
  { key: "document", label: "문서" },
  { key: "event", label: "일정" },
  { key: "todo", label: "할 일" },
] as const;

export function Trash() {
  const [items, setItems] = useState<TrashEntry[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  // 개별 영구 삭제도 확인을 받는다 — 되돌릴 수 없는 동작이 한 번 눌러 끝나면 안 된다
  const [purgeFor, setPurgeFor] = useState<TrashEntry | null>(null);

  const reload = useCallback(async () => {
    try {
      const [list, c] = await Promise.all([api.trashList(tab), api.trashCounts()]);
      setItems(list);
      setCounts(c);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "휴지통 로드 실패");
      setItems([]);
    }
  }, [tab]);

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
    e.is_dir ? FolderOpen : e.name.endsWith(".md") ? NotebookPen : FileText;

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
        {/* 문서와 일정이 한 목록에 섞이면 찾기 어렵다 — 갈래로 나눠 본다 */}
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
          {TABS.map((t) => {
            const n = t.key === "" ? counts.all ?? 0 : counts[t.key] ?? 0;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  tab === t.key ? "bg-accent-muted text-accent-fg" : "text-fg-muted hover:bg-hovered hover:text-fg"
                }`}
              >
                {t.label}
                <span className="text-[11.5px] opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="label">삭제된 항목 {items?.length ?? 0}</span>
          <span className="text-[12px] text-fg-muted">
            {tab === "event" ? "복원하면 캘린더에 다시 만들어집니다"
              : tab === "todo" ? "복원하면 할 일 목록에 다시 생깁니다"
              : "복원하면 원래 위치로 돌아갑니다"}
          </span>
        </div>

        {items === null ? (
          <div className="flex h-40 items-center justify-center text-fg-muted">
            <Loader2 className="animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-fg-muted">
            <Trash2 size={28} className="text-fg-subtle" />
            <span className="text-[13px]">
              {tab === "event" ? "삭제된 일정이 없습니다"
                : tab === "document" ? "삭제된 문서가 없습니다"
                : tab === "todo" ? "삭제된 할 일이 없습니다"
                : "휴지통이 비어 있습니다"}
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((e) => {
              const isEvent = e.kind === "event";
              const isTodo = e.kind === "todo";
              const Icon = isEvent ? CalendarDays : isTodo ? ListChecks : icon(e);
              const due = (e.todo_due ?? "").slice(0, 16).replace("T", " ");
              return (
                <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon size={16} className="shrink-0 text-fg-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium">{e.name}</p>
                    <p className="truncate text-[11.5px] text-fg-muted">
                      {isEvent
                        ? `일정 · ${(e.event_start ?? "").slice(0, 16).replace("T", " ")} · 삭제 ${fmt(e.deleted_at)}`
                        : isTodo
                        ? `할 일${e.todo_done ? " · 완료" : ""}${due ? ` · ${due}` : ""} · 삭제 ${fmt(e.deleted_at)}`
                        : `${e.orig_rel} · ${fmt(e.deleted_at)}`}
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
                    onClick={() => setPurgeFor(e)}
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

      <Modal open={!!purgeFor} onClose={() => setPurgeFor(null)} title="영구 삭제" width="max-w-sm">
        <div className="space-y-4">
          <p className="text-[13.5px] text-fg2">
            <span className="font-semibold">{purgeFor?.name}</span> 을(를){" "}
            <span className="font-semibold text-danger">영구적으로</span> 삭제합니다. 되돌릴 수 없습니다.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setPurgeFor(null)} className="btn btn-ghost">취소</button>
            <button
              onClick={() => {
                const target = purgeFor;
                setPurgeFor(null);
                if (target) purge(target.id);
              }}
              className="btn btn-danger"
            >
              영구 삭제
            </button>
          </div>
        </div>
      </Modal>

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
