import { useEffect, useRef } from "react";
import { EditorView, keymap, ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  history, historyKeymap, defaultKeymap, indentMore, indentLess,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import {
  autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap,
} from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EmbedResolver, eachWikiEmbed, isImagePath } from "../../lib/embeds";
import { cmHighlightExtension, highlightTag } from "../../lib/markdownExtras";
import { matchMarker } from "../../lib/callouts";
import { makeSlashSource, SlashActions } from "./slashMenu";
import { tableTools } from "./tableTools";
import { Paperclip } from "lucide-react";
import { toast } from "../../store/toast";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { NOTE_PATH_MIME, isOurDrag } from "./dragTypes";

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
  // 형광펜(==강조==) — 읽기 뷰의 <mark>와 같은 느낌으로
  {
    tag: highlightTag,
    backgroundColor: "rgb(var(--warning) / 0.3)",
    color: "rgb(var(--fg))",
    borderRadius: "3px",
  },
]);

// 커서가 없는 줄에서 숨길 인라인 구문기호 노드
const HIDE = new Set([
  "EmphasisMark", "CodeMark", "StrikethroughMark", "HeaderMark", "HighlightMark",
]);

/**
 * ![[사진.png]] 을 편집 중에도 그림으로 보여주는 위젯(옵시디언 라이브 프리뷰).
 *
 * 오른쪽 아래 손잡이를 끌면 크기가 바뀌고, 놓는 순간 **문서의 `|너비`가 갱신된다**
 * — 화면에서만 커지고 저장이 안 되면 다시 열었을 때 원래대로 돌아간다.
 *
 * 고칠 위치는 **손댈 때 DOM에서 되찾는다**(posAtDOM). 문서 위치를 위젯에
 * 들고 있으면 eq()가 그 값까지 비교하게 되어, 이미지 위쪽에 한 글자만 쳐도
 * 위젯이 통째로 다시 만들어진다(실측: 타이핑마다 <img> 재생성 → 깜빡임).
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly target: string,
    readonly width: number | undefined,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.url === this.url && o.target === this.target && o.width === this.width;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed-img";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.target;
    img.loading = "lazy";
    if (this.width) img.style.width = `${this.width}px`;
    wrap.appendChild(img);

    const grip = document.createElement("span");
    grip.className = "cm-embed-grip";
    grip.title = "끌어서 크기 조절 (두 번 누르면 원래 크기)";
    grip.setAttribute("aria-label", "이미지 크기 조절");
    wrap.appendChild(grip);

    const writeWidth = (w: number | null) => {
      // 이 위젯이 붙어 있는 줄을 DOM에서 되찾아, 그 줄의 같은 임베드를 고친다.
      // 위치를 들고 있지 않으므로 그 사이 문서가 어떻게 바뀌었든 정확하다.
      let at: number;
      try {
        at = view.posAtDOM(wrap);
      } catch {
        return;
      }
      const line = view.state.doc.lineAt(Math.min(at, view.state.doc.length));
      const hits: { from: number; to: number }[] = [];
      eachWikiEmbed(line.text, ({ start, end, embed }) => {
        if (embed.target === this.target) {
          hits.push({ from: line.from + start, to: line.from + end });
        }
      });
      const hit = hits[0];
      if (!hit) return;
      const body = w ? `![[${this.target}|${w}]]` : `![[${this.target}]]`;
      if (body === view.state.sliceDoc(hit.from, hit.to)) return;
      view.dispatch({ changes: { from: hit.from, to: hit.to, insert: body } });
    };

    let startX = 0;
    let startW = 0;
    let dragged = false;
    const onMove = (e: PointerEvent) => {
      // 손가락·마우스가 몇 픽셀은 흔들린다. 그 정도는 '끌었다'로 보지 않는다.
      if (Math.abs(e.clientX - startX) > 3) dragged = true;
      const w = Math.max(60, Math.round(startW + (e.clientX - startX)));
      img.style.width = `${w}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // 터치가 시스템 제스처로 끊기면 pointerup 대신 pointercancel 만 온다.
      // 안 받으면 손잡이가 계속 '끄는 중'으로 남는다.
      window.removeEventListener("pointercancel", onUp);
      grip.classList.remove("is-dragging");
      // **끌지 않고 한 번 누르기만 했으면 문서를 건드리지 않는다.** 예전에는
      // 손잡이를 살짝 누른 것만으로 `|폭` 이 박히고 그대로 자동저장됐다.
      if (!dragged) return;
      writeWidth(Math.round(img.getBoundingClientRect().width));
    };
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // 에디터로 선택이 번지지 않게
      e.stopPropagation();
      startX = e.clientX;
      startW = img.getBoundingClientRect().width;
      dragged = false;
      grip.classList.add("is-dragging");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
    grip.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      img.style.width = "";
      writeWidth(null); // 너비 지정을 지워 원래 크기로
    });
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

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

/**
 * 빈 인용문 줄에서 Enter → 인용에서 빠져나온다.
 *
 * markdownKeymap 은 목록에서는 빈 항목을 지우고 나가지만 인용문에서는
 * `>` 를 계속 이어 붙인다. 그러면 콜아웃을 쓰다가 밖으로 나올 방법이
 * Backspace 밖에 없다(노션·옵시디언은 Enter 두 번이면 나온다).
 */
