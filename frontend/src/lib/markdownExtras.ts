/**
 * 표준 마크다운에 없는 문법을 **한 곳에서** 정한다.
 *
 * 지금은 형광펜 하나다: `==강조==`
 * (옵시디언·노션 내보내기가 쓰는 표기라 왕복해도 깨지지 않는다)
 *
 * 편집기(CodeMirror)와 읽기 뷰(react-markdown)는 파서가 완전히 다르다.
 * 규칙을 각자 들고 있으면 반드시 어긋나므로(한쪽에서만 칠해지는 식)
 * 문법 정의를 여기 모아 두고 두 어댑터를 함께 내보낸다.
 */
import { Tag, tags as t } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

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
