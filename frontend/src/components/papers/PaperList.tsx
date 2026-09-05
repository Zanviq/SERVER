import { DragEvent, useMemo, useRef, useState } from "react";
import { AlertCircle, FileText, Loader2, MoreHorizontal, RefreshCw, Search, Star, Trash2, Upload, X } from "lucide-react";
import { Paper } from "../../lib/api";
import { Dropdown, DropdownItem } from "../ui/Dropdown";

interface Props {
  papers: Paper[];
  selectedId: string;
  onSelect: (id: string) => void;
  onUpload: (files: File[]) => void;
  onStar: (p: Paper) => void;
  onDelete: (p: Paper) => void;
  onRetry: (p: Paper) => void;
  /** 올리는 중인 파일 수 */
  uploading: number;
  className?: string;
}

export const paperTitle = (p: Paper) => p.title || p.filename.replace(/\.pdf$/i, "");

/** 왼쪽 논문 목록. PDF 를 끌어다 놓으면 올라가고, 올라가면 AI가 뒤에서 정보를 읽는다. */
export function PaperList({ papers, selectedId, onSelect, onUpload, onStar, onDelete, onRetry, uploading, className = "" }: Props) {
  const [q, setQ] = useState("");
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? papers.filter((p) =>
        [p.title, p.filename, p.venue, p.year, ...p.authors, ...p.keywords, ...p.tags]
          .some((s) => s?.toLowerCase().includes(needle)))
      : papers;
    return [...filtered].sort((a, b) => Number(b.starred) - Number(a.starred) || b.created_at - a.created_at);
  }, [papers, q]);

  const pickFiles = (files: FileList | null) => {
    if (!files) return;
    const pdfs = Array.from(files).filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (pdfs.length) onUpload(pdfs);
  };

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    pickFiles(e.dataTransfer.files);
  };

  return (
    <div
      className={`card relative flex flex-col overflow-hidden ${over ? "ring-2 ring-accent" : ""} ${className}`}
      onDragEnter={onDragEnter}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="label">논문 {papers.length}</span>
        <button type="button" onClick={() => fileRef.current?.click()} className="btn btn-ghost h-7 gap-1 px-2 text-[12px]" title="PDF 올리기">
          {uploading > 0 ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {uploading > 0 ? `${uploading}개 올리는 중` : "PDF"}
        </button>
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple className="hidden"
          onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} />
      </div>
      <div className="border-b border-line p-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="제목·저자·키워드…" aria-label="논문 검색"
            className="input h-8 pl-8 pr-7 text-[12.5px]" />
          {q && (
            <button onClick={() => setQ("")} aria-label="검색 지우기" className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"><X size={13} /></button>
          )}
        </div>
      </div>

      <ul className="flex-1 overflow-auto p-1">
        {list.length === 0 && (
          <li className="px-3 py-10 text-center text-[12.5px] text-fg-muted">
            {papers.length === 0 ? (
              <>
                <FileText size={22} className="mx-auto mb-2 text-fg-subtle" />
                PDF를 여기로 끌어다 놓으세요.
                <p className="mt-1 text-[11.5px] text-fg-subtle">올리면 AI가 제목·요약·핵심 발견을 뽑아 둡니다.</p>
              </>
            ) : "검색 결과가 없습니다."}
          </li>
        )}
        {list.map((p) => {
          const active = p.id === selectedId;
          return (
            <li key={p.id}>
              <div
                role="button" tabIndex={0}
                onClick={() => onSelect(p.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.id); } }}
                className={`group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${active ? "bg-accent-muted" : "hover:bg-hovered"}`}>
                <span className="mt-[3px] shrink-0">
                  {p.status === "pending" ? <Loader2 size={14} className="animate-spin text-accent" />
                    : p.status === "failed" ? <AlertCircle size={14} className="text-danger" />
                    : <FileText size={14} className={active ? "text-accent" : "text-fg-muted"} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[13px] ${active ? "font-semibold text-accent-fg" : "font-medium"}`} title={paperTitle(p)}>
                    {paperTitle(p)}
                  </span>
                  <span className="block truncate text-[11px] text-fg-muted">
                    {p.status === "pending" ? "AI가 정보를 읽는 중…"
                      : p.status === "failed" ? (p.error || "정보 추출 실패")
                      : [p.authors[0] ? (p.authors.length > 1 ? `${p.authors[0]} 외` : p.authors[0]) : "", p.year, p.venue, p.pages ? `${p.pages}쪽` : ""].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {p.starred && <Star size={12} className="mt-1 shrink-0 fill-warning text-warning" />}
                <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <Dropdown align="end" width={160}
                    className={`grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-hovered hover:text-fg ${active ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
                    trigger={() => <MoreHorizontal size={14} />}>
                    {(close) => (
                      <>
                        <DropdownItem onClick={() => { onStar(p); close(); }}>
                          <Star size={13} className={p.starred ? "fill-warning text-warning" : ""} /> {p.starred ? "별표 해제" : "별표"}
                        </DropdownItem>
                        <DropdownItem onClick={() => { onRetry(p); close(); }}>
                          <RefreshCw size={13} /> 정보 다시 추출
                        </DropdownItem>
                        <DropdownItem onClick={() => { onDelete(p); close(); }} className="text-danger">
                          <Trash2 size={13} /> 휴지통으로
                        </DropdownItem>
                      </>
                    )}
                  </Dropdown>
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {over && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-accent-muted/70 text-[13px] font-medium text-accent-fg">
          <span className="flex items-center gap-2"><Upload size={16} /> 놓으면 올라갑니다</span>
        </div>
      )}
    </div>
  );
}
