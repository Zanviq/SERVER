import { ReactNode, useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, FolderClosed, Loader2, Pencil, RefreshCw, Sparkles, Star } from "lucide-react";
import { Paper } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { isSubmitEnter } from "../../lib/keys";
import { usePendingSave } from "../../lib/usePendingSave";
import { paperTitle } from "./PaperList";
import { LinkTextarea } from "../links/LinkTextarea";
import { REVEAL_ON_ROW } from "../ui/reveal";

interface Props {
  paper: Paper;
  /** 쓰이고 있는 폴더 이름(자동완성) */
  categories?: string[];
  onUpdate: (patch: Partial<Paper>) => Promise<void> | void;
  /**
   * 치는 동안 모아 보내는 메모 저장. base 는 화면이 아는 서버 메모 — 그 사이 바뀌었으면 "conflict"
   * (서버가 덮지 않았다). "fail" 이면 다시 해 본다. keepalive 는 페이지가 닫히는 중의 저장.
   */
  onSaveNotes: (text: string, base: string, keepalive: boolean) => Promise<"ok" | "conflict" | "fail">;
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

/** 메모 상한. 서버(paper_store MAX_TEXT * 2)와 같은 값이어야 한다. */
const MAX_NOTES = 12000;

/** 오른쪽 "정보" 탭 — AI가 뽑아 둔 메타데이터·요약, 그리고 내 메모. */
export function PaperInfo({ paper: p, categories = [], onUpdate, onSaveNotes, onAsk, onRetry }: Props) {
  const [notes, setNotes] = useState(p.notes);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(p.title);
  const [category, setCategory] = useState(p.category);
  const [filename, setFilename] = useState(p.filename);
  //: 아직 저장하지 않은 손글이 있는가. 있으면 밖에서 온 값으로 덮지 않는다.
  const editing = useRef(false);
  //: 내가 치는 동안 서버 쪽 메모가 달라졌다(AI 가 적었거나 다른 기기에서 고쳤다)
  const [noteConflict, setNoteConflict] = useState(false);
  // 메모는 칠 때마다 모아 두었다 보낸다(42차). 칸을 벗어날 때(blur)만 보냈더니 새로고침·탭 닫기·
  // 휴대폰 앱 전환(blur 없이 숨겨진다)에 친 메모가 사라졌다. 다른 논문·다른 탭으로 갈 때와 페이지가
  // 숨겨질 때(keepalive)도 usePendingSave 가 보낸다.
  const notesSave = usePendingSave([p.id]);
  //: 내가 마지막으로 보낸 메모(서버는 앞뒤 공백을 떼고 적는다) — 그것이 돌아온 것은 "다른 곳에서 바뀜"이 아니다
  const sentNotes = useRef<string | null>(null);
  //: 화면이 아는 서버 쪽 메모. 보낼 때 base 로 실어, 그 사이 다른 곳에서 바뀌었으면 서버가 덮지 않는다(409).
  //: 모아 보내면 화면이 목록을 다시 받기 전에 저장이 나가므로, 화면 쪽 알림만으로는 늦다(실측: 다른
  //: 기기가 쓴 메모가 1.5초 만에 사라졌다).
  const seenNotes = useRef(p.notes);
  seenNotes.current = p.notes;
  const conflictRef = useRef<HTMLParagraphElement>(null);
  const sendNotes = (text: string, ms: number) =>
    notesSave.schedule(ms, async ({ keepalive }) => {
      sentNotes.current = text.trim();
      const r = await onSaveNotes(text, seenNotes.current, keepalive);
      if (r === "conflict") {
        // 서버가 덮지 않았다. 치던 글은 칸에 두고 알린다(목록을 다시 받으면 그쪽 내용이 온다).
        editing.current = true;
        setNoteConflict(true);
      }
      return r !== "fail"; // 실패만 다시 해 본다 — 충돌은 사용자가 고른다
    });
  const typeNotes = (text: string) => {
    editing.current = true;
    setNotes(text);
    // 다른 곳에서 바뀐 것을 알리는 중이면 모아 보내지 않는다 — 사용자가 고르기 전에 그쪽 내용을
    // 덮어 버린다. 그때는 예전처럼 칸을 벗어날 때 보낸다(알림이 "지금 저장하면 덮어씁니다"라고 말한다).
    if (noteConflict) return;
    sendNotes(text, 1500);
  };

  useEffect(() => { setTitle(p.title); setEditingTitle(false); }, [p.id, p.title]);
  useEffect(() => {
    // **치던 글을 덮지 않는다.** "메모에 정리해 줘"를 시켜 두고 정보 탭에서 직접
    // 메모를 쓰고 있으면, AI 가 끝나는 순간 목록을 다시 받아 오면서 여기까지
    // 새 값으로 갈아치웠다 — 치던 문장이 눈앞에서 사라진다.
    if (editing.current && p.notes !== notes) {
      // 내가 보낸 것이 돌아왔다(그 뒤로 더 쳤을 뿐) — 다른 곳에서 바뀐 것이 아니다
      if (p.notes === sentNotes.current) return;
      // 모아 둔 저장이 곧 나가면 사용자가 고르기도 전에 그쪽 내용을 덮는다
      notesSave.cancel();
      setNoteConflict(true);
      return;
    }
    setNotes(p.notes);
    setNoteConflict(false);
  }, [p.id, p.notes]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 논문을 바꾸면 그 논문 메모다 — 무조건 새로 채운다
  useEffect(() => { editing.current = false; setNotes(p.notes); setNoteConflict(false); }, [p.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCategory(p.category); setFilename(p.filename); }, [p.id, p.category, p.filename]);

  const saveTitle = () => {
    setEditingTitle(false);
    if (title.trim() && title.trim() !== p.title) void onUpdate({ title: title.trim() });
  };
  const saveCategory = () => {
    if (category.trim() !== p.category) void onUpdate({ category: category.trim() });
  };
  const saveFilename = () => {
    const next = filename.trim();
    if (!next) { setFilename(p.filename); return; }
    if (next !== p.filename) void onUpdate({ filename: next });
  };

  return (
    <div className="space-y-4 overflow-auto p-3 text-[13px]">
      <div>
        {editingTitle ? (
          <input className="input h-8 text-[13.5px] font-semibold" value={title} autoFocus
            onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => { if (isSubmitEnter(e)) saveTitle(); if (e.key === "Escape") { setTitle(p.title); setEditingTitle(false); } }} />
        ) : (
          <h2 className="group flex items-start gap-1.5 text-[14px] font-semibold leading-snug">
            <span className="min-w-0 flex-1">{paperTitle(p)}</span>
            <button type="button" onClick={() => setEditingTitle(true)} className={`btn btn-ghost h-6 shrink-0 px-1 ${REVEAL_ON_ROW}`} title="제목 고치기" aria-label="제목 고치기"><Pencil size={12} /></button>
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
        <p className="mt-0.5 text-[11px] text-fg-subtle">{formatBytes(p.size)}{p.pages ? ` · ${p.pages}쪽` : ""}</p>
      </div>

      {/* 폴더와 파일 이름 — 목록에서 어디에 놓일지, 내려받을 때 무엇으로 저장될지 */}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="label mb-1 flex items-center gap-1"><FolderClosed size={11} /> 폴더</span>
          <input className="input h-8 text-[12.5px]" value={category} list="paper-categories"
            placeholder="분류 없음" aria-label="폴더"
            onChange={(e) => setCategory(e.target.value)} onBlur={saveCategory}
            onKeyDown={(e) => {
              if (isSubmitEnter(e)) e.currentTarget.blur();
              if (e.key === "Escape") { setCategory(p.category); e.currentTarget.blur(); }
            }} />
          <datalist id="paper-categories">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </label>
        <label className="block">
          <span className="label mb-1 block">파일 이름</span>
          <input className="input h-8 font-mono text-[12px]" value={filename} aria-label="파일 이름"
            onChange={(e) => setFilename(e.target.value)} onBlur={saveFilename}
            onKeyDown={(e) => {
              if (isSubmitEnter(e)) e.currentTarget.blur();
              if (e.key === "Escape") { setFilename(p.filename); e.currentTarget.blur(); }
            }} />
        </label>
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
        {/* maxLength 는 서버 상한(paper_store MAX_TEXT * 2)과 같아야 한다. 없으면
            더 적을 수 있는 것처럼 보이다가, 저장할 때 서버가 말없이 뒤를 잘라
            **화면에서 글이 사라진다**(저장 뒤 서버 값으로 다시 채우므로). */}
        <LinkTextarea preview className="input h-auto py-2 text-[12.5px]" rows={5} value={notes} maxLength={MAX_NOTES}
          placeholder="읽으면서 남길 메모. AI도 이 메모를 본다. (마크다운 · [ 로 문서·회의 연결)"
          onChange={(e) => typeNotes(e.target.value)}
          onBlur={(e) => {
            // 알림의 단추로 가는 길이면 저장하지 않는다. 예전엔 단추를 누르는 순간(포커스가 옮겨 가며)
            // 이 blur 가 치던 메모로 **덮어 저장하고** 알림을 내려, 단추는 눌리기도 전에 사라졌다 —
            // "바뀐 내용 보기"는 마우스로도 키보드로도 한 번도 될 수 없었다(42차).
            if (conflictRef.current?.contains(e.relatedTarget as Node | null)) return;
            // 알림 중이라 모아 두지 않은 것은 여기서 보낸다 — 알림이 말한 대로 그쪽 내용을 덮는다(본 것을
            // base 로 실으므로 서버가 받는다). 모아 둔 것은 곧바로 보낸다.
            if (noteConflict && notes.trim() !== p.notes) sendNotes(notes, 0);
            void notesSave.flush();
            editing.current = false;
            setNoteConflict(false);
          }} />
        {noteConflict && (
          // 어느 쪽을 살릴지는 사용자가 정한다. 말없이 덮거나 말없이 버리지 않는다.
          <p ref={conflictRef} className="mt-1 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11.5px] text-warning">
            <AlertCircle size={12} className="mt-[2px] shrink-0" />
            <span>
              그 사이 메모가 다른 곳에서 바뀌었습니다(AI 또는 다른 기기). 지금 저장하면
              그쪽 내용을 덮어씁니다 —{" "}
              <button type="button" className="underline"
                // 누르는 동안 메모 칸의 포커스를 두어 blur 저장이 일지 않게(마우스). 키보드는 위 onBlur 가 거른다.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  notesSave.cancel(); // 치던 것을 보내면 방금 고른 그쪽 내용을 덮는다
                  editing.current = false; setNotes(p.notes); setNoteConflict(false);
                }}>
                바뀐 내용 보기
              </button>
            </span>
          </p>
        )}
        {notes.length > MAX_NOTES * 0.9 && (
          <p className="mt-1 text-[11px] text-fg-muted">
            {notes.length.toLocaleString()} / {MAX_NOTES.toLocaleString()}자
            {notes.length >= MAX_NOTES && " — 여기까지만 저장됩니다"}
          </p>
        )}
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
