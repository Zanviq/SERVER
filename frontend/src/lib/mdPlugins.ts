/**
 * 읽기 보기의 remark 단계(마크다운 → mdast) — **화면(MarkdownView)과 시험 파이프라인(test/mdPipeline)이 이 한
 * 목록을 쓴다.** 예전엔 두 곳이 같은 목록을 따로 적고 이름 문자열로만 대조해, 문법을 하나 더할 때마다 두 곳을
 * 고쳐야 했다(69·70차에 연달아 그랬다). 차례가 뜻을 가진다 — 아래 주석.
 */
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import { remarkCjkPlugins, remarkHighlight, remarkKoreanUrlTail } from "./markdownExtras";

export const remarkPlugins: PluggableList = [
  // GFM(표/체크박스/취소선/자동링크). singleTilde:false — 물결 하나(`H~2~O`)를 취소선으로 보지 않는다.
  // 화학식·첨자 표기가 통째로 <del> 이 되던 것을 막는다(취소선은 `~~두 개~~` 만).
  [remarkGfm, { singleTilde: false }],
  // gfm **뒤**: `**중요!**라고` 처럼 문장부호 뒤 조사가 붙은 강조(편집기와 같은 규칙) — 69차
  ...remarkCjkPlugins,
  // gfm 의 자동 링크가 만든 링크에서 끝에 붙은 조사를 뺀다 — 70차
  remarkKoreanUrlTail,
  // 단일 엔터 줄바꿈
  remarkBreaks,
  remarkHighlight,
  remarkMath,
];
