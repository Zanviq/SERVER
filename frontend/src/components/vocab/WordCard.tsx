import { ReactNode } from "react";
import { ChevronDown, ChevronRight, Pencil, Trash2, Tag, Quote } from "lucide-react";
import { VocabWord } from "../../lib/api";
import { KIND_LABEL, kindOf } from "./kinds";

/** 복습 단계의 최대치. 서버의 REVIEW_INTERVALS(1·3·7·14·30·60·120일)와 같아야 한다. */
export const MAX_LEVEL = 7;

/** 복습 단계를 점으로. 오늘 복습할 차례면 주황 점을 앞에 단다. */
export function LevelDots({ level, due }: { level: number; due?: boolean }) {
  return (
    <span className="inline-flex items-center gap-[2px]" title={`복습 단계 ${level}/${MAX_LEVEL}${due ? " · 오늘 복습" : ""}`}>
      {due && <span className="mr-0.5 h-1.5 w-1.5 rounded-full bg-warning" />}
      {Array.from({ length: MAX_LEVEL }, (_, i) => (
        <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < level ? "bg-accent" : "bg-line-strong"}`} />
      ))}
    </span>
  );
}

export function isDue(w: VocabWord, today = new Date().toISOString().slice(0, 10)) {
  return !w.next_review || w.next_review <= today;
}

interface Props {
  word: VocabWord;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTag: (tag: string) => void;
  /** 이 태그를 지금 거르고 있으면 진하게 */
  activeTag?: string;
  /** 전역 검색이 이 줄로 스크롤할 때 쓰는 표식 */
  anchorId?: string;
}

/**
 * 단어 한 장. 접혀 있으면 단어·품사·첫 뜻·태그, 펼치면 영어학습예시.md 의
 * 사전 형식(뜻 / 비슷한 단어 ↔ 반대 / 영어 해설 / 예문 → 해석 + 문법 / 변화형 / 포인트).
 */
export function WordCard({ word: w, open, onToggle, onEdit, onDelete, onTag, activeTag, anchorId }: Props) {
  const due = isDue(w);
  const kind = kindOf(w);
  return (
    <li data-word-id={anchorId}
      className={`rounded-md border transition-colors ${open ? "border-line-strong bg-surface" : "border-transparent hover:bg-hovered"}`}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left">
        <span className="mt-[3px] shrink-0 text-fg-subtle">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            {/* 문장·문법 항목도 표제어로 들어오므로 줄바꿈을 허용한다 */}
            <span className="break-words text-[14px] font-semibold tracking-tight">{w.word}</span>
            {kind !== "word" && (
              <span className="shrink-0 rounded-sm bg-subtle px-1 py-[1px] text-[10px] text-fg-muted">{KIND_LABEL[kind]}</span>
            )}
            {w.pronunciation && <span className="text-[11.5px] text-fg-muted">{w.pronunciation}</span>}
            {w.pos && <span className="text-[11px] text-fg-subtle">{w.pos}</span>}
            <span className="ml-auto"><LevelDots level={w.level} due={due} /></span>
          </span>
          {!open && w.meanings[0] && (
            <span className="mt-0.5 block truncate text-[12.5px] text-fg2">{w.meanings.join(" · ")}</span>
          )}
          {!open && w.tags.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {w.tags.map((t) => (
                <span key={t} className={`rounded-full px-1.5 py-[1px] text-[10.5px] ${t === activeTag ? "bg-accent-muted text-accent-fg" : "bg-subtle text-fg-muted"}`}>{t}</span>
              ))}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-line px-3 pb-3 pt-2.5 text-[13px]">
          {w.meanings.length > 0 && (
            <Section title="뜻">
              <ol className="list-decimal space-y-0.5 pl-5">
                {w.meanings.map((m, i) => <li key={i}>{m}</li>)}
              </ol>
            </Section>
          )}
          {(w.synonyms.length > 0 || w.antonyms.length > 0) && (
            <Section title="비슷한 단어">
              {w.synonyms.length > 0 && <p>{w.synonyms.join(", ")}</p>}
              {w.antonyms.length > 0 && <p className="text-fg2">↔ 반대: {w.antonyms.join(", ")}</p>}
            </Section>
          )}
          {w.english_def && (
            <Section title="영어 해설">
              <p className="italic text-fg2">{w.english_def}</p>
            </Section>
          )}
          {w.examples.length > 0 && (
            <Section title="예문">
              <ul className="space-y-1.5">
                {w.examples.map((ex, i) => (
                  <li key={i} className="rounded-md bg-subtle px-2.5 py-1.5">
                    <p>{ex.en}</p>
                    {ex.ko && <p className="text-fg2">→ {ex.ko}</p>}
                    {ex.grammar && <p className="mt-0.5 text-[12px] text-fg-muted">문법: {ex.grammar}</p>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {w.forms && (
            <Section title={/[-–]/.test(w.forms) && !w.forms.includes("\n") ? "동사 변화" : "변화형"}>
              <p className="whitespace-pre-wrap">{w.forms}</p>
            </Section>
          )}
          {w.notes && (
            <Section title="포인트">
              <p className="whitespace-pre-wrap">{w.notes}</p>
            </Section>
          )}
          {w.context && (
            <p className="flex items-start gap-1.5 text-[12px] text-fg-muted">
              <Quote size={12} className="mt-[3px] shrink-0" />
              <span className="italic">{w.context}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1 pt-1">
            <Tag size={12} className="text-fg-subtle" />
            {w.tags.length === 0 && <span className="text-[11.5px] text-fg-subtle">태그 없음</span>}
            {w.tags.map((t) => (
              <button key={t} type="button" onClick={() => onTag(t)}
                className={`rounded-full px-2 py-[2px] text-[11px] ${t === activeTag ? "bg-accent-muted text-accent-fg" : "bg-subtle text-fg-muted hover:bg-hovered hover:text-fg"}`}>
                {t}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-0.5">
              <button type="button" onClick={onEdit} className="btn btn-ghost h-7 px-2" title="수정" aria-label={`${w.word} 수정`}><Pencil size={13} /></button>
              <button type="button" onClick={onDelete} className="btn btn-ghost h-7 px-2 text-danger" title="휴지통으로" aria-label={`${w.word} 삭제`}><Trash2 size={13} /></button>
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{title}</p>
      {children}
    </div>
  );
}
