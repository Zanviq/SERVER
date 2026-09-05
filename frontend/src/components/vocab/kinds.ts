import { VocabKind } from "../../lib/api";

/**
 * 단어장 항목의 갈래.
 *
 * 단어장은 영어 단어만 담는 곳이 아니다 — 논문 화면에서는 전문 용어가, 영어
 * 학습에서는 문장·문법 항목이 같은 곳에 쌓인다. 섞여 있으면 목록이 읽기
 * 어려우므로 갈래로 나눠 보고 뱃지로 구분한다.
 */
export const KIND_LABEL: Record<Exclude<VocabKind, "">, string> = {
  word: "단어",
  phrase: "표현",
  sentence: "문장",
  grammar: "문법",
  term: "용어",
};

export const KINDS = Object.keys(KIND_LABEL) as Exclude<VocabKind, "">[];

/** 갈래가 비어 있는 옛 항목은 표제어 모양으로 짐작한다(서버 guess_kind 와 같은 규칙). */
export function kindOf(word: { kind?: VocabKind; word: string }): Exclude<VocabKind, ""> {
  if (word.kind && word.kind in KIND_LABEL) return word.kind as Exclude<VocabKind, "">;
  const s = word.word.trim();
  const n = s.split(/\s+/).length;
  if (n >= 5 || /[.?!]$/.test(s)) return "sentence";
  return n >= 2 ? "phrase" : "word";
}
