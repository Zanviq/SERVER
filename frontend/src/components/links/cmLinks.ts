/**
 * 문서 편집기(CodeMirror)의 `[note/…]` 링크 — 후보·표시·열기.
 *
 * 다른 입력칸은 useMarkdownInput 의 떠 있는 판을 쓰지만, 편집기에는 이미 자동완성
 * 틀(위키링크 `[[`·슬래시 메뉴)이 있으므로 같은 틀에 소스를 하나 더 얹는다.
 * 후보는 입력칸과 같은 서버 답(fetchLinkPage)이다.
 */
import { startCompletion } from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { linkQueryAt, refRegex, splitLink } from "../../lib/links";
import { linkDecorations } from "./cmLinkDeco";
import type { LinkOpeners } from "./cmLinkDeco";
import { fetchLinkPage, linkMoreNote } from "./linkFetch";

/** `[` 뒤에 친 글자로 후보를 받는다. `[[`(위키링크)는 건드리지 않는다. */
export async function linkCompletionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const q = linkQueryAt(line.text, ctx.pos - line.from);
  if (!q) return null;
  // 타자마다 묻지 않게 잠깐 기다린다 — 그 사이 더 쳤으면 이 물음은 버려진다
  await new Promise((r) => setTimeout(r, 90));
  if (ctx.aborted) return null;
  let page;
  try {
    page = await fetchLinkPage(q.query);
  } catch {
    return null;
  }
  const { items, more } = page;
  if (ctx.aborted || items.length === 0) return null;
  const from = line.from + q.start + 1;
  const options: Completion[] = items.map((it) => ({
    label: it.path,
    displayLabel: `${it.folder ? "📁 " : ""}${it.label}`,
    detail: it.detail ? `${it.detail} · ${it.path}` : it.path,
    apply: (view: EditorView, _c: Completion, f: number, t: number) => {
      if (it.folder) {
        // 폴더는 안으로 들어간다 — 닫지 않고 다음 후보를 바로 띄운다
        const ins = it.path.endsWith("/") ? it.path : `${it.path}/`;
        view.dispatch({ changes: { from: f, to: t, insert: ins }, selection: { anchor: f + ins.length } });
        setTimeout(() => startCompletion(view), 0);
        return;
      }
      // 닫는 괄호가 이미 있으면(closeBrackets 가 넣어 둔다) 또 넣지 않는다
      const after = view.state.sliceDoc(t, t + 1);
      const ins = after === "]" ? it.path : `${it.path}]`;
      view.dispatch({
        changes: { from: f, to: t, insert: ins },
        selection: { anchor: f + it.path.length + 1 },
      });
    },
  }));
  if (more > 0) {
    // 자동완성 틀에는 꼬리말 자리가 없어서 맨 끝 한 줄로 알린다. 골라도 아무것도 넣지 않는다.
    options.push({
      label: q.query,
      displayLabel: linkMoreNote(more),
      type: "text",
      boost: -99,
      apply: () => {},
    });
  }
  // 순서는 서버가 정했다(폴더 먼저·가까운 날짜 먼저) — 편집기가 다시 거르지 않게
  return { from, to: ctx.pos, options, filter: false };
}

/** 링크를 칩으로 그리고(누르면 연다), 원문일 때는 Ctrl(⌘)+클릭으로 연다. */
export function itemLinks(open: LinkOpeners) {
  const deco = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = linkDecorations(view.state, view.visibleRanges, open);
      }
      update(u: ViewUpdate) {
        // 커서가 줄을 옮기면 칩↔원문이 바뀌어야 한다(selectionSet)
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = linkDecorations(u.state, u.view.visibleRanges, open);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  const click = EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos);
      for (const m of line.text.matchAll(refRegex())) {
        const s = line.from + (m.index ?? 0);
        if (pos < s || pos > s + m[0].length) continue;
        const { kind, rest } = splitLink(m[1]);
        if (!kind || !rest) return false;
        e.preventDefault();
        open.item(`${kind}/${rest}`);
        return true;
      }
      return false;
    },
  });
  return [deco, click];
}