const exitEmptyQuote = (view: EditorView): boolean => {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  // `>`·`> `·`> > ` 처럼 내용이 없는 인용 줄이고, 커서가 그 끝일 때만
  if (sel.head !== line.to || !/^\s*(?:>\s*)+$/.test(line.text)) return false;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: "" },
    selection: { anchor: line.from },
    userEvent: "input",
  });
  return true;
};

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
        // 콜아웃(`> [!NOTE]`): 편집 중에도 읽기 뷰와 같은 색으로 보이게 한다.
        // 이게 없으면 편집으로 넘어가는 순간 그냥 인용문으로 보여 어색하다.
        if (node.name === "Blockquote") {
          const first = state.doc.lineAt(node.from);
          const hit = matchMarker(first.text.replace(/^\s*>\s?/, ""));
          if (hit) {
            const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
            for (let n = first.number; n <= last; n++) {
              ranges.push(lineDeco(`cm-callout cm-callout-${hit.kind}`).range(state.doc.line(n).from));
            }
          }
          return undefined;
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

/**
 * ![[사진.png]] → 그 줄 아래에 그림을 붙인다. 커서가 그 줄에 있어도 원본 구문을
 * 지우지 않으므로 편집과 미리보기가 동시에 된다.
 *
 * 블록 위젯은 **ViewPlugin으로 줄 수 없다** — CM6가 "Block decorations may not be
 * specified via plugins"로 던진다(문서의 블록 구조를 바꾸기 때문). 그래서 위의
 * 인라인 장식과 달리 StateField로 분리한다. 뷰포트가 아니라 문서 전체를 훑지만
 * 줄마다 문자열 검사 한 번이라 비용은 무시할 만하다.
 */
/** 그 자리가 코드(울타리·인라인) 안인가. 표 도구와 같은 판정을 쓴다. */
function inCodeAt(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node) {
    const n = node.name;
    if (n === "FencedCode" || n === "CodeBlock" || n === "CodeText" || n === "InlineCode") {
      return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

function buildEmbeds(state: EditorState): DecorationSet {
  const resolve = state.field(embedResolver);
  if (!resolve) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  let pos = 0;
  for (const text of state.doc.iterLines()) {
    const end = pos + text.length;
    // 코드 안에 적어 둔 `![[사진.png]]` 은 **설명하려고 적은 글자**다. 그림으로
    // 그리면 화면의 코드가 사용자가 쓴 것과 달라지고, 손잡이를 끌면 코드까지 고쳐진다.
    if (text.includes("![[") && !inCodeAt(state, pos)) {
      eachWikiEmbed(text, ({ embed }) => {
        if (!isImagePath(embed.target)) return;
        const hit = resolve(embed.target);
        if (!hit) return;
        ranges.push(
          Decoration.widget({
            widget: new ImageWidget(hit.url, embed.target, embed.width),
            side: 1,
            block: true,
          }).range(end),
        );
      });
    }
    pos = end + 1; // 줄바꿈 한 글자
  }
  return Decoration.set(ranges, true);
}

/** 해석기 교체(문서 목록이 늦게 도착하거나 다른 문서를 열었을 때). */
const setResolver = StateEffect.define<EmbedResolver | undefined>();

/** 해석기를 상태에 둔다 — 모듈 전역으로 두면 편집기가 둘 이상일 때 섞인다. */
const embedResolver = StateField.define<EmbedResolver | undefined>({
  create: () => undefined,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setResolver)) return e.value;
    return v;
  },
});

