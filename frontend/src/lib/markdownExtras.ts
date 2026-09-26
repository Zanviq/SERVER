/**
 * 표준 마크다운에 없는(또는 표준과 다르게 읽는) 문법을 **한 곳에서** 정한다.
 *
 * - 형광펜: `==강조==` (옵시디언·노션 내보내기가 쓰는 표기라 왕복해도 깨지지 않는다)
 * - 한글 친화 강조(69차): `**중요!**라고`·`**함수(인자)**를` 처럼 **문장부호 바로 뒤에 조사**가 붙은
 *   굵게·기울임·취소선. 표준(CommonMark)의 좌우 붙음(flanking) 규칙은 닫는 `**` 앞이 문장부호면 뒤가
 *   공백·문장부호일 때만 닫혀서, 한국어에서 가장 흔한 꼴이 `**` 가 그대로 보이는 글이 됐다(편집기·읽기
 *   보기 둘 다 실측). CommonMark 의 CJK 친화 개정안(remark-cjk-friendly)을 따른다.
 *
 * 편집기(CodeMirror)와 읽기 뷰(react-markdown)는 파서가 완전히 다르다.
 * 규칙을 각자 들고 있으면 반드시 어긋나므로(한쪽에서만 칠해지는 식)
 * 문법 정의를 여기 모아 두고 두 어댑터를 함께 내보낸다.
 */
import { Tag, tags as t } from "@lezer/highlight";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import type { PluggableList } from "unified";
import {
  classifyCharacter, classifyPrecedingCharacter, isCjk, isCjkOrIvs, isNonCjkPunctuation,
  isSpaceOrPunctuation, isUnicodeWhitespace,
} from "micromark-extension-cjk-friendly-util";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyStrike from "remark-cjk-friendly-gfm-strikethrough/parseOnly";

/** 읽기 뷰의 한글 친화 강조 — remark-gfm **뒤에** 둔다(취소선은 gfm 의 것을 바꿔 끼운다).
 *  singleTilde 는 gfm 과 같게(물결 하나는 취소선이 아니다 — 화학식·첨자). */
export const remarkCjkPlugins: PluggableList = [remarkCjkFriendly, [remarkCjkFriendlyStrike, { singleTilde: false }]];

/**
 * 강조 표시(`*` `_` `~~`)가 열 수 있는가·닫을 수 있는가 — 읽기 뷰 플러그인(micromark-extension-cjk-friendly)과
 * **같은 분류 함수로 같은 식**을 쓴다(글자 분류가 어긋나면 두 화면이 다르게 보인다). 앞뒤 글자가 CJK 나 CJK
 * 문장부호가 아닐 때는 CommonMark 규칙과 똑같다.
 */
export function cjkEmphasisSides(marker: number, before: number | null, twoBefore: number | null,
                                 after: number | null): { open: boolean; close: boolean } {
  const b = classifyPrecedingCharacter(classifyCharacter(before), () => twoBefore, before as number);
  const a = classifyCharacter(after);
  const bSpaceOrPunct = isNonCjkPunctuation(b) || isUnicodeWhitespace(b);
  const aSpaceOrPunct = isNonCjkPunctuation(a) || isUnicodeWhitespace(a);
  let open = !aSpaceOrPunct || (isNonCjkPunctuation(a) && (bSpaceOrPunct || isCjkOrIvs(b)));
  let close = !bSpaceOrPunct || (isNonCjkPunctuation(b) && (aSpaceOrPunct || isCjk(a)));
  if (marker === 95 /* _ */) {
    // 밑줄은 낱말 안에서 열고 닫지 않는다(snake_case) — 표준과 같은 덧붙임 조건
    const o = open && (isSpaceOrPunctuation(b) || !close);
    const c = close && (isSpaceOrPunctuation(a) || !open);
    open = o;
    close = c;
  }
  return { open, close };
}

type InlineParse = (cx: InlineContext, next: number, pos: number) => number;
/** 인라인 문단 안의 한 코드 포인트(없으면 null — 문단 경계는 공백으로 본다). */
function pointBefore(cx: InlineContext, pos: number): number | null {
  const s = cx.slice(Math.max(cx.offset, pos - 2), pos);
  const cps = Array.from(s);
  return cps.length ? (cps[cps.length - 1].codePointAt(0) ?? null) : null;
}
function pointAfter(cx: InlineContext, pos: number): number | null {
  return cx.slice(pos, Math.min(cx.end, pos + 2)).codePointAt(0) ?? null;
}

/**
 * 편집기의 한글 친화 강조. lezer 의 기본 Emphasis·Strikethrough 해석기를 **그대로 부르고**, 그것이 방금 단
 * 구분자의 열기·닫기만 위 규칙으로 다시 정한다 — 구분자 종류(굵게·기울임 짝 맞추기에 쓰는 내부 객체)는
 * lezer 밖에서 만들 수 없어서다. base 는 편집기가 쓰는 마크다운 파서(GFM 포함 — markdownLanguage.parser)를
 * 넘긴다 — 여기서 lezer 를 값으로 가져오면 읽기 뷰 묶음에도 편집기 파서가 딸려 간다. 타입이 `object` 인
 * 것은 CodeMirror 가 그 파서를 일반 Parser 로 내놓아서다(쓰는 것은 어차피 내부 칸이다).
 */
