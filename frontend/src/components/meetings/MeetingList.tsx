import { DragEvent, useMemo, useRef, useState } from "react";
import { AlertCircle, AudioLines, Loader2, Mic, MoreHorizontal, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { Meeting } from "../../lib/api";
import { Dropdown, DropdownItem } from "../ui/Dropdown";

interface Props {
  meetings: Meeting[];
  categories: string[];
  selectedId: string;
  onSelect: (id: string) => void;
  onRecord: () => void;
  onUpload: (files: File[]) => void;
  onDelete: (m: Meeting) => void;
  onRetry: (m: Meeting) => void;
  /** 올리는 중인 파일 수 */
  uploading: number;
  className?: string;
}

const AUDIO_RE = /\.(webm|mp3|m4a|mp4|wav|ogg|oga|flac|aac|aiff?)$/i;
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

export const meetingTitle = (m: Meeting) => m.title || m.filename.replace(/\.[^.]+$/, "") || `${m.date} 회의`;

/** "2026-09-05" → "9월 5일 (금)" */
export function dayLabel(day: string): string {
  const [y, mo, d] = day.split("-").map(Number);
  if (!y || !mo || !d) return day;
  const w = WEEKDAY[new Date(y, mo - 1, d).getDay()];
  const thisYear = new Date().getFullYear() === y;
  return `${thisYear ? "" : `${y}년 `}${mo}월 ${d}일 (${w})`;
}

/** 왼쪽 회의 목록 — 날짜별로 묶고 카테고리로 거른다. 녹음 파일을 끌어다 놓으면 올라간다. */
export function MeetingList({
  meetings, categories, selectedId, onSelect, onRecord, onUpload, onDelete, onRetry, uploading, className = "",
}: Props) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = meetings.filter((m) => {
      if (cat && m.category !== cat) return false;
      if (!needle) return true;
      return [meetingTitle(m), m.category, m.summary, m.date].some((s) => s?.toLowerCase().includes(needle));
    });
    // 목록은 서버가 날짜 내림차순으로 준다 — 그 순서대로 날짜 묶음을 만든다
    const out: { day: string; items: Meeting[] }[] = [];
    for (const m of list) {
      const last = out[out.length - 1];
      if (last && last.day === m.date) last.items.push(m);
      else out.push({ day: m.date, items: [m] });
    }
    return out;
  }, [meetings, q, cat]);

  const pickFiles = (files: FileList | null) => {
    if (!files) return;
    const audio = Array.from(files).filter((f) => AUDIO_RE.test(f.name) || f.type.startsWith("audio/") || f.type === "video/webm");
    if (audio.length) onUpload(audio);
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
        <span className="label">회의 {meetings.length}</span>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={onRecord} className="btn btn-ghost h-7 gap-1 px-2 text-[12px]" title="마이크로 녹음">
            <Mic size={14} /> 녹음
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} className="btn btn-ghost h-7 gap-1 px-2 text-[12px]" title="녹음 파일 올리기">
            {uploading > 0 ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {uploading > 0 ? `${uploading}개` : "올리기"}
          </button>
        </div>
        <input ref={fileRef} type="file" accept="audio/*,video/webm,.webm,.mp3,.m4a,.mp4,.wav,.ogg,.oga,.flac,.aac" multiple className="hidden"
          onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} />
      </div>
      <div className="space-y-2 border-b border-line p-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="제목·요약·카테고리…" aria-label="회의 검색"
            className="input h-8 pl-8 pr-7 text-[12.5px]" />
          {q && (
            <button onClick={() => setQ("")} aria-label="검색 지우기" className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"><X size={13} /></button>
          )}
        </div>
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <Chip on={cat === ""} onClick={() => setCat("")}>전체</Chip>
            {categories.map((c) => <Chip key={c} on={cat === c} onClick={() => setCat(cat === c ? "" : c)}>{c}</Chip>)}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-1">
        {groups.length === 0 && (
          <div className="px-3 py-10 text-center text-[12.5px] text-fg-muted">
            {meetings.length === 0 ? (
              <>
                <AudioLines size={22} className="mx-auto mb-2 text-fg-subtle" />
                녹음 버튼을 누르거나 녹음 파일을 여기로 끌어다 놓으세요.
                <p className="mt-1 text-[11.5px] text-fg-subtle">올리면 AI가 화자를 나눠 받아쓰고 요약합니다.</p>
              </>
            ) : "검색 결과가 없습니다."}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.day} className="mb-1">
            <div className="sticky top-0 z-[1] bg-surface px-2 pb-0.5 pt-1.5 text-[11px] font-semibold text-fg-muted">{dayLabel(g.day)}</div>
            <ul>
              {g.items.map((m) => {
                const active = m.id === selectedId;
                return (
                  <li key={m.id}>
                    <div
                      role="button" tabIndex={0}
                      onClick={() => onSelect(m.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(m.id); } }}
                      className={`group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${active ? "bg-accent-muted" : "hover:bg-hovered"}`}>
                      <span className="mt-[3px] shrink-0">
                        {m.status === "pending" ? <Loader2 size={14} className="animate-spin text-accent" />
                          : m.status === "failed" ? <AlertCircle size={14} className="text-danger" />
                          : <AudioLines size={14} className={active ? "text-accent" : "text-fg-muted"} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[13px] ${active ? "font-semibold text-accent-fg" : "font-medium"}`} title={meetingTitle(m)}>
                          {meetingTitle(m)}
                        </span>
                        <span className="block truncate text-[11px] text-fg-muted">
                          {m.status === "pending" ? "AI가 받아쓰는 중…"
                            : m.status === "failed" ? (m.error || "받아쓰기 실패")
                            : [m.category, m.docs ? `문서 ${m.docs}` : "", m.summary].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        <Dropdown align="end" width={170}
                          className={`grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-hovered hover:text-fg ${active ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
                          trigger={() => <MoreHorizontal size={14} />}>
                          {(close) => (
                            <>
                              <DropdownItem onClick={() => { onRetry(m); close(); }}>
                                <RefreshCw size={13} /> 다시 받아쓰기
                              </DropdownItem>
                              <DropdownItem onClick={() => { onDelete(m); close(); }} className="text-danger">
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
          </div>
        ))}
      </div>

      {over && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-accent-muted/70 text-[13px] font-medium text-accent-fg">
          <span className="flex items-center gap-2"><Upload size={16} /> 놓으면 올라갑니다</span>
        </div>
      )}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-accent bg-accent-muted text-accent-fg" : "border-line text-fg-muted hover:text-fg"}`}>
      {children}
    </button>
  );
}
