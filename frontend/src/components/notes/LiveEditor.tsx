import { useEffect, useRef } from "react";
import { EditorView, keymap, ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import {
  autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap,
} from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";

/**
 * 옵시디언식 라이브 프리뷰 마크다운 에디터(CodeMirror 6).
 * - 순수 마크다운을 그대로 편집/저장(왕복 손실 없음 → MCP·동기화 안전)
 * - 구문에 서식 적용(제목 크게, 굵게/기울임 등) + 커서가 없는 줄은 **·#·` 등 구문기호를 숨겨
 *   렌더된 것처럼 보이게 한다. 커서를 올리면 원본이 드러나 편집 가능.
 */

// 마크다운 토큰 → 서식(앱 CSS 변수 사용 → 다크/라이트 자동 대응)
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.7em", fontWeight: "700", lineHeight: "1.35" },
  { tag: t.heading2, fontSize: "1.45em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.25em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "rgb(var(--accent))", textDecoration: "underline" },
  { tag: t.monospace, fontFamily: "ui-monospace, SFMono-Regular, monospace" },
  { tag: t.quote, color: "rgb(var(--fg-muted))", fontStyle: "italic" },
  { tag: t.list, color: "rgb(var(--accent))" },
  { tag: t.processingInstruction, color: "rgb(var(--fg-subtle))" },
  { tag: t.contentSeparator, color: "rgb(var(--fg-subtle))" },
]);

// 커서가 없는 줄에서 숨길 인라인 구문기호 노드
const HIDE = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark", "HeaderMark"]);

// 코드블록 우측 상단 복사 버튼(편집 모드). 위젯이라 문서 텍스트엔 포함되지 않음.
class CopyBtn extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(o: CopyBtn) {
    return o.code === this.code;
  }
  toDOM() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-copy-btn";
    b.textContent = "복사";
    b.onmousedown = (e) => e.preventDefault(); // 에디터 포커스/커서 이동 방지
    b.onclick = (e) => {
      e.preventDefault();
      navigator.clipboard?.writeText(this.code).then(
        () => {
          b.textContent = "복사됨";
          window.setTimeout(() => (b.textContent = "복사"), 1200);
        },
        () => {},
      );
    };
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

const lineDeco = (cls: string) => Decoration.line({ class: cls });

function buildDeco(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const state = view.state;
  const active = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const z = state.doc.lineAt(r.to).number;
    for (let n = a; n <= z; n++) active.add(n);
  }
  const hide = Decoration.replace({});
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        // 코드블록: 각 줄을 박스(테두리+배경)로, 첫 줄엔 복사 버튼
        if (node.name === "FencedCode") {
          const startLine = state.doc.lineAt(node.from).number;
          const endLine = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
          const inner: string[] = [];
          for (let n = startLine; n <= endLine; n++) {
            const line = state.doc.line(n);
            const cls =
              "cm-mdcode" +
              (n === startLine ? " cm-mdcode-first" : "") +
              (n === endLine ? " cm-mdcode-last" : "");
            ranges.push(lineDeco(cls).range(line.from));
            if (n > startLine && n < endLine) inner.push(line.text);
          }
          const first = state.doc.line(startLine);
          ranges.push(
            Decoration.widget({ widget: new CopyBtn(inner.join("\n")), side: 1 }).range(first.from),
          );
          return false; // 코드 내부는 더 파고들지 않음(내부 기호 숨김 제외)
        }
        if (HIDE.has(node.name)) {
          const ln = state.doc.lineAt(node.from).number;
          if (!active.has(ln)) ranges.push(hide.range(node.from, node.to));
        }
        return undefined;
      },
    });
  }
  return Decoration.set(ranges, true); // true=위치 정렬
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDeco(view);
    }
    update(u: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; view: EditorView }) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = buildDeco(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", height: "100%", color: "rgb(var(--fg))" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "Pretendard, ui-sans-serif, system-ui, sans-serif",
    fontSize: "14px",
    lineHeight: "1.75",
    overflow: "auto",
  },
  ".cm-content": { padding: "16px", caretColor: "rgb(var(--accent))" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "rgb(var(--accent))" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgb(var(--accent) / 0.22)",
  },
  ".cm-activeLine": { backgroundColor: "rgb(var(--fg) / 0.04)" },
  ".cm-tooltip": {
    backgroundColor: "rgb(var(--bg-elevated))",
    border: "1px solid rgb(var(--line))",
    borderRadius: "8px",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "rgb(var(--accent) / 0.18)",
    color: "rgb(var(--fg))",
  },
  ".cm-tooltip-autocomplete ul li": { padding: "3px 10px" },
  // 코드블록 박스(편집 모드): 각 줄 배경 + 좌우 테두리, 첫/끝 줄에 상/하 테두리·라운드
  ".cm-mdcode": {
    backgroundColor: "rgb(var(--bg-subtle))",
    borderLeft: "1px solid rgb(var(--line-strong))",
    borderRight: "1px solid rgb(var(--line-strong))",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    fontSize: "13px",
  },
  ".cm-mdcode-first": {
    position: "relative",
    borderTop: "1px solid rgb(var(--line-strong))",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
    marginTop: "4px",
  },
  ".cm-mdcode-last": {
    borderBottom: "1px solid rgb(var(--line-strong))",
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
    marginBottom: "4px",
  },
  ".cm-copy-btn": {
    position: "absolute",
    top: "2px",
    right: "6px",
    zIndex: "5",
    padding: "1px 7px",
    fontSize: "10.5px",
    fontFamily: "Pretendard, sans-serif",
    borderRadius: "4px",
    border: "1px solid rgb(var(--line))",
    backgroundColor: "rgb(var(--bg-elevated))",
    color: "rgb(var(--fg-muted))",
    cursor: "pointer",
  },
  ".cm-copy-btn:hover": { color: "rgb(var(--fg))" },
});

export function LiveEditor({
  value,
  onChange,
  onSave,
  titles,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave?: () => void;
  titles?: string[]; // [[위키링크]] 자동완성 후보
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cbs = useRef({ onChange, onSave, titles });
  cbs.current = { onChange, onSave, titles };
  const applyingExternal = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;

    const wikiComplete = (ctx: CompletionContext): CompletionResult | null => {
      const before = ctx.matchBefore(/\[\[([^\[\]\n]*)$/);
      if (!before) return null;
      const q = before.text.slice(2).toLowerCase();
      const options = (cbs.current.titles ?? [])
        .filter((tt) => tt.toLowerCase().includes(q))
        .slice(0, 8)
        .map((tt) => ({ label: tt, apply: `${tt}]]` }));
      if (!options.length) return null;
      return { from: before.from + 2, options };
    };

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([
          { key: "Mod-s", run: () => { cbs.current.onSave?.(); return true; } },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(mdHighlight),
        livePreview,
        EditorView.lineWrapping,
        closeBrackets(),
        autocompletion({ override: [wikiComplete] }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !applyingExternal.current) {
            cbs.current.onChange(u.state.doc.toString());
          }
        }),
        editorTheme,
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 에디터는 1회만 생성. value 동기화는 아래 effect가 담당.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 외부 value 변경(다른 노트 열기/충돌 로드 등) → 에디터에 반영(사용자 입력과 구분)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (value === cur) return;
    applyingExternal.current = true;
    view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
    applyingExternal.current = false;
  }, [value]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
}
