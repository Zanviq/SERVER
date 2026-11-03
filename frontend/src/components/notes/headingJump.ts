import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { findHeading, headingText } from "../../lib/headings";

/**
 * 편집기 글의 제목들 — 구문 나무로 본다(코드 안의 `# 주석`·울타리 속 줄은 제목이 아니다). from 은 제목 줄의 시작,
 * text 는 읽기 보기에 보이는 글(lib/headings.headingText). 긴 문서도 끝까지 본다 — 나무는 보이는 데까지만 풀려 있다.
 */
export function headingsIn(state: EditorState): { from: number; text: string }[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state);
  const out: { from: number; text: string }[] = [];
  tree.iterate({
    enter(n) {
      const m = /^(ATX|Setext)Heading\d$/.exec(n.name);
      if (!m) return;
      const raw = state.doc.sliceString(n.from, n.to);
      // 밑줄(===·---) 제목은 마지막 줄이 밑줄이다
      const text = m[1] === "Setext" ? raw.split("\n").slice(0, -1).join(" ") : raw;
      out.push({ from: n.from, text: headingText(text) });
      return false;
    },
  });
  return out;
}

const setFlash = StateEffect.define<number | null>();
const flashLine = Decoration.line({ class: "cm-jumpFlash" });

/** 링크로 온 제목 줄을 잠깐 칠한다(index.css .cm-jumpFlash). 편집기 확장 목록에 넣어 둔다. */
export const headingFlash = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        next = e.value == null ? Decoration.none : Decoration.set([flashLine.range(tr.state.doc.lineAt(e.value).from)]);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * section 이 가리키는 제목을 편집기 맨 위로 굴리고 잠깐 칠한다. 못 찾으면 false.
 * 커서는 옮기지 않는다 — 옮기면 그 줄이 원문(`## …`)으로 바뀌어 막 도착한 제목이 기호로 보이고,
 * 편집기에 초점이 있으면 휴대폰 자판까지 올라온다.
 */
export function jumpToHeading(view: EditorView, section: string): boolean {
  const hs = headingsIn(view.state);
  const i = findHeading(hs.map((h) => h.text), section);
  if (i < 0) return false;
  const pos = hs[i].from;
  view.dispatch({ effects: [EditorView.scrollIntoView(pos, { y: "start", yMargin: 16 }), setFlash.of(pos)] });
  window.setTimeout(() => {
    // 그사이 다른 문서로 갔으면(편집기를 새로 만든다) 지운 편집기에 보내지 않는다
    if (view.dom.isConnected) view.dispatch({ effects: setFlash.of(null) });
  }, 1600);
  return true;
}
