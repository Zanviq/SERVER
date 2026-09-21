/**
 * `[note/…]` 링크 — 무엇이 링크인지, 입력칸에서 언제 후보가 뜨는지, 고르면 무엇이
 * 들어가는지, 읽기 뷰에서 무엇으로 그려지는지.
 *
 * 돌리는 법:
 *   node --experimental-strip-types --import ./test/tsResolve.mjs --test test/links.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  applyPick, findRefs, LINK_KINDS, linkLabel, linkQueryAt, plainRefs, splitLink,
} from "../src/lib/links.ts";
import { buildTurns } from "../src/lib/chatTree.ts";
import { render } from "./mdPipeline.mjs";

test("백엔드와 같은 갈래·별칭을 쓴다", () => {
  // 한쪽만 고치면 화면에서는 링크로 보이는데 AI 는 못 읽는다(또는 그 반대)
  const py = readFileSync(new URL("../../backend/links.py", import.meta.url), "utf8");
  const kinds = py.match(/^KINDS = \(([^)]*)\)/m)[1].match(/"(\w+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(kinds, [...LINK_KINDS]);
  const aliases = [...py.match(/^ALIASES = \{([\s\S]*?)\}/m)[1].matchAll(/"(\w+)": "(\w+)"/g)];
  for (const [, alias, kind] of aliases) {
    assert.equal(splitLink(`${alias}/x`).kind, kind, alias);
  }
  const ts = readFileSync(new URL("../src/lib/links.ts", import.meta.url), "utf8");
  // 링크가 아닌 것을 가르는 앞뒤 조건이 같아야 한다
  assert.ok(py.includes(String.raw`(?<![\[\]\\!])\[`), "백엔드 앞 조건이 바뀌었다");
  assert.ok(ts.includes(String.raw`(?<![\[\]\\!])\[`), "프런트 앞 조건이 바뀌었다");
  assert.ok(py.includes(String.raw`\](?![\](\[:])`) && ts.includes(String.raw`\](?![\](\[:])`));
});

test("링크와 링크처럼 생긴 것", () => {
  const text = [
    "[note/서버/기록.md] 와 [notes/b.md] 를 비교. 또 [note/서버/기록.md]",
    "[[note/위키]] ![그림](note/x.png) [글](note/y.md) [글][note/ref] [ ] [x]",
    "[note/ref]: https://example.com",
    "[todo/학교/보고서] [event/2026-09-21/회의] [없는갈래/a] [vocab/]",
  ].join("\n");
  assert.deepEqual(findRefs(text), [
    "note/서버/기록.md", "note/b.md", "todo/학교/보고서", "event/2026-09-21/회의",
  ]);
});

test("칩 이름 — 짧게, 일정은 날짜까지", () => {
  assert.equal(linkLabel("note/서버/기록.md"), "기록.md");
  assert.equal(linkLabel("event/2026-09-21/회의"), "2026-09-21 회의");
  assert.equal(linkLabel("diary/2026-09-21"), "기록 2026-09-21");
  assert.equal(linkLabel("paper/Attention"), "Attention");
  // 지도 노드처럼 마크다운을 안 그리는 자리 — 백엔드 links.plain 과 같은 결과
  assert.equal(plainRefs("[note/서버/기록.md] 요약해 [event/2026-09-21/회의]"), "기록.md 요약해 2026-09-21 회의");
  assert.equal(plainRefs("[[note/위키]] 와 [글](note/a.md)"), "[[note/위키]] 와 [글](note/a.md)");
});

test("대화 지도 노드에는 경로 대신 짧은 이름", () => {
  const turns = buildTurns([
    { id: "u1", role: "user", text: "[note/서버/기록.md] 요약해 줘", parent: null },
    { id: "a1", role: "assistant", text: "요약입니다", parent: "u1" },
  ], "a1");
  assert.ok(turns[0].label.startsWith("기록.md 요약"), turns[0].label);
});

test("입력칸 — 언제 후보가 뜨는가", () => {
  const at = (s) => linkQueryAt(s.replace("|", ""), s.indexOf("|"));
  assert.deepEqual(at("비교해 [|"), { start: 4, end: 5, query: "" });
  assert.equal(at("비교해 [note/서|").query, "note/서");
  // 닫는 괄호가 이미 있으면(자동으로 닫혔거나 고치는 중) 그것까지 바꾼다
  assert.deepEqual(at("[note/|]"), { start: 0, end: 7, query: "note/" });
  // 이런 때는 뜨지 않는다 — 다른 문법을 치는 중이다
  for (const s of ["[[위|", "![그|", "[글][참|", "\\[|", "- [ |", "[note/a] 다음|", "[a]|"]) {
    assert.equal(at(s), null, s);
  }
  // 윗줄의 괄호는 상관없다
  assert.equal(at("[note/a\n다음 줄|"), null);
});

test("고르기 — 항목은 닫고, 폴더는 안으로", () => {
  const q = linkQueryAt("[기록 요약해", 3);
  const file = applyPick("[기록 요약해", q, "note/서버/기록.md", false);
  assert.equal(file.text, "[note/서버/기록.md] 요약해");
  assert.equal(file.caret, "[note/서버/기록.md]".length);

  const q2 = linkQueryAt("[not]", 4);
  const dir = applyPick("[not]", q2, "note/", true);
  assert.equal(dir.text, "[note/", "폴더를 고르면 닫지 않는다(다음 후보가 이어진다)");
  const sub = applyPick("[note/", linkQueryAt("[note/", 6), "note/서버", true);
  assert.equal(sub.text, "[note/서버/");
});

test("읽기 뷰 — 링크는 눌리는 링크로, 코드 속은 그대로", () => {
  const html = render("[note/서버/기록.md] 를 봐\n\n`[note/코드.md]`\n\n```\n[note/블록.md]\n```", { wiki: true });
  assert.match(html, /<a href="#link\/note%2F%EC%84%9C%EB%B2%84%2F%EA%B8%B0%EB%A1%9D\.md">기록\.md<\/a>/);
  assert.ok(html.includes("<code>[note/코드.md]</code>"), html);
  assert.ok(html.includes("[note/블록.md]"), html);
  assert.equal((html.match(/#link\//g) ?? []).length, 1, "코드 속까지 링크가 됐다");
  // 위키링크와 섞여도 서로 망가뜨리지 않는다
  const both = render("[[회의록]] 과 [todo/보고서]", { wiki: true });
  assert.ok(both.includes('href="#wiki/%ED%9A%8C%EC%9D%98%EB%A1%9D"'), both);
  assert.ok(both.includes('href="#link/todo%2F%EB%B3%B4%EA%B3%A0%EC%84%9C"'), both);
  // 이름에 마크다운 기호가 있어도 그대로 보인다(기울임이 되지 않는다)
  assert.ok(render("[note/a_b_c.md]", { wiki: true }).includes(">a_b_c.md</a>"));
});
