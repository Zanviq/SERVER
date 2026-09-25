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

test("링크 후보의 안내는 휴대폰에서 할 수 없는 조작(↑↓·Esc)을 말하지 않는다", () => {
  const hook = src("components/links/useMarkdownInput.tsx");
  assert.match(hook, /useTouch\(\)/, "터치 환경을 가리지 않는다");
  assert.match(hook, /touch \? "눌러서 넣기/, "휴대폰 안내가 없다");
});

test("링크 후보는 입력칸의 aria 로 목록과 고른 후보를 가리킨다 — 41차", () => {
  // 포커스는 입력칸에 남는다. 예전엔 아무 연결이 없어 후보 30개가 떠도, ↓ 로 골라도 화면 읽기에 안 들렸다.
  const hook = src("components/links/useMarkdownInput.tsx");
  assert.match(hook, /setAttribute\("aria-autocomplete", "list"\)/);
  assert.match(hook, /setAttribute\("aria-controls", listId\)/, "입력칸이 후보 목록을 가리키지 않는다");
  assert.match(hook, /setAttribute\("aria-activedescendant", current\)/, "↓ 로 고른 후보가 알려지지 않는다");
  assert.match(hook, /removeAttribute\("aria-activedescendant"\)/, "닫힌 뒤에도 사라진 후보를 가리킨다");
  assert.match(hook, /<ul ref=\{listRef\} id=\{listId\} role="listbox"/);
  assert.match(hook, /<li key=\{it\.path\} id=\{optId\(i\)\} role="option"/);
  assert.doesNotMatch(hook, /role", "combobox"/, "여러 줄 입력칸에 combobox 를 씌우면 여러 줄이라는 뜻이 사라진다");
});

test("아이콘만 있는 드롭다운 단추에는 이름(label)이 있다 — 31차", async () => {
  // 논문·회의 목록의 … 단추가 이름 없이 "단추"로만 읽혔다(화면 전체를 훑은 실측). 컴포넌트가
  // 이름을 받게 하고, 아이콘 하나만 그리는 쓰임은 모두 넘기는지 소스로 본다.
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") && files.push(p); } };
  walk(root);
  const bad = [];
  let iconOnly = 0;
  for (const f of files) {
    const text = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    for (const m of text.matchAll(/<Dropdown\b[^>]*?trigger=\{\(\) => <([A-Z]\w+) size=\{\d+\} \/>\}[^>]*>/gs)) {
      iconOnly++;
      if (!/\blabel=(?:"[^"]+"|\{\w+\})/.test(m[0])) bad.push(`${f.split(/[\\/]/).pop()}: ${m[1]}`);
    }
  }
  assert.ok(iconOnly >= 2, `아이콘만 그리는 드롭다운을 못 찾았다 — 이 시험의 식을 확인할 것(${iconOnly})`);
  assert.deepEqual(bad, [], `이름 없는 아이콘 드롭다운: ${bad.join(", ")}`);
  const dd = src("components/ui/Dropdown.tsx");
  assert.match(dd, /aria-label=\{label\}/, "드롭다운 단추가 이름을 달지 않는다");
  // 목록 줄의 … 메뉴(RowMoreMenu)는 이름을 **반드시** 받는다(선택 사항이면 또 빠진다)
  assert.match(src("components/ui/RowMoreMenu.tsx"), /label: string;/, "줄 메뉴의 이름이 선택 사항이다");
});
