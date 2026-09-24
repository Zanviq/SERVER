/**
 * 편집기 링크 — 커서가 없는 줄의 링크는 **누를 수 있는 칩**, 커서가 있는 줄은 원문.
 *
 * 예전에는 링크 글자를 칠하기만 해서 그냥 누르면 커서만 움직였다(Ctrl+클릭만 열림).
 * 문서 화면의 기본이 이 편집기라, 사용자에게는 "링크가 작동하지 않는다"였다.
 *
 * 돌리는 법:
 *   node --experimental-strip-types --import ./test/tsResolve.mjs --test test/cmLinkDeco.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { linkDecorations } from "../src/components/links/cmLinkDeco.ts";

function decos(doc, cursorAt, wiki = true) {
  const state = EditorState.create({
    doc, extensions: [markdown()], selection: EditorSelection.cursor(cursorAt),
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const opened = [];
  const set = linkDecorations(state, [{ from: 0, to: state.doc.length }], {
    item: (p) => opened.push(`item:${p}`),
    wiki: wiki ? (t) => opened.push(`wiki:${t}`) : undefined,
  });
  const out = [];
  set.between(0, state.doc.length, (from, to, d) => {
    const w = d.spec.widget;
    out.push({ text: doc.slice(from, to), chip: !!w, label: w?.text, go: w?.go });
  });
  return { out, opened };
}

test("커서가 없는 줄의 링크는 칩이 되고, 누르면 그 링크를 연다", () => {
  const doc = "첫 줄\n참고 [note/서버/기록.md] 와 [[회의록|지난 회의]]\n끝";
  const { out, opened } = decos(doc, 0);   // 커서는 첫 줄
  assert.deepEqual(out.map((o) => [o.text, o.chip, o.label]), [
    ["[note/서버/기록.md]", true, "기록.md"],
    ["[[회의록|지난 회의]]", true, "지난 회의"],
  ]);
  out.forEach((o) => o.go());
  assert.deepEqual(opened, ["item:note/서버/기록.md", "wiki:회의록"]);
});

test("커서가 있는 줄은 원문 그대로(고칠 수 있게) — 항목 링크는 칠하기만", () => {
  const doc = "참고 [note/서버/기록.md] 와 [[회의록]]";
  const { out } = decos(doc, 3);
  assert.deepEqual(out.map((o) => [o.text, o.chip]), [["[note/서버/기록.md]", false]]);
});

test("코드 안의 것은 링크가 아니다", () => {
  const doc = "커서\n`[note/코드.md]` 와 ```\n[note/블록.md]\n```\n[[위키]] 는 칩";
  const fenced = "커서\n```\n[note/블록.md]\n[[안쪽]]\n```\n";
  assert.deepEqual(decos(doc, 0).out.filter((o) => o.text.includes("코드")).length, 0);
  assert.equal(decos(fenced, 0).out.length, 0, "울타리 코드 안까지 칩이 됐다");
});

test("그림 넣기 ![[…]] 는 칩으로 바꾸지 않는다(그림이 사라진다)", () => {
  const { out } = decos("커서\n![[사진.png]] 그리고 [[문서]]", 0);
  assert.deepEqual(out.map((o) => o.text), ["[[문서]]"]);
});

test("위키링크를 열 곳이 없는 편집기(회의록 등)에서는 위키링크를 건드리지 않는다", () => {
  const { out } = decos("커서\n[[문서]] 와 [todo/보고서]", 0, false);
  assert.deepEqual(out.map((o) => o.text), ["[todo/보고서]"]);
});
