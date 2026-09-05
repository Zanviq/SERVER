import { DragEvent, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ChevronDown, ChevronRight, FileText, FolderClosed, FolderOpen, Loader2,
  MoreHorizontal, RefreshCw, Search, Star, Trash2, Upload, X,
} from "lucide-react";
import { Paper } from "../../lib/api";
import { Dropdown, DropdownItem } from "../ui/Dropdown";

interface Props {
  papers: Paper[];
  /** 쓰이고 있는 분류 이름(다른 논문으로 옮길 때 고른다) */
  categories: string[];
  selectedId: string;
  onSelect: (id: string) => void;
  onUpload: (files: File[]) => void;
  onStar: (p: Paper) => void;
  onDelete: (p: Paper) => void;
  onRetry: (p: Paper) => void;
  /** 분류를 옮긴다. 빈 문자열이면 '분류 없음'으로 뺀다. */
  onMove: (p: Paper, category: string) => void;
  /** "새 폴더" — 이름을 받아 그 분류로 옮긴다(폴더는 이름일 뿐이라 논문이 있어야 남는다) */
  onNewCategory: (p: Paper) => void;
  /** 올리는 중인 파일 수 */
  uploading: number;
  className?: string;
}

export const paperTitle = (p: Paper) => p.title || p.filename.replace(/\.pdf$/i, "");

/** 분류 없는 논문을 담는 자리. 실제 분류 이름과 겹치지 않도록 빈 문자열을 쓴다. */
const NONE = "";
const NONE_LABEL = "분류 없음";

/**
 * 왼쪽 논문 목록. PDF 를 끌어다 놓으면 올라가고, 올라가면 AI가 뒤에서 정보를 읽는다.
 *
 * 분류는 **폴더처럼** 보여 준다 — 따로 저장하지 않고 논문의 category 에서 모으므로
 * 빈 폴더는 남지 않는다. 검색 중에는 폴더를 접지 않고 결과를 한 줄로 편다
 * (찾는 중에 접힌 폴더 안에 답이 숨어 있으면 안 된다).
 */
export function PaperList({
  papers, categories, selectedId, onSelect, onUpload, onStar, onDelete, onRetry,
  onMove, onNewCategory, uploading, className = "",
}: Props) {
  const [q, setQ] = useState("");
  const [over, setOver] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? papers.filter((p) =>
        [p.title, p.filename, p.venue, p.year, p.category, ...p.authors, ...p.keywords, ...p.tags]
          .some((s) => s?.toLowerCase().includes(needle)))
      : papers;
    return [...filtered].sort((a, b) => Number(b.starred) - Number(a.starred) || b.created_at - a.created_at);
  }, [papers, q]);

  /** [분류, 그 안의 논문] 묶음. 분류 없는 것은 맨 아래. */
  const groups = useMemo(() => {
    const byCat = new Map<string, Paper[]>();
    for (const p of list) {
      const c = p.category || NONE;
      const rows = byCat.get(c);
      if (rows) rows.push(p); else byCat.set(c, [p]);
    }
    const named = [...byCat.entries()].filter(([c]) => c !== NONE)
      .sort((a, b) => a[0].localeCompare(b[0], "ko"));
    const none = byCat.get(NONE);
    return none ? [...named, [NONE, none] as [string, Paper[]]] : named;
  }, [list]);

  const searching = q.trim().length > 0;
  // 폴더가 하나뿐이고 그게 '분류 없음'이면 폴더 껍데기는 군더더기다
  const flat = searching || (groups.length === 1 && groups[0][0] === NONE);

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

  const toggle = (cat: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(cat)) n.delete(cat); else n.add(cat);
      return n;
    });

  const row = (p: Paper, inFolder: boolean) => {
    const active = p.id === selectedId;
    return (
      <li key={p.id}>
        <div
          role="button" tabIndex={0}
          onClick={() => onSelect(p.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.id); } }}
          className={`group flex w-full items-start gap-2 rounded-md py-1.5 pr-2 text-left ${inFolder ? "pl-5" : "pl-2"} ${active ? "bg-accent-muted" : "hover:bg-hovered"}`}>
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
                : [
                    searching && p.category ? p.category : "",
                    p.authors[0] ? (p.authors.length > 1 ? `${p.authors[0]} 외` : p.authors[0]) : "",
                    p.year, p.venue, p.pages ? `${p.pages}쪽` : "",
                  ].filter(Boolean).join(" · ")}
            </span>
          </span>
          {p.starred && <Star size={12} className="mt-1 shrink-0 fill-warning text-warning" />}
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Dropdown align="end" width={190}
              className={`grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-hovered hover:text-fg ${active ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
              trigger={() => <MoreHorizontal size={14} />}>
              {(close) => (
                <>
                  <DropdownItem onClick={() => { onStar(p); close(); }}>
                    <Star size={13} className={p.starred ? "fill-warning text-warning" : ""} /> {p.starred ? "별표 해제" : "별표"}
                  </DropdownItem>
                  <div className="my-1 border-t border-line" />
                  <p className="px-2.5 pb-1 pt-0.5 text-[11px] text-fg-subtle">폴더로 옮기기</p>
                  {categories.filter((c) => c !== p.category).map((c) => (
                    <DropdownItem key={c} onClick={() => { onMove(p, c); close(); }}>
                      <FolderClosed size={13} /> <span className="truncate">{c}</span>
                    </DropdownItem>
                  ))}
                  {p.category && (
                    <DropdownItem onClick={() => { onMove(p, ""); close(); }}>
                      <FolderOpen size={13} /> {NONE_LABEL}으로
                    </DropdownItem>
                  )}
                  <DropdownItem onClick={() => { onNewCategory(p); close(); }}>
                    <FolderClosed size={13} /> 새 폴더…
                  </DropdownItem>
                  <div className="my-1 border-t border-line" />
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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="제목·저자·폴더·키워드…" aria-label="논문 검색"
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
        {flat
          ? list.map((p) => row(p, false))
          : groups.map(([cat, rows]) => {
            const open = !closed.has(cat);
            // 지금 보고 있는 논문이 든 폴더는 접혀 있어도 알아볼 수 있게 표시한다
            const hasActive = rows.some((p) => p.id === selectedId);
            return (
              <li key={cat || "__none__"}>
                <button type="button" onClick={() => toggle(cat)} aria-expanded={open}
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] font-semibold text-fg-muted hover:bg-hovered hover:text-fg">
                  {open ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
                  {open ? <FolderOpen size={13} className="shrink-0" /> : <FolderClosed size={13} className="shrink-0" />}
                  <span className={`min-w-0 flex-1 truncate ${cat ? "" : "italic"}`}>{cat || NONE_LABEL}</span>
                  {!open && hasActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                  <span className="shrink-0 text-[11px] font-normal opacity-70">{rows.length}</span>
                </button>
                {open && <ul>{rows.map((p) => row(p, true))}</ul>}
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
