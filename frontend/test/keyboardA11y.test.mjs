/**
 * 키보드·화면 읽기로도 쓸 수 있는가 — 9차 실측에서 빠져 있던 두 곳을 소스로 지킨다.
 *
 * - 대화 지도의 노드가 포커스를 받지 않아 지도는 마우스로만 쓸 수 있었다.
 * - 설정의 선택 상자가 옆의 이름표와 이어지지 않아 "선택 상자" 로만 읽혔다.
 *
 * 돌리는 법: node --test test/keyboardA11y.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("지도 노드는 Tab 으로 가고 Enter·Space 로 고른다", () => {
  const tree = src("components/ai/ConversationTree.tsx");
  const node = tree.slice(tree.indexOf("<g key={n.id} data-node"), tree.indexOf("onPointerDown={(e) => t && startNodeDrag"));
  assert.match(node, /tabIndex=\{/, "노드가 포커스를 받지 않는다");
  assert.match(node, /role="button"/);
  assert.match(node, /aria-label=\{/, "노드에 이름이 없다");
  assert.match(node, /onKeyDown=\{onActivate\(/, "키보드로 고를 수 없다");
  assert.match(node, /clickNode\(n\)/, "키보드와 마우스가 같은 길(clickNode)을 타야 한다");
});

test("설정 한 줄은 이름표를 조작에 잇는다", () => {
  const settings = src("pages/Settings.tsx");
  const row = settings.slice(settings.indexOf("function Row("), settings.indexOf("function DiaryPin"));
  assert.match(row, /role="group"/);
  assert.match(row, /aria-labelledby=/);
});
