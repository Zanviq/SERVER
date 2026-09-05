import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Modal } from "../ui/Modal";
import { api, VocabExample, VocabInput, VocabKind, VocabWord } from "../../lib/api";
import { KIND_LABEL } from "./kinds";
import { toast } from "../../store/toast";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 없으면 새 단어 */
  word?: VocabWord | null;
  /** 새 단어에 미리 붙일 태그(지금 거르고 있는 태그) */
  defaultTags?: string[];
  onSaved: (w: VocabWord) => void;
}

const splitLines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const splitComma = (s: string) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);

/** 단어를 손으로 넣거나 고친다. 보통은 AI가 채우지만, 뜻 하나 고치자고 채팅할 일은 아니다. */
export function WordEditModal({ open, onClose, word, defaultTags = [], onSaved }: Props) {
  const [w, setW] = useState("");
  const [kind, setKind] = useState<VocabKind>("");
  const [pos, setPos] = useState("");
  const [pron, setPron] = useState("");
  const [meanings, setMeanings] = useState("");
  const [syn, setSyn] = useState("");
  const [ant, setAnt] = useState("");
  const [def, setDef] = useState("");
  const [examples, setExamples] = useState<VocabExample[]>([]);
  const [forms, setForms] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);

  // 태그 기본값은 **내용**으로 비교한다 — 배열 정체성으로 두면 부모가 다시 그릴
  // 때마다(백그라운드 정리가 끝났을 때 등) 입력 중인 폼이 초기화된다.
  const tagSeed = defaultTags.join(", ");
  useEffect(() => {
    if (!open) return;
    setW(word?.word ?? "");
    setKind(word?.kind ?? "");
    setPos(word?.pos ?? "");
    setPron(word?.pronunciation ?? "");
    setMeanings((word?.meanings ?? []).join("\n"));
    setSyn((word?.synonyms ?? []).join(", "));
    setAnt((word?.antonyms ?? []).join(", "));
    setDef(word?.english_def ?? "");
    setExamples(word?.examples ?? []);
    setForms(word?.forms ?? "");
    setNotes(word?.notes ?? "");
    setTags(word ? word.tags.join(", ") : tagSeed);
    setContext(word?.context ?? "");
  }, [open, word, tagSeed]);

  const save = async () => {
    if (!w.trim()) { toast.error("단어를 입력하세요"); return; }
    const body: VocabInput = {
      word: w.trim(), kind, pos: pos.trim(), pronunciation: pron.trim(),
      meanings: splitLines(meanings), synonyms: splitComma(syn), antonyms: splitComma(ant),
      english_def: def.trim(), examples: examples.filter((e) => e.en.trim()),
      forms: forms.trim(), notes: notes.trim(), tags: splitComma(tags), context: context.trim(),
    };
    setBusy(true);
    try {
      if (word) {
        onSaved(await api.vocabUpdate(word.id, body));
        toast.ok("고쳤습니다");
      } else {
        const r = await api.vocabCreate(body);
        onSaved(r.word);
        toast.ok(r.merged ? "이미 있던 단어에 합쳤습니다" : "단어장에 넣었습니다");
      }
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  };

  const setEx = (i: number, patch: Partial<VocabExample>) =>
    setExamples((arr) => arr.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <Modal open={open} onClose={onClose} title={word ? `${word.word} 수정` : "단어 추가"} width="max-w-xl">
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2">
          <div>
            <label className="label mb-1 block">단어·문장·용어</label>
            <input className="input" value={w} onChange={(e) => setW(e.target.value)} placeholder="adequate" autoFocus />
          </div>
          <div className="w-24">
            <label className="label mb-1 block">갈래</label>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as VocabKind)} aria-label="갈래">
              <option value="">자동</option>
              {Object.entries(KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
          <div className="w-24">
            <label className="label mb-1 block">품사</label>
            <input className="input" value={pos} onChange={(e) => setPos(e.target.value)} placeholder="형용사" />
          </div>
          <div className="w-32">
            <label className="label mb-1 block">발음</label>
            <input className="input" value={pron} onChange={(e) => setPron(e.target.value)} placeholder="/ˈædɪkwət/" />
          </div>
        </div>
        <div>
          <label className="label mb-1 block">뜻 (한 줄에 하나)</label>
          <textarea className="input h-auto py-2" rows={3} value={meanings} onChange={(e) => setMeanings(e.target.value)} placeholder={"충분한, 적당한\n(겨우) 만족스러운"} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label mb-1 block">비슷한 단어 (쉼표)</label>
            <input className="input" value={syn} onChange={(e) => setSyn(e.target.value)} placeholder="sufficient(충분한), enough" />
          </div>
          <div>
            <label className="label mb-1 block">반대말 (쉼표)</label>
            <input className="input" value={ant} onChange={(e) => setAnt(e.target.value)} placeholder="inadequate(불충분한)" />
          </div>
        </div>
        <div>
          <label className="label mb-1 block">영어 해설</label>
          <input className="input" value={def} onChange={(e) => setDef(e.target.value)} placeholder="Good enough in amount or quality for a purpose." />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="label">예문</label>
            <button type="button" className="btn btn-ghost h-7 px-2 text-[12px]" onClick={() => setExamples((a) => [...a, { en: "", ko: "", grammar: "" }])}>
              <Plus size={13} /> 예문
            </button>
          </div>
          <div className="space-y-2">
            {examples.map((ex, i) => (
              <div key={i} className="relative space-y-1 rounded-md border border-line p-2 pr-8">
                <input className="input h-8 text-[12.5px]" value={ex.en} onChange={(e) => setEx(i, { en: e.target.value })} placeholder="The food was adequate." />
                <input className="input h-8 text-[12.5px]" value={ex.ko} onChange={(e) => setEx(i, { ko: e.target.value })} placeholder="→ 음식은 그런대로 괜찮았다." />
                <input className="input h-8 text-[12.5px]" value={ex.grammar} onChange={(e) => setEx(i, { grammar: e.target.value })} placeholder="문법: be동사 + 형용사 보어" />
                <button type="button" onClick={() => setExamples((a) => a.filter((_, j) => j !== i))} aria-label="예문 삭제"
                  className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-hovered hover:text-danger">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label mb-1 block">변화형</label>
            <textarea className="input h-auto py-2" rows={2} value={forms} onChange={(e) => setForms(e.target.value)} placeholder={"run – ran – run – running"} />
          </div>
          <div>
            <label className="label mb-1 block">포인트</label>
            <textarea className="input h-auto py-2" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="enough보다 격식체" />
          </div>
        </div>
        <div>
          <label className="label mb-1 block">태그 (쉼표) — 어디서 온 단어인지</label>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Attention Is All You Need, 영어 학습" />
        </div>
        <div>
          <label className="label mb-1 block">만난 문장</label>
          <input className="input" value={context} onChange={(e) => setContext(e.target.value)} placeholder="이 단어가 나온 원문 문장" />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-secondary" onClick={onClose}>취소</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{word ? "저장" : "추가"}</button>
        </div>
      </div>
    </Modal>
  );
}
