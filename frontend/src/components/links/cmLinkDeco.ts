/**
 * 편집기의 링크 장식 — 커서가 없는 줄의 링크는 누를 수 있는 칩, 있는 줄은 원문.
 *
 * cmLinks 에서 떼어 둔 이유: 여기는 네트워크(후보 받아 오기)를 모른다. 그래서
 * 화면 없이 EditorState 만으로 시험할 수 있다(test/cmLinkDeco.test.mjs).
 */
import { Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { linkLabel, refRegex, splitLink } from "../../lib/links";

export const linkMark = Decoration.mark({
  class: "cm-itemlink",
  attributes: { title: "Ctrl(⌘)+클릭으로 열기" },
});

/** 커서가 없는 줄의 링크를 대신하는 칩. 누르면 연다. */
class LinkWidget extends WidgetType {
  // 매개변수 속성(`constructor(readonly x)`)은 쓰지 않는다 — 노드의 타입 벗기기로
  // 돌리는 시험이 그 문법을 읽지 못한다.
  readonly text: string;
  readonly tip: string;
  readonly cls: string;
  readonly go: () => void;
  constructor(text: string, tip: string, cls: string, go: () => void) {
    super();
    this.text = text;
    this.tip = tip;
    this.cls = cls;
    this.go = go;
  }
  eq(o: LinkWidget) {
    return o.text === this.text && o.tip === this.tip && o.cls === this.cls;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-linkchip ${this.cls}`;
    el.textContent = this.text;
    el.title = this.tip;
    el.setAttribute("role", "link");
    // mousedown 에서 처리한다 — click 까지 기다리면 편집기가 먼저 커서를 옮겨
    // 이 줄이 원문으로 바뀌고, 칩이 사라진 자리를 누른 셈이 된다.
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.go();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** `[[제목]]`·`[[제목|보일 이름]]` (그림 넣기 `![[…]]` 는 아니다) */
const WIKI = /(?<!!)\[\[([^[\]\n]+?)\]\]/g;
const CODE = /^(FencedCode|CodeBlock|InlineCode|CodeText|CodeMark)$/;

function inCode(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (CODE.test(n.name)) return true;
  }
  return false;
}

export interface LinkOpeners {
  /** `[note/…]` 항목 링크를 연다 */
  item: (path: string) => void;
  /** `[[제목]]` 위키링크를 연다(없으면 링크를 칠하기만 한다) */
  wiki?: (title: string) => void;
}

/**
 * 링크 장식 — **커서가 없는 줄의 링크는 누를 수 있는 칩**, 커서가 있는 줄은 원문.
 *
 * 문서 화면의 기본은 이 편집기다. 예전에는 링크 글자를 칠하기만 하고 Ctrl+클릭으로만
 * 열려서, 그냥 누르면 커서만 옮겨 갔다 — 사용자에게는 "링크가 작동하지 않는다"였다.
 * 편집기의 다른 문법(굵게·제목)처럼 커서가 오면 원문이 드러나 고칠 수 있다.
 *
 * view 없이 돌 수 있게 떼어 둔다(시험: test/cmLinks.test.mjs).
 */
export function linkDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  open: LinkOpeners,
): DecorationSet {
  const active = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const z = state.doc.lineAt(r.to).number;
    for (let n = a; n <= z; n++) active.add(n);
  }
  const out: Range<Decoration>[] = [];
  const seen = new Set<number>();
  for (const { from, to } of ranges) {
    for (let pos = from; pos <= to && pos <= state.doc.length;) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (seen.has(line.number)) continue;
      seen.add(line.number);
      const onLine = active.has(line.number);
      for (const m of line.text.matchAll(refRegex())) {
        const s = line.from + (m.index ?? 0);
        const { kind, rest } = splitLink(m[1]);
        if (!kind || !rest || inCode(state, s)) continue;
        const path = `${kind}/${rest}`;
        out.push(onLine
          ? linkMark.range(s, s + m[0].length)
          : Decoration.replace({
            widget: new LinkWidget(linkLabel(path), `${path} — 눌러서 열기`, "cm-linkchip-item",
                                   () => open.item(path)),
          }).range(s, s + m[0].length));
      }
      if (!open.wiki || onLine) continue;
      for (const m of line.text.matchAll(WIKI)) {
        const s = line.from + (m.index ?? 0);
        if (inCode(state, s)) continue;
        const [target, alias] = m[1].split("|");
        const title = target.split("#")[0].trim();
        if (!title) continue;
        const go = open.wiki;
        out.push(Decoration.replace({
          widget: new LinkWidget((alias ?? target).trim(), `${title} — 눌러서 열기`,
                                 "cm-linkchip-wiki", () => go(title)),
        }).range(s, s + m[0].length));
      }
    }
  }
  return Decoration.set(out, true);
}

