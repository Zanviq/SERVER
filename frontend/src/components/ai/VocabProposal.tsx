import { useState } from "react";
import { BookMarked, Check } from "lucide-react";

export interface VocabProposalData {
  proposal: { word: string; pos?: string; meaning?: string; exists?: boolean }[];
  context?: string;
  tags?: string[];
}

interface Props {
  data: VocabProposalData;
  disabled?: boolean;
  /** 사용자가 고른 단어를 채팅 메시지로 돌려보낸다 — AI가 add_vocab_words 로 사전 내용을 채운다 */
  onSubmit: (message: string) => void;
}

/**
 * AI가 "이 단어들 넣을까요?" 하고 내민 후보. 이미 있는 단어는 잠그고,
 * 나머지는 체크해 한 번에 넣는다. 넣기는 채팅으로 되돌려 보낸다 — 단어장 항목의
 * 뜻·예문·유의어를 채우는 건 결국 AI 몫이라 그 경로를 하나로 둔다.
 */
export function VocabProposal({ data, disabled, onSubmit }: Props) {
  const items = data.proposal ?? [];
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(items.filter((p) => !p.exists).map((p) => p.word)),
  );
  const [done, setDone] = useState(false);
  const selectable = items.filter((p) => !p.exists);
  const tags = data.tags ?? [];

  const toggle = (w: string) => {
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(w)) n.delete(w); else n.add(w);
      return n;
    });
  };

  const submit = () => {
    const picked = items.filter((p) => checked.has(p.word) && !p.exists);
    if (picked.length === 0) return;
    const list = picked.map((p) => (p.meaning ? `${p.word}(${p.meaning})` : p.word)).join(", ");
    const ctx = data.context ? `\n문맥: ${data.context}` : "";
    onSubmit(`단어장에 넣어줘: ${list}${ctx}`);
    setDone(true);
  };

  if (items.length === 0) return null;

  return (
    <div className="card px-3.5 py-3">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium">
        <BookMarked size={14} className="text-accent" />
        단어장에 넣을까요?
        {tags.length > 0 && (
          <span className="ml-auto truncate text-[11px] font-normal text-fg-muted" title={tags.join(", ")}>
            태그: {tags.join(", ")}
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {items.map((p) => {
          const locked = !!p.exists || done;
          const on = checked.has(p.word) && !p.exists;
          return (
            <li key={p.word}>
              <label className={`flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-[13px] ${locked ? "cursor-default opacity-70" : "hover:bg-hovered"}`}>
                <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(p.word)} className="mt-[3px] accent-[rgb(var(--accent))]" />
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{p.word}</span>
                  {p.pos && <span className="ml-1 text-[11px] text-fg-muted">{p.pos}</span>}
                  {p.meaning && <span className="ml-2 text-fg2">{p.meaning}</span>}
                </span>
                {p.exists && <span className="badge shrink-0">이미 있음</span>}
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex items-center gap-2">
        {done ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-positive"><Check size={13} /> 넣어 달라고 했습니다</span>
        ) : selectable.length === 0 ? (
          <span className="text-[12px] text-fg-muted">모두 단어장에 있습니다</span>
        ) : (
          <>
            <button type="button" className="btn btn-primary h-8 px-3 text-[12.5px]" disabled={disabled || checked.size === 0} onClick={submit}>
              선택한 {checked.size}개 넣기
            </button>
            <button type="button" className="btn btn-ghost h-8 px-2 text-[12px]"
              onClick={() => setChecked(checked.size === selectable.length ? new Set() : new Set(selectable.map((p) => p.word)))}>
              {checked.size === selectable.length ? "모두 해제" : "모두 선택"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
