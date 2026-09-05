import { useState } from "react";
import { BookMarked, Check, Loader2 } from "lucide-react";
import { api, VocabKind } from "../../lib/api";
import { toast } from "../../store/toast";
import { vocabJobs } from "../../store/vocabJobs";

export interface VocabProposalData {
  proposal: { word: string; kind?: VocabKind; pos?: string; meaning?: string; exists?: boolean }[];
  context?: string;
  tags?: string[];
}

interface Props {
  data: VocabProposalData;
  /** 화면이 정한 태그(논문 제목 등). 후보를 올린 시점이 아니라 **누르는 시점**의 값이다. */
  tags?: string[];
}

const KIND_LABEL: Record<string, string> = {
  phrase: "표현", sentence: "문장", grammar: "문법", term: "용어",
};

/**
 * AI가 "이것들 넣을까요?" 하고 내민 후보. 이미 있는 것은 잠그고 나머지를 체크해 넣는다.
 *
 * 넣기는 **모델을 다시 거치지 않는다.** 예전에는 "단어장에 넣어줘: …" 를 채팅으로
 * 되돌려 보냈는데, 모델이 직전 대화에 남은 후보 전체를 보고 고르지 않은 것까지
 * 넣는 일이 있었다. 지금은 고른 목록을 서버로 바로 보내고(/api/vocab/fill)
 * 사전 내용은 백그라운드에서 채운다 — 그동안 대화는 계속할 수 있다.
 */
export function VocabProposal({ data, tags }: Props) {
  const items = data.proposal ?? [];
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(items.filter((p) => !p.exists).map((p) => p.word)),
  );
  const [sent, setSent] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const selectable = items.filter((p) => !p.exists);

  const toggle = (w: string) => {
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(w)) n.delete(w); else n.add(w);
      return n;
    });
  };

  const submit = async () => {
    const picked = items.filter((p) => checked.has(p.word) && !p.exists);
    if (picked.length === 0 || busy) return;
    setBusy(true);
    try {
      const job = await api.vocabFill(
        picked.map((p) => ({ word: p.word, meaning: p.meaning ?? "", kind: p.kind })),
        { tags: tags?.length ? tags : data.tags ?? [], context: data.context ?? "" },
      );
      vocabJobs.track(job);
      setSent(picked.map((p) => p.word));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "단어장에 넣지 못했습니다");
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) return null;
  const shownTags = tags?.length ? tags : data.tags ?? [];

  return (
    <div className="card px-3.5 py-3">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium">
        <BookMarked size={14} className="text-accent" />
        단어장에 넣을까요?
        {shownTags.length > 0 && (
          <span className="ml-auto truncate text-[11px] font-normal text-fg-muted" title={shownTags.join(", ")}>
            태그: {shownTags.join(", ")}
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {items.map((p) => {
          const picked = sent?.includes(p.word);
          const locked = !!p.exists || sent !== null;
          const on = picked ?? (checked.has(p.word) && !p.exists);
          return (
            <li key={p.word}>
              <label className={`flex items-start gap-2 rounded-md px-1.5 py-1 text-[13px] ${locked ? "opacity-70" : "cursor-pointer hover:bg-hovered"}`}>
                <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(p.word)} className="mt-[3px] accent-[rgb(var(--accent))]" />
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{p.word}</span>
                  {p.kind && KIND_LABEL[p.kind] && (
                    <span className="ml-1.5 rounded-sm bg-subtle px-1 py-[1px] text-[10px] text-fg-muted">{KIND_LABEL[p.kind]}</span>
                  )}
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
        {sent ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-positive">
            <Check size={13} /> {sent.length}개를 넣는 중입니다 — 끝나면 단어장에 나타납니다
          </span>
        ) : selectable.length === 0 ? (
          <span className="text-[12px] text-fg-muted">모두 단어장에 있습니다</span>
        ) : (
          <>
            <button type="button" className="btn btn-primary h-8 px-3 text-[12.5px]" disabled={busy || checked.size === 0} onClick={submit}>
              {busy && <Loader2 size={13} className="animate-spin" />}
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