// embedResolver보다 뒤에 선언해야 같은 트랜잭션에서 갱신된 해석기를 읽는다.
const embedDeco = StateField.define<DecorationSet>({
  create: (state) => buildEmbeds(state),
  update(deco, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(setResolver))) return buildEmbeds(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
  // 편집 표면은 input/textarea가 아니라 contenteditable div라,
  // index.css의 "좁은 화면 입력 16px" 규칙(폼 요소만 잡는다)에 걸리지 않는다.
  // 14px인 채로 두면 노트를 탭하는 순간 iOS Safari가 화면을 확대하고 되돌리지 않는다.
  "@media (max-width: 639px)": {
    ".cm-scroller": { fontSize: "16px" },
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
  // ⚠️ .cm-line 에는 **margin 을 주지 말 것**(padding 만).
  // CM6는 줄 높이를 getBoundingClientRect()로 재는데(테두리 박스), 마진은 거기
  // 포함되지 않는다. 그래서 마진을 주면 화면에 그려지는 위치와 CM6의 높이 지도가
  // 어긋나고, 그 아래 모든 줄의 클릭 좌표가 누적으로 밀린다.
  // 실측(4px+4px): 코드블록 다음 줄들의 아래쪽을 클릭하면 한 줄 아래가 찍혔다.
  ".cm-mdcode-first": {
    position: "relative",
    borderTop: "1px solid rgb(var(--line-strong))",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
    paddingTop: "4px",
  },
  ".cm-mdcode-last": {
    borderBottom: "1px solid rgb(var(--line-strong))",
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
    paddingBottom: "4px",
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
  // 콜아웃 — 읽기 뷰(.callout)와 같은 색. 여기서는 줄 단위라 왼쪽 띠만 준다.
  ".cm-callout": {
    borderLeft: "3px solid rgb(var(--line-strong))",
    paddingLeft: "8px",
  },
  ".cm-callout-note": {
    borderLeftColor: "rgb(var(--info))",
    backgroundColor: "rgb(var(--info) / 0.08)",
  },
  ".cm-callout-tip": {
    borderLeftColor: "rgb(var(--positive))",
    backgroundColor: "rgb(var(--positive) / 0.08)",
  },
  ".cm-callout-important": {
    borderLeftColor: "rgb(var(--accent))",
    backgroundColor: "rgb(var(--accent) / 0.1)",
  },
  ".cm-callout-warning": {
    borderLeftColor: "rgb(var(--warning))",
    backgroundColor: "rgb(var(--warning) / 0.1)",
  },
  ".cm-callout-caution": {
    borderLeftColor: "rgb(var(--danger))",
    backgroundColor: "rgb(var(--danger) / 0.08)",
  },
  // 인라인 이미지 임베드(편집 중에도 보이는 그림)
  ".cm-embed-img": { padding: "4px 0", position: "relative", display: "inline-block" },
  ".cm-embed-img img": {
    maxWidth: "100%",
    borderRadius: "6px",
    border: "1px solid rgb(var(--line))",
    display: "block",
  },
  // 크기 조절 손잡이 — 평소엔 옅게, 그림에 올리면 또렷하게
  ".cm-embed-grip": {
    position: "absolute",
    right: "-5px",
    bottom: "1px",
    width: "14px",
    height: "14px",
    borderRadius: "3px",
    border: "1px solid rgb(var(--line-strong))",
    backgroundColor: "rgb(var(--bg-elevated))",
    cursor: "ew-resize",
    opacity: "0",
    transition: "opacity 120ms",
  },
  ".cm-embed-img:hover .cm-embed-grip, .cm-embed-grip.is-dragging": { opacity: "1" },
  // 터치 기기엔 hover 가 없다. 투명한 채로 두면 손잡이가 영영 안 보이는데도
  // 이미지 우하단의 탭을 가로채, 그 자리를 눌러도 커서가 옮겨 가지 않는다.
  "@media (hover: none)": {
    ".cm-embed-grip": { opacity: "0.85" },
  },
});

export interface LiveEditorProps {
  value: string;
  onChange: (v: string) => void;
  onSave?: () => void;
  titles?: string[]; // [[위키링크]] 자동완성 후보
  /** 지금 편집 중인 문서의 식별자(경로). 비동기 삽입이 문서가 바뀐 뒤에
   *  엉뚱한 곳으로 들어가지 않도록 대조하는 데만 쓴다. */
  docKey?: string | null;
  /** ![[사진.png]] → 실제 URL (편집 중 인라인 표시용) */
  resolveEmbed?: EmbedResolver;
  /** OS에서 끌어온 파일 → 업로드 후 삽입할 마크다운을 돌려준다 */
  onDropFiles?: (files: File[]) => Promise<string[]>;
  /** 문서 트리에서 끌어온 경로 → 삽입할 마크다운 */
  onDropPath?: (path: string) => string;
  /** `/` 메뉴의 "새 문서 만들어 링크" — 만든 문서 제목을 돌려준다(취소면 null) */
  onCreateDoc?: () => Promise<string | null>;
}

export function LiveEditor({
  value,
  onChange,
  onSave,
  titles,
  docKey,
  resolveEmbed,
  onDropFiles,
  onDropPath,
  onCreateDoc,
}: LiveEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cbs = useRef({
    onChange, onSave, titles, onDropFiles, onDropPath, resolveEmbed, docKey, onCreateDoc,
  });
  cbs.current = {
    onChange, onSave, titles, onDropFiles, onDropPath, resolveEmbed, docKey, onCreateDoc,
  };
  const fileRef = useRef<HTMLInputElement>(null);
  // 터치 기기이거나 화면이 좁을 때. 터치엔 드래그앤드롭이 없고, 좁은 창에서는
  // 트리에서 편집기로 끌어올 공간 자체가 없다(둘을 번갈아 보여주므로).
  const needsAttachButton = useMediaQuery("(pointer: coarse), (max-width: 639px)");
  const applyingExternal = useRef(false);
  // 업로드가 끝난 뒤 삽입할 자리들. 편집이 일어나면 함께 옮긴다.
  const pendingSpots = useRef<{ pos: number }[]>([]);

  // 마운트 시점 값은 아래 embedResolver.init이 심는다. 여기서는 그 뒤의 변화만
  // 알린다 — 문서 목록이 늦게 도착해도 도착한 그때 이미지가 붙도록.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setResolver.of(resolveEmbed) });
  }, [resolveEmbed]);

  // 아래 두 헬퍼는 렌더마다 새로 만들어지지만, 에디터를 만드는 useEffect가
  // 첫 번째 것을 붙잡아 둔다. 둘 다 ref(cbs·viewRef)와 인자만 읽으므로
  // 낡은 값을 보는 일이 없다.
  /** 커서(또는 지정 위치)에 블록을 넣는다. 줄 한가운데면 앞뒤로 줄을 나눈다. */
  const insertBlock = (view: EditorView, at: number, body: string) => {
    const pos = Math.min(at, view.state.doc.length);
    const line = view.state.doc.lineAt(pos);
    const text = (pos > line.from ? "\n" : "") + body + (pos < line.to ? "\n" : "");
    view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
    view.focus();
  };

  /**
   * 파일 업로드 → 삽입. 드롭·붙여넣기·첨부 버튼이 모두 이걸 쓴다.
   *
   * 업로드가 끝날 때쯤엔 다른 문서가 열려 있을 수 있다. 그때 삽입하면 엉뚱한
   * 문서가 오염되고 자동저장까지 된다 — 시작 시점의 문서를 붙잡아 대조한다.
   */
  const uploadInto = (view: EditorView, at: number, files: File[]) => {
    const insert = cbs.current.onDropFiles;
    if (!insert || !files.length) return;
    const startedIn = cbs.current.docKey;
    // 자리를 **숫자로** 붙잡으면 안 된다. 업로드가 끝나기까지 몇 초가 걸리고,
    // 그 사이 앞쪽에 글을 치면 그만큼 밀려서 엉뚱한 글자 사이에 박힌다.
    // 편집이 일어날 때마다 이 자리를 함께 옮긴다(아래 updateListener).
    const spot = { pos: at };
    pendingSpots.current.push(spot);
    const done = () => {
      pendingSpots.current = pendingSpots.current.filter((s) => s !== spot);
    };
    insert(files).then((snippets) => {
      done();
      if (!snippets.length) return;
      if (viewRef.current !== view || cbs.current.docKey !== startedIn) {
        toast.error("다른 문서로 이동해 링크를 넣지 못했습니다. 올린 파일은 목록에 있습니다.");
        return;
      }
      insertBlock(view, Math.min(spot.pos, view.state.doc.length), snippets.join("\n"));
    }, done);
  };

  /**
   * `/새 문서 만들어 링크` — 문서를 만들고 `[[링크]]` 를 넣는다.
   *
   * 업로드와 **같은 대조**가 필요하다. 제목을 묻는 동안 다른 문서로 옮겨 가면
   * 이 view 는 죽은 편집기이고, 그대로 dispatch 하면 링크가 아무 안내 없이
   * 사라진다(예전에는 슬래시 메뉴가 직접 넣어서 그렇게 됐다).
   */
  const createDocLink = (view: EditorView, at: number) => {
    const make = cbs.current.onCreateDoc;
    if (!make) return;
    const startedIn = cbs.current.docKey;
    const spot = { pos: at };
    pendingSpots.current.push(spot);
    const done = () => {
      pendingSpots.current = pendingSpots.current.filter((s) => s !== spot);
    };
    make().then((title) => {
      done();
      if (!title) return;
      if (viewRef.current !== view || cbs.current.docKey !== startedIn) {
        toast.error("다른 문서로 이동해 링크를 넣지 못했습니다. 문서는 만들어졌습니다.");
        return;
      }
      const pos = Math.min(spot.pos, view.state.doc.length);
      const insert = `[[${title}]]`;
      view.dispatch({
        changes: { from: pos, insert },
        selection: { anchor: pos + insert.length },
      });
      view.focus();
    }, done);
  };

  useEffect(() => {
    if (!hostRef.current) return;

    const wikiComplete = (ctx: CompletionContext): CompletionResult | null => {
      const before = ctx.matchBefore(/\[\[([^\[\]\n]*)$/);
      if (!before) return null;
      const q = before.text.slice(2).toLowerCase();
      const options = (cbs.current.titles ?? [])
        .filter((tt) => tt.toLowerCase().includes(q))
        .slice(0, 8)
        .map((tt) => ({
          label: tt,
          // 닫는 괄호를 **이미 있으면 또 넣지 않는다.** closeBrackets 가 `[[` 를
          // 칠 때 `]]` 를 자동으로 넣어 두는데, 여기서도 붙이면 `[[제목]]]]` 가
          // 되어 링크가 깨진다(실측).
          apply: (view: EditorView, _c: unknown, from: number, to: number) => {
            const after = view.state.sliceDoc(to, to + 2);
            const insert = after === "]]" ? tt : `${tt}]]`;
            const anchor = from + tt.length + 2; // 항상 `]]` 뒤로 커서를 보낸다
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: Math.min(anchor, view.state.doc.length + insert.length) },
            });
          },
        }));
      if (!options.length) return null;
      return { from: before.from + 2, options };
    };

    const slashActions = (): SlashActions => ({
      attachImage: cbs.current.onDropFiles ? () => fileRef.current?.click() : undefined,
      createDocLink: cbs.current.onCreateDoc ? createDocLink : undefined,
    });
    const slashSource = makeSlashSource(slashActions);

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        // 빈 인용문 탈출은 markdown() 의 Prec.high 이어쓰기보다 먼저 와야 한다.
        // 조건이 아주 좁아서(내용 없는 `>` 줄 + 커서가 줄 끝) 다른 Enter 를
        // 가로채지 않는다.
        Prec.highest(keymap.of([{ key: "Enter", run: exitEmptyQuote }])),
        keymap.of([
          { key: "Mod-s", run: () => { cbs.current.onSave?.(); return true; } },
          ...closeBracketsKeymap,
          ...completionKeymap,
          // 목록·인용의 Enter 이어쓰기(`- `, `1. `, `> `)는 markdown() 이
          // 이미 Prec.high 로 넣어 준다 — 여기서 또 넣을 필요가 없다.
          // Tab 은 들여쓰기. 이게 없으면 Tab 이 편집기 밖으로 포커스를 옮겨
          // 숨은 파일 입력까지 갔고, 거기서 Enter 를 누르면 파일 선택창이 떴다.
          // (표 안에서는 tableTools 의 Prec.high 키맵이 먼저 집는다.)
          { key: "Tab", run: indentMore, shift: indentLess },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          // 형광펜(==강조==)은 표준 마크다운에 없다. 읽기 뷰와 같은 규칙을 쓴다.
          extensions: [cmHighlightExtension],
        }),
        // 드래그&드롭: 떨어뜨린 '그 위치'에 삽입한다(옵시디언과 동일).
        EditorView.domEventHandlers({
          dragover(e) {
            const dt = e.dataTransfer;
            // 우리 것(트리 항목·OS 파일)일 때만 가로챈다. 에디터 안 텍스트를 끌어
            // 옮기는 것도 dragover로 오므로, 전부 preventDefault하면 CM6의 이동이 죽는다.
            if (!dt || !isOurDrag(dt)) return false;
            dt.dropEffect = "copy";
            e.preventDefault();
            return false;
          },
          drop(e, view) {
            const dt = e.dataTransfer;
            if (!dt || !isOurDrag(dt)) return false; // 나머지는 CM6 기본 드롭(텍스트 이동)에 넘긴다
            const pos =
              view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;

            const files = Array.from(dt.files ?? []);
            if (files.length) {
              e.preventDefault();
              if (!cbs.current.onDropFiles) return true;
              uploadInto(view, pos, files);
              return true;
            }

            // 문서 트리에서 끌어온 항목 — 전용 타입으로만 인정한다(위 isOurDrag 참고)
            const path = dt.getData(NOTE_PATH_MIME);
            if (path && cbs.current.onDropPath) {
              const snippet = cbs.current.onDropPath(path);
              if (snippet) {
                e.preventDefault();
                insertBlock(view, pos, snippet);
                return true;
              }
            }
            return false;
          },
          /**
           * 클립보드의 그림을 그대로 붙여넣는다(캡처·다른 앱에서 복사한 이미지).
           *
           * 파일명은 대개 "image.png"로 다 같아서, 그대로 올리면 두 번째 붙여넣기가
           * 첫 번째를 덮어쓴다. 시각을 붙여 고유하게 만든다.
           */
          paste(e, view) {
            const dt = e.clipboardData;
            if (!dt || !cbs.current.onDropFiles) return false;
            const images: File[] = [];
            for (const item of Array.from(dt.items ?? [])) {
              if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
              const f = item.getAsFile();
              if (f) images.push(f);
            }
            if (!images.length) return false; // 글자 붙여넣기는 CM6 기본 동작에 맡긴다
            e.preventDefault();
            const stamp = new Date()
              .toISOString()
              .replace(/[-:]/g, "")
              .replace("T", "-")
              .slice(0, 15);
            const named = images.map((f, i) => {
              const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
              const suffix = images.length > 1 ? `-${i + 1}` : "";
              return new File([f], `붙여넣기-${stamp}${suffix}.${ext}`, { type: f.type });
            });
            uploadInto(view, view.state.selection.main.head, named);
            return true;
          },
        }),
        // 표 안에서만 뜨는 툴바 + Tab 칸 이동. keymap 은 defaultKeymap 보다
        // 앞에 와야 Tab 을 먼저 집는다(표 밖에서는 false 를 돌려 넘긴다).
        tableTools(),
        syntaxHighlighting(mdHighlight),
        livePreview,
        // embedDeco보다 먼저 선언해야 같은 트랜잭션에서 갱신된 값을 읽는다.
        // init으로 첫 값을 심는다 — 마운트 직후부터 이미지가 보여야 한다.
        embedResolver.init(() => cbs.current.resolveEmbed),
        embedDeco,
        EditorView.lineWrapping,
        closeBrackets(),
        autocompletion({
          override: [wikiComplete, slashSource],
          // 슬래시 메뉴는 고르는 목록이라 첫 항목이 미리 선택돼 있어야 Enter로 바로 넣는다
          defaultKeymap: true,
        }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          // 업로드가 끝나면 넣을 자리들을 편집에 맞춰 옮긴다. 안 옮기면 업로드가
          // 도는 동안 앞쪽에 친 글자 수만큼 밀려 엉뚱한 데 박힌다.
          for (const spot of pendingSpots.current) {
            spot.pos = u.changes.mapPos(spot.pos, 1);
          }
          if (!applyingExternal.current) {
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

  /** 파일 선택 → 업로드 → 커서 위치에 임베드 삽입. 드롭·붙여넣기와 같은 일을 한다. */
  const attach = (files: FileList | null) => {
    const view = viewRef.current;
    if (!view || !files?.length) return;
    uploadInto(view, view.state.selection.main.head, Array.from(files));
  };

  return (
    <div className="relative h-full min-h-0">
      <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />
      {/* `/이미지` 메뉴와 첨부 버튼이 함께 여는 파일 선택. 화면에는 보이지 않는다.
          입력을 둘로 두면 accept·초기화 규칙이 서로 어긋난다. */}
      <input
        ref={fileRef}
        type="file"
        multiple
        className="sr-only"
        // 화면에 없는 입력이 탭 순서에 남아 있으면, 편집기에서 Tab 을 눌렀을 때
        // 여기로 포커스가 가고 Enter 가 파일 선택창을 연다(실측으로 잡았다).
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          attach(e.target.files);
          e.target.value = ""; // 같은 파일을 다시 골라도 change가 오도록
        }}
      />
      {/* 터치 기기에는 드래그앤드롭이 없어 이미지를 넣을 방법이 아예 없었다.
          (HTML5 DnD는 모바일 브라우저에서 발화하지 않는다) */}
      {needsAttachButton && onDropFiles && (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="absolute bottom-3 right-3 grid h-11 w-11 cursor-pointer place-items-center rounded-full border border-line bg-surface text-fg-muted shadow-md active:bg-hovered"
          title="사진·파일 첨부"
          aria-label="사진·파일 첨부"
        >
          <Paperclip size={18} />
        </button>
      )}
    </div>
  );
}
