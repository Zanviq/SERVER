import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { BookMarked, GraduationCap, Loader2, Pencil, Plus, Search, Tag, X } from "lucide-react";
import { api, VocabBoard, VocabWord } from "../../lib/api";
import { toast } from "../../store/toast";
import { Modal } from "../ui/Modal";
import { WordCard, isDue } from "./WordCard";
import { WordEditModal } from "./WordEditModal";
import { ReviewModal } from "./ReviewModal";

type Sort = "recent" | "alpha" | "due";

interface Props {
  /** 값이 바뀌면 다시 받는다(AI가 단어장을 고쳤을 때 부모가 올린다) */
  refreshKey?: number;
  /** 처음 골라 둘 태그(논문 화면이면 그 논문 제목) */
  initialTag?: string;
  className?: string;
}

/**
 * 단어장. 태그는 폴더처럼 쓴다 — "어디서 이 단어를 가져왔는지"(논문 제목, 영어 학습).
 * 태그 이름으로 태그를 찾고, 고른 태그의 단어만 본다. 단어·뜻 검색은 그 위에 얹힌다.
 */
export function VocabPanel({ refreshKey = 0, initialTag = "", className = "" }: Props) {
  const [board, setBoard] = useState<VocabBoard | null>(null);
  const [tag, setTag] = useState(initialTag);
  const [tagQuery, setTagQuery] = useState("");
  const [q, setQ] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("recent");
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<VocabWord | null | undefined>(undefined); // undefined=닫힘, null=새 단어
  const [reviewOpen, setReviewOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");

  const load = useCallback(async () => {
    try {
      setBoard(await api.vocabBoard());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "단어장을 못 받았습니다");
    }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { if (initialTag) setTag(initialTag); }, [initialTag]);

  const today = new Date().toISOString().slice(0, 10);
  const words = useMemo(() => {
    if (!board) return [];
    const needle = q.trim().toLowerCase();
    const t = tag.toLowerCase();
    let list = board.words.filter((w) => {
      if (t && !w.tags.some((x) => x.toLowerCase() === t)) return false;
      if (dueOnly && !isDue(w, today)) return false;
      if (!needle) return true;
      return w.word.toLowerCase().includes(needle)
        || w.meanings.some((m) => m.toLowerCase().includes(needle))
        || w.synonyms.some((m) => m.toLowerCase().includes(needle));
    });
    if (sort === "alpha") list = [...list].sort((a, b) => a.word.localeCompare(b.word));
    else if (sort === "due") list = [...list].sort((a, b) => (a.next_review || "").localeCompare(b.next_review || "") || a.level - b.level);
    else list = [...list].sort((a, b) => b.created_at - a.created_at);
    return list;
  }, [board, q, tag, dueOnly, sort, today]);

  const tags = useMemo(() => {
    const needle = tagQuery.trim().toLowerCase();
    const all = board?.tags ?? [];
    return needle ? all.filter((t) => t.tag.toLowerCase().includes(needle)) : all;
  }, [board, tagQuery]);

  const remove = async (w: VocabWord) => {
    try {
      await api.vocabDelete(w.id);
      toast.ok(`"${w.word}" 휴지통으로`);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "삭제 실패");
    }
  };

  const doRename = async () => {
    if (!renaming || !renameTo.trim() || renameTo.trim() === renaming) { setRenaming(null); return; }
    try {
      const r = await api.vocabRenameTag(renaming, renameTo.trim());
      toast.ok(`${r.changed}개 단어의 태그를 바꿨습니다`);
      if (tag === renaming) setTag(renameTo.trim());
      setRenaming(null);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "이름 변경 실패");
    }
  };

  const stats = board?.stats;

  return (
    <div className={`card flex flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold">
          <BookMarked size={15} className="text-accent" /> 단어장
          {stats && <span className="text-[11.5px] font-normal text-fg-muted">{stats.total}</span>}
        </span>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={() => setReviewOpen(true)} className="btn btn-ghost h-7 gap-1 px-2 text-[12px]" title="플래시카드 복습">
            <GraduationCap size={14} />
            복습
            {stats && stats.due > 0 && <span className="badge badge-accent ml-0.5 px-1.5">{stats.due}</span>}
          </button>
          <button type="button" onClick={() => setEditing(null)} className="btn btn-ghost h-7 px-2" title="단어 직접 추가" aria-label="단어 추가">
            <Plus size={15} />
          </button>
        </div>
      </div>

      <div className="space-y-1.5 border-b border-line p-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="단어·뜻 검색…" aria-label="단어 검색"
            className="input h-8 pl-8 pr-7 text-[12.5px]" />
          {q && (
            <button onClick={() => setQ("")} aria-label="검색 지우기" className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"><X size={13} /></button>
          )}
        </div>
        <div className="relative">
          <Tag size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} placeholder="태그 찾기 (논문 제목·주제)…" aria-label="태그 검색"
            className="input h-8 pl-8 pr-7 text-[12.5px]" />
          {tagQuery && (
            <button onClick={() => setTagQuery("")} aria-label="태그 검색 지우기" className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"><X size={13} /></button>
          )}
        </div>
        <div className="flex max-h-24 flex-wrap gap-1 overflow-auto">
          {!tagQuery && (
            <Chip active={!tag} onClick={() => setTag("")}>전체{stats ? ` ${stats.total}` : ""}</Chip>
          )}
          {tags.map((t) => (
            <Chip key={t.tag} active={t.tag.toLowerCase() === tag.toLowerCase()} onClick={() => setTag(tag.toLowerCase() === t.tag.toLowerCase() ? "" : t.tag)}>
              {t.tag} <span className="opacity-60">{t.count}</span>
            </Chip>
          ))}
          {tags.length === 0 && tagQuery && <span className="px-1 text-[11.5px] text-fg-subtle">그런 태그가 없습니다</span>}
        </div>
        <div className="flex items-center gap-1 text-[11.5px]">
          <Chip active={dueOnly} onClick={() => setDueOnly((v) => !v)} tone="warning">오늘 복습{stats ? ` ${stats.due}` : ""}</Chip>
          {tag && (
            <button type="button" onClick={() => { setRenaming(tag); setRenameTo(tag); }} className="btn btn-ghost h-6 gap-1 px-1.5 text-[11px]" title="태그 이름 바꾸기">
              <Pencil size={11} /> 태그 이름
            </button>
          )}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="정렬"
            className="input ml-auto h-6 w-auto px-1.5 py-0 text-[11px]">
            <option value="recent">최근 추가</option>
            <option value="alpha">알파벳</option>
            <option value="due">복습 순</option>
          </select>
        </div>
      </div>

      <ul className="flex-1 space-y-0.5 overflow-auto p-1.5">
        {board === null ? (
          <li className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-fg-muted" /></li>
        ) : words.length === 0 ? (
          <li className="px-3 py-8 text-center text-[12.5px] text-fg-muted">
            {board.words.length === 0
              ? "아직 단어가 없습니다. 왼쪽에서 단어를 물어보고 \"단어장에 넣어줘\" 하면 여기 쌓입니다."
              : "조건에 맞는 단어가 없습니다."}
          </li>
        ) : (
          words.map((w) => (
            <WordCard key={w.id} word={w} open={openId === w.id} activeTag={tag}
              onToggle={() => setOpenId((v) => (v === w.id ? null : w.id))}
              onEdit={() => setEditing(w)}
              onDelete={() => remove(w)}
              onTag={(t) => setTag(t)} />
          ))
        )}
      </ul>

      <WordEditModal open={editing !== undefined} onClose={() => setEditing(undefined)} word={editing ?? null}
        defaultTags={tag ? [tag] : []} onSaved={() => void load()} />
      <ReviewModal open={reviewOpen} onClose={() => setReviewOpen(false)} tag={tag}
        onDone={(n) => { if (n > 0) void load(); }} />
      <Modal open={renaming !== null} onClose={() => setRenaming(null)} title="태그 이름 바꾸기" width="max-w-sm">
        <div className="space-y-3">
          <input className="input" value={renameTo} onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doRename(); }} />
          <p className="text-[12px] text-fg-muted">이 태그가 붙은 단어 전부에 적용됩니다.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setRenaming(null)}>취소</button>
            <button type="button" className="btn btn-primary" onClick={doRename}>바꾸기</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Chip({ active, onClick, children, tone }: { active: boolean; onClick: () => void; children: ReactNode; tone?: "warning" }) {
  const on = tone === "warning" ? "border-warning/40 bg-warning/10 text-warning" : "border-accent/40 bg-accent-muted text-accent-fg";
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-[2px] text-[11.5px] ${active ? on : "border-line text-fg-muted hover:border-line-strong hover:text-fg"}`}>
      {children}
    </button>
  );
}
