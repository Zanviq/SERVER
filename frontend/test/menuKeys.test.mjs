/**
 * 떠 있는 메뉴를 키보드로 쓸 수 있는가 — 39차.
 *
 * 문서 줄 … 메뉴와 드롭다운은 패널을 body 끝에 포탈한다. 그래서 여는 단추 다음 Tab 이 패널이 아니라
 * 그 줄의 다음 단추로 갔고, Enter 로 연 뒤 Tab 을 200번 눌러도 이름 변경·이동·휴지통에 닿지 못했다.
 * 키마다 할 일(lib/menuKeys.ts)과, 포탈하는 두 메뉴가 그 규칙을 쓰는지를 본다.
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/menuKeys.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { menuKey } from "../src/lib/menuKeys.ts";

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("여는 단추에서 Tab·↓ 는 패널 첫 항목으로, ↑ 는 끝으로", () => {
  assert.deepEqual(menuKey("Tab", false, -1, 3, false), { focus: 0 });
  assert.deepEqual(menuKey("ArrowDown", false, -1, 3, false), { focus: 0 });
  assert.deepEqual(menuKey("ArrowUp", false, -1, 3, false), { focus: 2 });
  assert.deepEqual(menuKey("Tab", true, -1, 3, false), { leave: "back" }, "Shift+Tab 은 메뉴를 두고 앞으로");
  assert.equal(menuKey("Enter", false, -1, 3, false), null, "Enter 는 단추 자신의 일(여닫기)");
});

test("항목 사이는 화살표로 돌고, 끝에서 Tab 하면 메뉴를 떠난다", () => {
  assert.deepEqual(menuKey("ArrowDown", false, 2, 3, true), { focus: 0 }, "끝에서 ↓ 는 처음으로");
  assert.deepEqual(menuKey("ArrowUp", false, 0, 3, true), { focus: 2 });
  assert.deepEqual(menuKey("Home", false, 1, 3, true), { focus: 0 });
  assert.deepEqual(menuKey("End", false, 0, 3, true), { focus: 2 });
  assert.deepEqual(menuKey("Tab", false, 2, 3, true), { leave: "forward" });
  assert.deepEqual(menuKey("Tab", true, 0, 3, true), { leave: "back" });
  assert.equal(menuKey("Tab", false, 0, 3, true), null, "가운데 Tab 은 브라우저 기본");
});

test("입력칸 안의 화살표는 뺏지 않는다(날짜 칸의 값·커서)", () => {
  assert.equal(menuKey("ArrowDown", false, 1, 3, false), null);
  assert.equal(menuKey("Home", false, 1, 3, false), null);
  assert.equal(menuKey("ArrowDown", false, -1, 0, false), null, "빈 패널");
});

test("포탈하는 두 메뉴가 같은 규칙을 쓴다", () => {
  for (const f of ["components/notes/RowMenu.tsx", "components/ui/Dropdown.tsx"]) {
    const s = src(f);
    assert.match(s, /createPortal\(/, `${f}: 포탈하지 않는다면 이 시험을 고칠 것`);
    assert.match(s, /useMenuFocus\(open && !!pos,/, `${f}: 키보드로 패널에 들어갈 길이 없다`);
    assert.doesNotMatch(s, /key === "Escape"/, `${f}: Esc 를 따로 다루면 포커스 되돌리기가 어긋난다`);
  }
  const hook = src("components/ui/useMenuFocus.ts");
  assert.match(hook, /preventScroll: true/, "포커스를 옮기며 스크롤하면 스크롤에 닫히는 메뉴가 곧바로 닫힌다");
  assert.match(hook, /if \(to && !p\.contains\(to\)\) inside = false/, "항목이 DOM 에서 빠질 때의 focusout 까지 밖으로 치면 포커스가 body 로 떨어진다");
});

test("메뉴 항목이 연 대화상자는 닫힐 때 메뉴를 연 단추로 돌아간다", () => {
  // 항목은 대화상자가 열리는 커밋에서 사라진다. 그것을 돌아갈 자리로 적어 두면 Esc 뒤 포커스가 body 로 떨어졌다.
  const modal = src("components/ui/Modal.tsx");
  assert.match(modal, /!t\.closest\('\[role="dialog"\], \[role="menu"\]'\)/);
});
