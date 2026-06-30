import { useCallback, useEffect, useRef, useState } from "react";
import {
  Folder, FileText, FileCode, FileImage, FileArchive, File as FileIcon,
  ChevronRight, Upload, FolderPlus, Download, Trash2, Pencil, Home,
  Loader2, RefreshCw,
} from "lucide-react";
import { api, FileEntry, Scope } from "../../lib/api";
import { formatBytes, formatTime, fileKind } from "../../lib/format";
import { Modal } from "../ui/Modal";
import { FileViewer } from "./FileViewer";
import { useSettings } from "../../store/settings";

const KIND_ICON: Record<string, typeof FileIcon> = {
  doc: FileText, code: FileCode, img: FileImage, arc: FileArchive, file: FileIcon,
};

export function FileExplorer({
  scope,
  onError,
  onToast,
}: {
  scope: Scope;
  onError: (m: string) => void;
  onToast: (m: string) => void;
}) {
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [confirmDel, setConfirmDel] = useState<FileEntry | null>(null);
  const [viewing, setViewing] = useState<FileEntry | null>(null);
  const confirmDelete = useSettings((s) => s.settings?.files.confirm_delete ?? true);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      try {
        const r = await api.list(scope, path);
        setEntries(r.entries);
        setCwd(r.path === "." ? "" : r.path);
      } catch (e) {
        onError(e instanceof Error ? e.message : "목록 로드 실패");
      } finally {
        setLoading(false);
      }
    },
    [scope, onError],
  );

  useEffect(() => {
    load("");
  }, [load]);

  const open = (e: FileEntry) => (e.is_dir ? load(e.path) : setViewing(e));

  const doDeleteEntry = async (e: FileEntry) => {
    try {
      await api.remove(scope, e.path);
      onToast(`삭제됨: ${e.name}`);
      setConfirmDel(null);
      load(cwd);
    } catch (err) {
      onError(err instanceof Error ? err.message : "삭제 실패");
    }
  };

  // 설정의 confirm_delete가 켜져 있으면 모달, 아니면 즉시 삭제
  const askDelete = (e: FileEntry) =>
    confirmDelete ? setConfirmDel(e) : doDeleteEntry(e);

  const doUpload = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    let ok = 0;
    for (let i = 0; i < arr.length; i++) {
      setUploading(Math.round((i / arr.length) * 100));
      try {
        await api.upload(scope, cwd, arr[i]);
        ok += 1;
      } catch (e) {
        onError(`${arr[i].name}: ${e instanceof Error ? e.message : "업로드 실패"}`);
      }
    }
    setUploading(null);
    if (ok > 0) onToast(`${ok}/${arr.length}개 업로드 완료`);
    load(cwd);
  };

  const createFolder = async () => {
    if (!newFolder?.trim()) return;
    try {
      await api.mkdir(scope, cwd ? `${cwd}/${newFolder.trim()}` : newFolder.trim());
      onToast("폴더 생성됨");
      setNewFolder(null);
      load(cwd);
    } catch (e) {
      onError(e instanceof Error ? e.message : "폴더 생성 실패");
    }
  };

  const doRename = async () => {
    if (!renaming || !renameVal.trim()) return;
    const dir = renaming.path.includes("/")
      ? renaming.path.slice(0, renaming.path.lastIndexOf("/"))
      : "";
    try {
      await api.rename(scope, renaming.path, dir ? `${dir}/${renameVal.trim()}` : renameVal.trim());
      onToast("이름 변경됨");
      setRenaming(null);
      load(cwd);
    } catch (e) {
      onError(e instanceof Error ? e.message : "이름변경 실패");
    }
  };

  const doDelete = () => confirmDel && doDeleteEntry(confirmDel);

  const crumbs = cwd ? cwd.split("/") : [];

  return (
    <section
      className="card flex min-h-[440px] flex-col overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) doUpload(e.dataTransfer.files);
      }}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[13px]">
          <button onClick={() => load("")} className="flex items-center gap-1 text-fg2 hover:text-accent">
            <Home size={14} />
          </button>
          {crumbs.map((c, i) => {
            const p = crumbs.slice(0, i + 1).join("/");
            return (
              <span key={p} className="flex items-center gap-1 truncate">
                <ChevronRight size={12} className="text-fg-subtle" />
                <button onClick={() => load(p)} className="truncate text-fg2 hover:text-accent">
                  {c}
                </button>
              </span>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={() => load(cwd)} className="btn btn-ghost h-8 w-8 px-0" title="새로고침">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={() => setNewFolder("")} className="btn btn-secondary h-8 px-2.5">
            <FolderPlus size={14} /> <span className="hidden sm:inline">폴더</span>
          </button>
          <button onClick={() => inputRef.current?.click()} className="btn btn-primary h-8 px-2.5">
            <Upload size={14} /> <span className="hidden sm:inline">업로드</span>
          </button>
          <input ref={inputRef} type="file" multiple hidden
            onChange={(e) => e.target.files && doUpload(e.target.files)} />
        </div>
      </header>

      {newFolder !== null && (
        <div className="flex items-center gap-2 border-b border-line bg-subtle px-4 py-2.5">
          <FolderPlus size={15} className="text-accent" />
          <input autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") setNewFolder(null); }}
            placeholder="새 폴더 이름…"
            className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle" />
          <button onClick={createFolder} className="btn btn-primary h-7 px-2.5">생성</button>
          <button onClick={() => setNewFolder(null)} className="btn btn-ghost h-7 px-2.5">취소</button>
        </div>
      )}

      {uploading !== null && (
        <div className="h-0.5 w-full bg-muted">
          <div className="h-full bg-accent transition-all" style={{ width: `${uploading}%` }} />
        </div>
      )}

      <div className="relative max-h-[60vh] flex-1 overflow-auto lg:max-h-none">
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 m-2 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-accent-muted/60 text-sm font-semibold text-accent-fg">
            여기에 놓아 업로드
          </div>
        )}
        {loading && entries.length === 0 ? (
          <div className="flex h-40 items-center justify-center gap-2 text-fg-muted">
            <Loader2 size={16} className="animate-spin" /> 로딩…
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-fg-muted">
            <Folder size={26} />
            <span className="label">빈 폴더 · 파일을 드래그해 업로드</span>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {entries.map((e) => {
              const Icon = e.is_dir ? Folder : (KIND_ICON[fileKind(e.name)] ?? FileIcon);
              return (
                <li key={e.path} className="group flex items-center gap-2 px-4 py-2.5 hover:bg-hovered sm:gap-3 sm:px-5">
                  <button onClick={() => open(e)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Icon size={17} className={`shrink-0 ${e.is_dir ? "text-accent" : "text-fg-muted"}`} />
                    <span className="truncate text-[13.5px]">{e.name}</span>
                  </button>
                  <span className="hidden w-20 shrink-0 text-right font-mono text-[11px] text-fg-muted sm:block">
                    {e.is_dir ? "—" : formatBytes(e.size)}
                  </span>
                  <span className="hidden w-32 shrink-0 text-right font-mono text-[11px] text-fg-subtle md:block">
                    {formatTime(e.modified)}
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                    {!e.is_dir && (
                      <a href={api.downloadUrl(scope, e.path)} download
                        className="grid h-8 w-8 place-items-center rounded-md text-fg-muted hover:bg-subtle hover:text-accent" title="다운로드">
                        <Download size={15} />
                      </a>
                    )}
                    <button onClick={() => { setRenaming(e); setRenameVal(e.name); }}
                      className="grid h-8 w-8 place-items-center rounded-md text-fg-muted hover:bg-subtle hover:text-info" title="이름변경">
                      <Pencil size={15} />
                    </button>
                    <button onClick={() => askDelete(e)}
                      className="grid h-8 w-8 place-items-center rounded-md text-fg-muted hover:bg-subtle hover:text-danger" title="삭제" aria-label="삭제">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-line px-5 py-2">
        <span className="label">
          폴더 {entries.filter((e) => e.is_dir).length} · 파일 {entries.filter((e) => !e.is_dir).length}
        </span>
        <span className="label">/{cwd}</span>
      </footer>

      <FileViewer scope={scope} file={viewing} onClose={() => setViewing(null)} onError={onError} />

      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="이름 변경" width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus value={renameVal} onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doRename()} className="input" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setRenaming(null)} className="btn btn-ghost">취소</button>
            <button onClick={doRename} className="btn btn-primary">변경</button>
          </div>
        </div>
      </Modal>

      <Modal open={!!confirmDel} onClose={() => setConfirmDel(null)} title="삭제 확인" width="max-w-sm">
        <div className="space-y-4">
          <p className="text-[13.5px] text-fg2">
            <span className="font-mono text-danger">{confirmDel?.name}</span>
            {confirmDel?.is_dir ? " 폴더와 내용 전체를" : " 파일을"} 삭제할까요? 되돌릴 수 없습니다.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmDel(null)} className="btn btn-ghost">취소</button>
            <button onClick={doDelete} className="btn btn-danger"><Trash2 size={14} /> 삭제</button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
