import { ReactNode, useEffect, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Pencil, RefreshCw, Sparkles, Star } from "lucide-react";
import { Paper } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { paperTitle } from "./PaperList";

interface Props {
  paper: Paper;
  onUpdate: (patch: Partial<Paper>) => Promise<void> | void;
  /** 정보 화면에서 바로 묻기(키워드·섹션 클릭) */
  onAsk: (text: string) => void;
  onRetry: () => void;
}

const QUICK = [
  { label: "3줄 요약", ask: "이 논문을 3줄로 요약해줘." },
  { label: "핵심 기여", ask: "이 논문의 핵심 기여를 짚어줘. 기존 연구와 무엇이 다른지도." },
  { label: "방법 설명", ask: "이 논문의 방법(모델·실험 설계)을 단계별로 설명해줘." },
  { label: "한계·후속", ask: "이 논문의 한계와 후속 연구 아이디어를 정리해줘." },
  { label: "어려운 단어", ask: "이 논문 초록과 서론에서 어려운 영어 단어를 뽑아 단어장 후보로 제안해줘." },
];

/** 오른쪽 "정보" 탭 — AI가 뽑아 둔 메타데이터·요약, 그리고 내 메모. */
export function PaperInfo({ paper: p, onUpdate, onAsk, onRetry }: Props) {
  const [notes, setNotes] = useState(p.notes);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(p.title);
  useEffect(() => { setNotes(p.notes); setTitle(p.title); setEditingTitle(false); }, [p.id, p.notes, p.title]);

  const saveTitle = () => {
    setEditingTitle(false);
    if (title.trim() && title.trim() !== p.title) void onUpdate({ title: title.trim() });
  };

  return (
    <div className="space-y-4 overflow-auto p-3 text-[13px]">
      <div>
        {editingTitle ? (
          <input className="input h-8 text-[13.5px] font-semibold" value={title} autoFocus
            onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") { setTitle(p.title); setEditingTitle(false); } }} />
        ) : (
          <h2 className="group flex items-start gap-1.5 text-[14px] font-semibold leading-snug">
            <span className="min-w-0 flex-1">{paperTitle(p)}</span>
            <button type="button" onClick={() => setEditingTitle(true)} className="btn btn-ghost h-6 shrink-0 px-1 opacity-0 group-hover:opacity-100" title="제목 고치기" aria-label="제목 고치기"><Pencil size={12} /></button>
            <button type="button" onClick={() => onUpdate({ starred: !p.starred })} className="btn btn-ghost h-6 shrink-0 px-1" title={p.starred ? "별표 해제" : "별표"} aria-label="별표">
              <Star size={13} className={p.starred ? "fill-warning text-warning" : ""} />
            </button>
          </h2>
        )}
        {(p.authors.length > 0 || p.year || p.venue) && (
          <p className="mt-1 text-[12px] text-fg-muted">
            {p.authors.join(", ")}{p.authors.length > 0 && (p.year || p.venue) ? " · " : ""}{[p.year, p.venue].filter(Boolean).join(", ")}
          </p>
        )}
        <p className="mt-0.5 text-[11px] text-fg-subtle">{p.filename} · {formatBytes(p.size)}{p.pages ? ` · ${p.pages}쪽` : ""}</p>
      </div>

      {p.status === "pending" && (
        <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent-muted px-3 py-2 text-[12.5px] text-accent-fg">
          <Loader2 size={14} className="animate-spin" /> AI가 논문을 읽고 정보를 뽑는 중입니다. 대화는 지금도 됩니다.
        </div>
      )}
      {p.status === "failed" && (
        <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          <AlertCircle size={14} /> <span className="flex-1">{p.error || "정보를 뽑지 못했습니다."}</span>
          <button type="button" onClick={onRetry} className="btn btn-ghost h-7 gap-1 px-2 text-[12px]"><RefreshCw size={12} /> 다시</button>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {QUICK.map((qk) => (
          <button key={qk.label} type="button" onClick={() => onAsk(qk.ask)}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-fg2 hover:border-accent hover:text-accent">
            <Sparkles size={11} /> {qk.label}
          </button>
        ))}
      </div>

      {p.summary && <Block title="요약"><p className="whitespace-pre-wrap leading-relaxed">{p.summary}</p></Block>}
      {p.key_findings.length > 0 && (
        <Block title="핵심 발견">
          <ul className="list-disc space-y-0.5 pl-5">{p.key_findings.map((k, i) => <li key={i}>{k}</li>)}</ul>
        </Block>
      )}
      {p.methods && <Block title="방법"><p className="whitespace-pre-wrap leading-relaxed">{p.methods}</p></Block>}
      {p.limitations && <Block title="한계"><p className="whitespace-pre-wrap leading-relaxed">{p.limitations}</p></Block>}
      {p.keywords.length > 0 && (
        <Block title="키워드">
          <div className="flex flex-wrap gap-1">
            {p.keywords.map((k) => (
              <button key={k} type="button" onClick={() => onAsk(`이 논문에서 "${k}"가 무슨 뜻이고 어떤 역할인지 설명해줘.`)}
                className="rounded-full bg-subtle px-2 py-[2px] text-[11.5px] text-fg2 hover:bg-hovered hover:text-fg" title="눌러서 물어보기">{k}</button>
            ))}
          </div>
        </Block>
      )}
      {p.sections.length > 0 && (
        <Block title="목차" collapsible>
          <ol className="space-y-0.5">
            {p.sections.map((s, i) => (
              <li key={i}>
                <button type="button" onClick={() => onAsk(`"${s}" 섹션의 내용을 요약해줘.`)}
                  className="w-full truncate rounded px-1.5 py-0.5 text-left text-[12.5px] text-fg2 hover:bg-hovered hover:text-fg" title="눌러서 이 섹션 요약 요청">{s}</button>
              </li>
            ))}
          </ol>
        </Block>
      )}
      {p.abstract && (
        <Block title="Abstract" collapsible defaultOpen={false}>
          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg2">{p.abstract}</p>
        </Block>
      )}

      <Block title="내 메모">
        <textarea className="input h-auto py-2 text-[12.5px]" rows={5} value={notes} placeholder="읽으면서 남길 메모. AI도 이 메모를 본다."
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => { if (notes !== p.notes) void onUpdate({ notes }); }} />
      </Block>
    </div>
  );
}

function Block({ title, children, collapsible, defaultOpen = true }: { title: string; children: ReactNode; collapsible?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      {collapsible ? (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted hover:text-fg">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{title}
        </button>
      ) : (
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{title}</p>
      )}
      {(!collapsible || open) && children}
    </section>
  );
}
