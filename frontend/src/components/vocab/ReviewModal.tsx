import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, RotateCcw, X } from "lucide-react";
import { Modal } from "../ui/Modal";
import { api, VocabWord } from "../../lib/api";
import { toast } from "../../store/toast";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 이 태그의 단어만 복습(빈 문자열이면 전체) */
  tag?: string;
  /** 판정을 하나라도 보냈으면 닫을 때 단어장을 새로 고치라고 알린다 */
  onDone: (reviewed: number) => void;
}

/**
 * 플래시카드 복습. 앞면은 단어, 뒤집으면 뜻·영어 해설·예문 하나.
 * "알아요"면 단계가 오르고 다음 복습일이 멀어진다(간격 반복), "몰라요"면 0단계로.
 * 키보드: Space 뒤집기, 1 몰라요, 2 알아요.
 */
export function ReviewModal({ open, onClose, tag = "", onDone }: Props) {
  const [queue, setQueue] = useState<VocabWord[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [okCount, setOkCount] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQueue(null); setIdx(0); setFlipped(false); setOkCount(0);
    api.vocabReviewQueue(tag, 20)
      .then(setQueue)
      .catch((e) => { toast.error(e instanceof Error ? e.message : "복습 목록을 못 받았습니다"); setQueue([]); });
  }, [open, tag]);

  const cur = queue?.[idx];
  const finished = queue !== null && idx >= queue.length;

  const judge = useCallback(async (ok: boolean) => {
    if (!cur || busy) return;
    setBusy(true);
    try {
      await api.vocabReview(cur.id, ok);
      if (ok) setOkCount((n) => n + 1);
      setIdx((i) => i + 1);
      setFlipped(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }, [cur, busy]);

  useEffect(() => {
    if (!open || !cur) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === " ") { e.preventDefault(); setFlipped(true); }
      else if (e.key === "1" && flipped) void judge(false);
      else if (e.key === "2" && flipped) void judge(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, cur, flipped, judge]);

  const close = () => { onDone(idx); onClose(); };

  return (
    <Modal open={open} onClose={close} title={tag ? `복습 · ${tag}` : "복습"} width="max-w-md">
      {queue === null ? (
        <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-fg-muted" /></div>
      ) : queue.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-fg-muted">
          오늘 복습할 단어가 없습니다.
          <p className="mt-1 text-[12px] text-fg-subtle">AI와 대화하며 단어를 넣으면 다음 날부터 여기 나옵니다.</p>
        </div>
      ) : finished ? (
        <div className="space-y-4 py-4 text-center">
          <p className="text-2xl font-semibold">{okCount} / {queue.length}</p>
          <p className="text-[13px] text-fg-muted">
            {okCount === queue.length ? "전부 알고 있었습니다. 다음 복습은 더 뒤로 미뤄집니다." : `${queue.length - okCount}개는 내일 다시 나옵니다.`}
          </p>
          <button type="button" className="btn btn-primary" onClick={close}>닫기</button>
        </div>
      ) : cur ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-[12px] text-fg-muted">
            <span>{idx + 1} / {queue.length}</span>
            <span>단계 {cur.level}/5</span>
          </div>
          <button type="button" onClick={() => setFlipped(true)}
            className={`w-full rounded-lg border px-5 py-6 text-left transition-colors ${flipped ? "border-line bg-subtle" : "border-line-strong bg-surface hover:border-accent"}`}>
            <p className="text-center text-2xl font-semibold tracking-tight">{cur.word}</p>
            {cur.pronunciation && <p className="mt-1 text-center text-[12.5px] text-fg-muted">{cur.pronunciation}{cur.pos ? ` · ${cur.pos}` : ""}</p>}
            {!flipped ? (
              <p className="mt-5 text-center text-[12px] text-fg-subtle">눌러서 뜻 보기 (Space)</p>
            ) : (
              <div className="mt-4 space-y-2 text-[13px]">
                <ol className="list-decimal pl-5">
                  {cur.meanings.slice(0, 4).map((m, i) => <li key={i}>{m}</li>)}
                </ol>
                {cur.english_def && <p className="italic text-fg2">{cur.english_def}</p>}
                {cur.examples[0] && (
                  <p className="rounded-md bg-surface px-2.5 py-1.5 text-[12.5px]">
                    {cur.examples[0].en}
                    {cur.examples[0].ko && <span className="block text-fg2">→ {cur.examples[0].ko}</span>}
                  </p>
                )}
                {cur.tags.length > 0 && <p className="text-[11px] text-fg-subtle">{cur.tags.join(" · ")}</p>}
              </div>
            )}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-secondary h-10" disabled={!flipped || busy} onClick={() => judge(false)}>
              <X size={15} /> 몰라요 <kbd className="ml-1 text-[10px] text-fg-subtle">1</kbd>
            </button>
            <button type="button" className="btn btn-primary h-10" disabled={!flipped || busy} onClick={() => judge(true)}>
              <Check size={15} /> 알아요 <kbd className="ml-1 text-[10px] opacity-70">2</kbd>
            </button>
          </div>
          <button type="button" className="btn btn-ghost mx-auto flex h-8 text-[12px]" onClick={() => { setIdx((i) => i + 1); setFlipped(false); }}>
            <RotateCcw size={12} /> 건너뛰기
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
