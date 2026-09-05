import { useEffect, useRef, useState } from "react";
import { Loader2, PencilLine, Sparkles } from "lucide-react";
import { Modal } from "../ui/Modal";
import { api } from "../../lib/api";
import { toast } from "../../store/toast";
import { vocabJobs } from "../../store/vocabJobs";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 지금 거르고 있는 태그 — 넣는 항목에 그대로 붙는다 */
  tags?: string[];
  /** "직접 입력" — 형식을 갖춰 한 항목만 넣고 싶을 때 */
  onManual: () => void;
}

const PLACEHOLDER = `adequate
give up
He has been working here since 2020.
현재완료진행형
self-attention`;

/**
 * 형식 없이 **나열해서 넣기**. 단어든 문장이든 문법 이름이든 전문 용어든
 * 생각나는 대로 적으면 AI 가 갈래를 나누고 사전 내용을 채운다.
 *
 * 공부하다 손이 멈추지 않아야 해서 이렇게 만들었다 — 항목마다 형식을 갖춰
 * 입력하게 하면 결국 안 넣게 된다. 정리는 백그라운드에서 돌고 모달은 바로 닫힌다.
 */
export function VocabCollectModal({ open, onClose, tags = [], onManual }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setText("");
      setTimeout(() => ref.current?.focus(), 50);
    }
  }, [open]);

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      vocabJobs.track(await api.vocabCollect(body, tags));
      toast.ok("정리를 시작했습니다. 끝나면 단어장에 들어옵니다");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "정리를 시작하지 못했습니다");
    } finally {
      setBusy(false);
    }
  };

  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;

  /** 붙여 넣은 목록을 Esc 한 번으로 잃지 않게. 빈 채면 그냥 닫힌다. */
  const guardedClose = () => {
    if (text.trim() && !confirm("적은 내용이 사라집니다. 닫을까요?")) return;
    onClose();
  };

  return (
    <Modal open={open} onClose={guardedClose} title="단어장에 모아 넣기" width="max-w-lg">
      <div className="space-y-3">
        <p className="text-[12.5px] text-fg-muted">
          단어·표현·문장·문법·전문 용어를 형식 없이 적으세요. AI 가 갈래를 나누고 뜻·예문·문법 포인트를
          채워 넣습니다. <span className="text-fg2">넣는 동안에도 계속 공부할 수 있습니다.</span>
        </p>
        <textarea
          ref={ref}
          className="input h-auto py-2 font-mono text-[12.5px] leading-relaxed"
          rows={9}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
          }}
          placeholder={PLACEHOLDER}
        />
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] text-fg-subtle">
            {lines > 0 ? `${lines}줄` : "한 줄에 하나씩, 쉼표로 나열해도 됩니다"}
            {tags.length > 0 && ` · 태그: ${tags.join(", ")}`}
          </span>
          <button type="button" className="btn btn-ghost ml-auto h-8 gap-1 px-2 text-[12px]"
            onClick={() => { onClose(); onManual(); }} title="한 항목을 형식대로 직접 입력">
            <PencilLine size={13} /> 직접 입력
          </button>
          <button type="button" className="btn btn-primary h-8" onClick={submit} disabled={busy || !text.trim()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} 정리해서 넣기
          </button>
        </div>
      </div>
    </Modal>
  );
}
