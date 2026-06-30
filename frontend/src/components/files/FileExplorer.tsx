import { useCallback, useEffect, useRef, useState } from "react";
import {
  Folder, FileText, FileCode, FileImage, FileVideo, FileAudio,
  FileArchive, File as FileIcon, ChevronRight, Upload, FolderPlus,
  Download, Trash2, Pencil, HardDrive, Loader2, RefreshCw,
} from "lucide-react";
import { api, FileEntry } from "../../lib/api";
import { formatBytes, formatTime, fileKind } from "../../lib/format";
import { FileViewer } from "./FileViewer";
import { Modal } from "../ui/Modal";

const KIND_ICON: Record<string, typeof FileIcon> = {
  doc: FileText, code: FileCode, img: FileImage, vid: FileVideo,
  aud: FileAudio, arc: FileArchive, file: FileIcon,
};
const KIND_COLOR: Record<string, string> = {
  doc: "text-signal-cyan", code: "text-phosphor", img: "text-signal-amber",
  vid: "text-signal-red", aud: "text-signal-cyan", arc: "text-ash-300",
  file: "text-ash-500",
};

interface Props {
  onError: (msg: string) => void;
  onToast: (msg: string) => void;
  jumpTo?: string | null;
}

export function FileExplorer({ onError, onToast, jumpTo }: Props) {
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [viewing, setViewing] = useState<FileEntry | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [confirmDel, setConfirmDel] = useState<FileEntry | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      try {
        const r = await api.list(path);
        setEntries(r.entries);
        setCwd(r.path);
      } catch (e) {
        onError(e instanceof Error ? e.message : "목록 로드 실패");
      } finally {
        setLoading(false);
      }
    },
    [onError],
  );

  useEffect(() => {
    load("");
  }, [load]);

  // AI 검색 결과 등에서 특정 폴더로 점프
  useEffect(() => {
    if (jumpTo != null) {
      const dir = jumpTo.includes("/") ? jumpTo.slice(0, jumpTo.lastIndexOf("/")) : "";
      load(dir);
    }
  }, [jumpTo, load]);

  const open = (e: FileEntry) => {
    if (e.is_dir) load(e.path);
    else setViewing(e);
  };

  const doUpload = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    let ok = 0;
    for (let i = 0; i < arr.length; i++) {
      setUploading(Math.round((i / arr.length) * 100));
      try {
        await api.upload(cwd, arr[i]);
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
    const path = cwd ? `${cwd}/${newFolder.trim()}` : newFolder.trim();
    try {
      await api.mkdir(path);
      onToast(`폴더 생성: ${newFolder}`);
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
    const dst = dir ? `${dir}/${renameVal.trim()}` : renameVal.trim();
    try {
      await api.rename(renaming.path, dst);
      onToast("이름 변경됨");
      setRenaming(null);
      load(cwd);
    } catch (e) {
      onError(e instanceof Error ? e.message : "이름변경 실패");
    }
  };

  const doDelete = async () => {
    if (!confirmDel) return;
    try {
      await api.remove(confirmDel.path);
      onToast(`삭제됨: ${confirmDel.name}`);
      setConfirmDel(null);
      load(cwd);
    } catch (e) {
      onError(e instanceof Error ? e.message : "삭제 실패");
    }
  };

  const crumbs = cwd ? cwd.split("/") : [];

  return (
    <section
      className="panel animate-fade-up flex min-h-[420px] flex-col overflow-hidden"
      style={{ animationDelay: "120ms" }}
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
      {/* Toolbar */}
      <header className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2.5 sm:gap-3 sm:px-5 sm:py-3">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-xs">
          <button
            onClick={() => load("")}
            className="flex items-center gap-1.5 text-ash-300 hover:text-phosphor"
          >
            <HardDrive size={14} /> hdd
          </button>
          {crumbs.map((c, i) => {
            const path = crumbs.slice(0, i + 1).join("/");
            return (
              <span key={path} className="flex items-center gap-1.5 truncate">
                <ChevronRight size={12} className="text-ash-700" />
                <button
                  onClick={() => load(path)}
                  className="truncate text-ash-300 hover:text-phosphor"
                >
                  {c}
                </button>
              </span>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={() => load(cwd)} className="btn" title="새로고침">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={() => setNewFolder("")} className="btn">
            <FolderPlus size={13} /> <span className="hidden sm:inline">폴더</span>
          </button>
          <button onClick={() => inputRef.current?.click()} className="btn btn-accent">
            <Upload size={13} /> <span className="hidden sm:inline">업로드</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => e.target.files && doUpload(e.target.files)}
          />
        </div>
      </header>

      {/* New folder inline */}
      {newFolder !== null && (
        <div className="flex items-center gap-2 border-b border-white/[0.06] bg-carbon-900/60 px-5 py-2.5">
          <FolderPlus size={14} className="text-phosphor" />
          <input
            autoFocus
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createFolder();
              if (e.key === "Escape") setNewFolder(null);
            }}
            placeholder="새 폴더 이름…"
            className="flex-1 bg-transparent font-mono text-sm text-ash-100 outline-none placeholder:text-ash-700"
          />
          <button onClick={createFolder} className="btn btn-accent">생성</button>
          <button onClick={() => setNewFolder(null)} className="btn">취소</button>
        </div>
      )}

      {/* Upload progress */}
      {uploading !== null && (
        <div className="h-0.5 w-full bg-carbon-600">
          <div
            className="h-full bg-phosphor transition-all duration-300"
            style={{ width: `${uploading}%` }}
          />
        </div>
      )}

      {/* List */}
      <div className="scroll-y relative max-h-[60vh] flex-1 lg:max-h-none">
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 m-2 flex items-center justify-center rounded-lg border-2 border-dashed border-phosphor/60 bg-phosphor/[0.06]">
            <span className="font-display text-lg font-bold uppercase tracking-wider text-phosphor">
              여기에 놓아 업로드
            </span>
          </div>
        )}

        {loading && entries.length === 0 ? (
          <div className="flex h-40 items-center justify-center gap-2 text-ash-500">
            <Loader2 size={16} className="animate-spin" /> 로딩…
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-ash-500">
            <Folder size={28} />
            <span className="label-mono">빈 디렉토리 · 파일을 드래그해 업로드</span>
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {entries.map((e, i) => {
              const Icon = e.is_dir ? Folder : KIND_ICON[fileKind(e.name)];
              const color = e.is_dir ? "text-phosphor" : KIND_COLOR[fileKind(e.name)];
              return (
                <li
                  key={e.path}
                  className="group flex animate-fade-up items-center gap-2 px-4 py-2.5 transition-colors hover:bg-white/[0.025] sm:gap-3 sm:px-5"
                  style={{ animationDelay: `${Math.min(i * 18, 360)}ms` }}
                >
                  <button
                    onClick={() => open(e)}
                    className="flex min-h-[2.25rem] min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <Icon size={17} className={`shrink-0 ${color}`} />
                    <span className="truncate font-sans text-sm text-ash-100">{e.name}</span>
                  </button>
                  <span className="hidden w-24 shrink-0 text-right font-mono text-[0.7rem] text-ash-500 sm:block">
                    {e.is_dir ? "—" : formatBytes(e.size)}
                  </span>
                  <span className="hidden w-32 shrink-0 text-right font-mono text-[0.7rem] text-ash-700 md:block">
                    {formatTime(e.modified)}
                  </span>
                  <div className="row-actions flex shrink-0 items-center gap-0.5 sm:gap-1">
                    {!e.is_dir && (
                      <a
                        href={api.downloadUrl(e.path)}
                        download
                        className="grid h-9 w-9 place-items-center rounded-md text-ash-500 hover:bg-white/5 hover:text-phosphor"
                        title="다운로드"
                        aria-label="다운로드"
                      >
                        <Download size={15} />
                      </a>
                    )}
                    <button
                      onClick={() => {
                        setRenaming(e);
                        setRenameVal(e.name);
                      }}
                      className="grid h-9 w-9 place-items-center rounded-md text-ash-500 hover:bg-white/5 hover:text-signal-cyan"
                      title="이름변경"
                      aria-label="이름변경"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => setConfirmDel(e)}
                      className="grid h-9 w-9 place-items-center rounded-md text-ash-500 hover:bg-white/5 hover:text-signal-red"
                      title="삭제"
                      aria-label="삭제"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-white/[0.06] px-5 py-2">
        <span className="label-mono">
          {entries.filter((e) => e.is_dir).length} dirs · {entries.filter((e) => !e.is_dir).length} files
        </span>
        <span className="label-mono">/{cwd}</span>
      </footer>

      <FileViewer file={viewing} onClose={() => setViewing(null)} onError={onError} />

      {/* Rename modal */}
      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="이름 변경" width="max-w-sm">
        <div className="space-y-3">
          <input
            autoFocus
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doRename()}
            className="w-full rounded-lg border border-white/[0.08] bg-carbon-900 px-3 py-2 font-mono text-sm text-ash-100 outline-none focus:border-signal-cyan/50"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setRenaming(null)} className="btn">취소</button>
            <button onClick={doRename} className="btn btn-accent">변경</button>
          </div>
        </div>
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!confirmDel} onClose={() => setConfirmDel(null)} title="삭제 확인" width="max-w-sm">
        <div className="space-y-4">
          <p className="text-sm text-ash-300">
            <span className="font-mono text-signal-red">{confirmDel?.name}</span>
            {confirmDel?.is_dir ? " 폴더와 내용 전체를" : " 파일을"} 삭제할까요? 되돌릴 수 없습니다.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmDel(null)} className="btn">취소</button>
            <button
              onClick={doDelete}
              className="btn border-signal-red/50 bg-signal-red/10 text-signal-red hover:bg-signal-red/20"
            >
              <Trash2 size={13} /> 삭제
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