export function cmCjkFriendly(base: object): MarkdownConfig {
  const p = base as unknown as { inlineParsers: (InlineParse | undefined)[]; inlineNames: string[] };
  const wrap = (name: string, markers: number[]) => {
    const original = p.inlineParsers[p.inlineNames.indexOf(name)];
    if (!original) throw new Error(`마크다운 파서에 ${name} 가 없다`);
    const parse: InlineParse = (cx, next, start) => {
      const end = original(cx, next, start);
      if (end < 0 || !markers.includes(next)) return end;
      const parts = (cx as unknown as { parts: ({ from: number; to: number; side: number } | null)[] }).parts;
      const d = parts[parts.length - 1];
      if (!d || d.from !== start || typeof d.side !== "number") return end;
      const before = pointBefore(cx, d.from);
      const twoBefore = before === null ? null : pointBefore(cx, d.from - (before > 0xffff ? 2 : 1));
      const s = cjkEmphasisSides(next, before, twoBefore, pointAfter(cx, d.to));
      d.side = (s.open ? 1 : 0) | (s.close ? 2 : 0);
      return end;
    };
    return { name, parse };
  };
  return { parseInline: [wrap("Emphasis", [42, 95]), wrap("Strikethrough", [126])] };
}

/** 형광펜 구간에 붙는 커스텀 태그(에디터 하이라이트 스타일이 이걸 잡는다). */
export const highlightTag = Tag.define();

// ── 편집기(CodeMirror / @lezer/markdown) ─────────────────────────────

const EQUALS = 61; // "=" 문자 코드

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

/**
 * 구분자가 내용에 붙어 있는가.
 *
 * `a == b 이고 c == d` 처럼 **산문에 섞인 비교 연산자**가 형광펜이 되면 안 된다
 * (실제로 그렇게 칠해졌다 — `a` 와 `d` 사이가 통째로 형광펜이 됐다).
 * 굵게(`**`)와 같은 규칙을 쓴다: 여는 쪽은 뒤에 공백이 오면 안 되고,
 * 닫는 쪽은 앞에 공백이 오면 안 된다.
 */
function isBlank(code: number): boolean {
  return code === -1 || Number.isNaN(code) || code === 32 || code === 9 || code === 10 || code === 13;
}

/**
 * `==...==` 을 인라인 노드로 파싱한다.
 *
 * Emphasis 뒤에 끼워 넣는다 — 앞에 두면 `**==굵고 강조==**` 같은 중첩에서
 * 굵게가 먼저 닫히지 못한다.
 */
export const cmHighlightExtension: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: highlightTag },
    { name: "HighlightMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      after: "Emphasis",
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS) return -1;
        // 세 개 이상(`===`)은 구분선·제목 밑줄일 수 있으니 건드리지 않는다
        if (cx.char(pos + 2) === EQUALS) return -1;
        const before = pos > cx.offset ? cx.char(pos - 1) : -1;
        const canOpen = !isBlank(cx.char(pos + 2));
        const canClose = !isBlank(before);
        if (!canOpen && !canClose) return -1;
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, canOpen, canClose);
      },
    },
  ],
};

// ── 읽기 뷰(react-markdown / remark) ─────────────────────────────────

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

// 편집기 쪽 규칙(isBlank)과 같은 뜻: 여는 `==` 뒤와 닫는 `==` 앞에 공백이 없어야 한다.
// 그래서 `a == b` 는 형광펜이 아니고 `==여기==` 는 형광펜이다.
// 한 줄 안으로 제한한다 — 떠돌이 `==` 하나가 문단을 통째로 삼키지 않게.
// 한 글자짜리를 먼저 시도한다. `(\S(?:...)?)` 로 쓰면 선택 그룹이 탐욕적이라
// `==앞== 가운데 ==뒤==` 가 통째로 한 덩어리가 된다(테스트로 잡았다).
const HIGHLIGHT_RE = /==(?!=)(\S|\S[^\n]*?\S)==/g;

/**
 * `==x==` → `<mark>x</mark>`.
 *
 * **text 노드만** 손댄다. 문자열 전체를 정규식으로 바꾸면 코드블록·인라인코드
 * 안의 `==` 까지 칠해져 코드가 망가진다(파싱된 뒤라 code 노드의 내용은
 * text 노드가 아니므로 자동으로 비켜간다).
 *
 * 새 노드 타입을 만들면 hast 변환기가 버리므로, 핸들러가 있는 `delete`(취소선)를
 * 쓰되 data.hName 으로 태그만 mark 로 바꾼다.
 */
export function remarkHighlight() {
  return (tree: MdNode) => walk(tree);
}

function walk(node: MdNode): void {
  const kids = node.children;
  if (!Array.isArray(kids)) return;
  let changed = false;
  const out: MdNode[] = [];
  for (const child of kids) {
    if (child.type !== "text" || typeof child.value !== "string" || !child.value.includes("==")) {
      walk(child);
      out.push(child);
      continue;
    }
    const parts = splitHighlights(child.value);
    if (parts.length === 1 && parts[0] === child) {
      out.push(child);
      continue;
    }
    changed = true;
    out.push(...parts);
  }
  if (changed) node.children = out;
}

function splitHighlights(value: string): MdNode[] {
  HIGHLIGHT_RE.lastIndex = 0;
  const out: MdNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = HIGHLIGHT_RE.exec(value)) !== null) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({
      type: "delete",
      data: { hName: "mark" },
      children: [{ type: "text", value: m[1] }],
    });
    last = m.index + m[0].length;
  }
  if (!out.length) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}
