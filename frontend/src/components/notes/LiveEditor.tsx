import { useEffect, useRef } from "react";
import { EditorView, keymap, ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
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
import { EmbedResolver, eachWikiEmbed, isImagePath } from "../../lib/embeds";
import { toast } from "../../store/toast";
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
]);

// 커서가 없는 줄에서 숨길 인라인 구문기호 노드
const HIDE = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark", "HeaderMark"]);

/** ![[사진.png]] 을 편집 중에도 그림으로 보여주는 위젯(옵시디언 라이브 프리뷰). */
class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string, readonly width?: number) {
    super();
  }
  eq(o: ImageWidget) {
    return o.url === this.url && o.width === this.width;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed-img";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    img.loading = "lazy";
    if (this.width) img.style.width = `${this.width}px`;
    wrap.appendChild(img);
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

/**
 * ![[사진.png]] → 그 줄 아래에 그림을 붙인다. 커서가 그 줄에 있어도 원본 구문을
 * 지우지 않으므로 편집과 미리보기가 동시에 된다.
 *
 * 블록 위젯은 **ViewPlugin으로 줄 수 없다** — CM6가 "Block decorations may not be
 * specified via plugins"로 던진다(문서의 블록 구조를 바꾸기 때문). 그래서 위의
 * 인라인 장식과 달리 StateField로 분리한다. 뷰포트가 아니라 문서 전체를 훑지만
 * 줄마다 문자열 검사 한 번이라 비용은 무시할 만하다.
 */
function buildEmbeds(state: EditorState): DecorationSet {
  const resolve = state.field(embedResolver);
  if (!resolve) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  let pos = 0;
  for (const text of state.doc.iterLines()) {
    const end = pos + text.length;
    if (text.includes("![[")) {
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
  // 인라인 이미지 임베드(편집 중에도 보이는 그림)
  ".cm-embed-img": { padding: "4px 0" },
  ".cm-embed-img img": {
    maxWidth: "100%",
    borderRadius: "6px",
    border: "1px solid rgb(var(--line))",
    display: "block",
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
}: LiveEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cbs = useRef({ onChange, onSave, titles, onDropFiles, onDropPath, resolveEmbed, docKey });
  cbs.current = { onChange, onSave, titles, onDropFiles, onDropPath, resolveEmbed, docKey };
  const applyingExternal = useRef(false);

  // 마운트 시점 값은 아래 embedResolver.init이 심는다. 여기서는 그 뒤의 변화만
  // 알린다 — 문서 목록이 늦게 도착해도 도착한 그때 이미지가 붙도록.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setResolver.of(resolveEmbed) });
  }, [resolveEmbed]);

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

            /** 줄 한가운데면 앞뒤로 줄을 나눈다 — 임베드 두 개가 한 줄에 붙지 않도록. */
            const place = (at: number, body: string) => {
              const line = view.state.doc.lineAt(at);
              const text = (at > line.from ? "\n" : "") + body + (at < line.to ? "\n" : "");
              view.dispatch({
                changes: { from: at, insert: text },
                selection: { anchor: at + text.length },
              });
              view.focus();
            };

            const files = Array.from(dt.files ?? []);
            if (files.length) {
              e.preventDefault();
              const insert = cbs.current.onDropFiles;
              if (!insert) return true;
              // 업로드가 끝날 때쯤엔 다른 문서가 열려 있을 수 있다. 그때 삽입하면
              // 엉뚱한 문서가 오염되고 자동저장까지 된다 — 드롭 당시 문서를 붙잡아 둔다.
              const droppedIn = cbs.current.docKey;
              insert(files).then((snippets) => {
                if (!snippets.length) return;
                if (viewRef.current !== view || cbs.current.docKey !== droppedIn) {
                  toast.error("다른 문서로 이동해 링크를 넣지 못했습니다. 올린 파일은 목록에 있습니다.");
                  return;
                }
                // 그 사이 사용자가 입력했을 수 있으니 삽입 시점 길이로 한 번 더 클램프
                place(Math.min(pos, view.state.doc.length), snippets.join("\n"));
              });
              return true;
            }

            // 문서 트리에서 끌어온 항목 — 전용 타입으로만 인정한다(위 isOurDrag 참고)
            const path = dt.getData(NOTE_PATH_MIME);
            if (path && cbs.current.onDropPath) {
              const snippet = cbs.current.onDropPath(path);
              if (snippet) {
                e.preventDefault();
                place(pos, snippet);
                return true;
              }
            }
            return false;
          },
        }),
        syntaxHighlighting(mdHighlight),
        livePreview,
        // embedDeco보다 먼저 선언해야 같은 트랜잭션에서 갱신된 값을 읽는다.
        // init으로 첫 값을 심는다 — 마운트 직후부터 이미지가 보여야 한다.
        embedResolver.init(() => cbs.current.resolveEmbed),
        embedDeco,
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
