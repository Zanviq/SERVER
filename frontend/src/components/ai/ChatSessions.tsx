import { useEffect, useRef, useState } from "react";
import { Check, MessageSquare, Pencil, Plus, Trash2, X } from "lucide-react";

export interface ChatSession {
  id: string;
  title: string;
  turns: number;
  created_at: number;
  updated_at: number;
}

interface Props {
  sessions: ChatSession[];
  active: string;
  onPick: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDrop: (id: string) => void;
  busy?: boolean;
}

function when(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const days = Math.floor((Date.now() - ts * 1000) / 86400000);
  if (days <= 0) return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "어제";
  if (days < 7) return `${days}일 전`;
  return d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

/** 이름 고치기 — 목록과 드롭다운이 같이 쓴다. */
function Rename({ value, onDone }: { value: string; onDone: (t: string) => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.select(); }, []);
  return (
    <input
      ref={ref} value={text} onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onDone(text); }
        if (e.key === "Escape") { e.preventDefault(); onDone(value); }
      }}
      onClick={(e) => e.stopPropagation()}
      className="input h-6 w-full px-1.5 text-[12px]"
    />
  );
}

/**
 * 대화 목록 — **왼쪽 사이드바** 꼴(AI 비서 화면).
 *
 * 세션은 가지와 다르다. 가지는 한 이야기 안에서 갈라지는 것이고, 세션은 아예 다른
 * 이야기다(앞 맥락을 하나도 안 쓴다).
 */
export function ChatSessionList({
  sessions, active, onPick, onNew, onRename, onDrop, busy,
}: Props) {
  const [editing, setEditing] = useState("");
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <button type="button" onClick={onNew} disabled={busy}
        className="btn btn-ghost h-9 w-full justify-start gap-2 border border-line px-3 text-[13px] disabled:opacity-50">
        <Plus size={15} /> 새 대화
      </button>
      <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
        최근 대화
      </p>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-auto pr-0.5 [scrollbar-width:thin]">
        {sessions.map((s) => (
          <li key={s.id}>
            <div
              onClick={() => editing !== s.id && onPick(s.id)}
              className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] ${
                s.id === active ? "bg-accent-muted text-accent-fg" : "text-fg2 hover:bg-hovered"}`}>
              <MessageSquare size={13} className="mt-[3px] shrink-0 self-start opacity-70" />
              {editing === s.id ? (
                <Rename value={s.title} onDone={(t) => { setEditing(""); if (t !== s.title) onRename(s.id, t); }} />
              ) : (
                <>
                  {/* 제목과 시각을 **두 줄로** 나눈다. 한 줄에 나란히 두면 좁은
                      사이드바에서 제목이 "역…" 한 글자로 잘린다(실측). */}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={s.title}>{s.title}</span>
                    <span className="block text-[10.5px] text-fg-muted">
                      {s.turns > 0 ? `${s.turns}턴 · ` : ""}{when(s.updated_at)}
                    </span>
                  </span>
                  {/* 마우스는 올리면 보이고, **손가락·자판으로는 늘 보인다**(디자인 7차). opacity-0 만 두던 때는 휴대폰에서
                      보이지 않는 채 눌렸고, .tap 으로 넓힌 자리가 시각 글자 위를 덮어 한 번 스치면 대화가 지워졌다 — 이제
                      넓히지 않고(붙은 두 단추의 넓힌 자리가 겹치면 옆 것이 눌린다) 손가락 화면에서 크기를 키운다. */}
                  <span className="flex shrink-0 self-start opacity-0 group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100">
                    <button type="button" aria-label={`${s.title} 이름 바꾸기`}
                      onClick={(e) => { e.stopPropagation(); setEditing(s.id); }}
                      className="grid h-6 w-6 place-items-center rounded hover:bg-hovered coarse:h-8 coarse:w-8">
                      <Pencil size={11} />
                    </button>
                    <button type="button" aria-label={`${s.title} 지우기`}
                      onClick={(e) => { e.stopPropagation(); onDrop(s.id); }}
                      className="grid h-6 w-6 place-items-center rounded hover:bg-hovered hover:text-danger coarse:h-8 coarse:w-8">
                      <X size={12} />
                    </button>
                  </span>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 대화 고르기 — **드롭다운** 꼴(캘린더·논문·영어·회의 화면).
 *
 * 이 화면들에는 이미 왼쪽에 제 목록(논문·회의·단어장)이 있다. 대화 목록까지
 * 사이드바로 두면 화면이 목록으로만 찬다 — 채팅 상자 위에 접어 둔다.
 */
export function ChatSessionPicker({
  sessions, active, onPick, onNew, onRename, onDrop, busy,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const cur = sessions.find((s) => s.id === active);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => setOpen((v) => !v)}
          aria-label="대화 고르기" aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-fg2 hover:bg-hovered coarse:py-2">
          <MessageSquare size={13} className="shrink-0 text-accent" />
          <span className="min-w-0 truncate">{cur?.title ?? "새 대화"}</span>
          {sessions.length > 1 && (
            <span className="shrink-0 text-[10.5px] text-fg-muted">
              {sessions.findIndex((s) => s.id === active) + 1}/{sessions.length}
            </span>
          )}
          <svg width="9" height="9" viewBox="0 0 10 10" className="shrink-0 opacity-60">
            <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
        <button type="button" onClick={onNew} disabled={busy}
          aria-label="새 대화" title="새 대화 — 앞 이야기를 이어받지 않습니다"
          className="tap grid h-7 w-7 shrink-0 place-items-center rounded text-fg-muted hover:bg-hovered hover:text-accent disabled:opacity-40">
          <Plus size={14} />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-[min(52vh,340px)] w-[min(320px,90vw)] overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
          {sessions.map((s) => (
            <div key={s.id}
              onClick={() => { if (editing !== s.id) { onPick(s.id); setOpen(false); } }}
              className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] ${
                s.id === active ? "bg-accent-muted text-accent-fg" : "text-fg2 hover:bg-hovered"}`}>
              {s.id === active ? <Check size={12} className="shrink-0" />
                : <span className="w-3 shrink-0" />}
              {editing === s.id ? (
                <Rename value={s.title} onDone={(t) => { setEditing(""); if (t !== s.title) onRename(s.id, t); }} />
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate" title={s.title}>{s.title}</span>
                  <span className="shrink-0 text-[10.5px] text-fg-muted">
                    {s.turns > 0 ? `${s.turns}턴 · ` : ""}{when(s.updated_at)}
                  </span>
                  <button type="button" aria-label={`${s.title} 이름 바꾸기`}
                    onClick={(e) => { e.stopPropagation(); setEditing(s.id); }}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded opacity-0 hover:bg-hovered group-hover:opacity-100 focus-visible:opacity-100 coarse:h-8 coarse:w-8 coarse:opacity-100">
                    <Pencil size={11} />
                  </button>
                  <button type="button" aria-label={`${s.title} 지우기`}
                    onClick={(e) => { e.stopPropagation(); onDrop(s.id); }}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded opacity-0 hover:bg-hovered hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 coarse:h-8 coarse:w-8 coarse:opacity-100">
                    <Trash2 size={11} />
                  </button>
                </>
              )}
            </div>
          ))}
          <button type="button" onClick={() => { onNew(); setOpen(false); }}
            className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-accent hover:bg-hovered">
            <Plus size={13} /> 새 대화
          </button>
        </div>
      )}
    </div>
  );
}
