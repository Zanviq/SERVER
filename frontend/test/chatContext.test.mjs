/**
 * 보내기가 실패하면 **얹어 둔 것도 돌려준다.**
 *
 * 친 글은 이미 돌려주고 있었다(입력칸으로). 그런데 PDF 에서 고른 문단과 오려 둔
 * 그림은 보내는 순간 칩에서 내려가고 **끝이었다.** 실패하면 사용자는 PDF 로
 * 돌아가 문단을 다시 고르고 그림을 다시 오려야 했다 — 정작 되찾기 어려운 쪽이
 * 그쪽이고, 휴대폰에서는 더 고약하다.
 *
 * 규칙 둘을 함께 지킨다.
 *   - 보내면서 내린 것만 되돌린다. 사용자가 '모두 지우기'로 직접 내린 것을
 *     되살리면 그게 더 이상하다.
 *   - 그 사이 새로 고른 것이 있으면 건드리지 않는다(쓰던 것을 덮는 게 더 나쁘다).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Papers.tsx 의 clearContext/restoreContext 와 같은 규칙 */
function makeContext(init) {
  let cur = { ...init };
  let kept = null;
  return {
    get: () => cur,
    clear(reason) {
      kept = reason === "sent" ? cur : null;
      cur = { a: [], s: [], m: [] };
    },
    restore() {
      if (!kept) return;
      cur = {
        a: cur.a.length ? cur.a : kept.a,
        s: cur.s.length ? cur.s : kept.s,
        m: cur.m.length ? cur.m : kept.m,
      };
    },
    add(sel) { cur = { ...cur, s: [...cur.s, sel] }; },
  };
}

const 처음 = () => ({ a: [{ id: "그림1" }], s: [{ id: "문단1" }, { id: "문단2" }], m: [{ id: "자국1" }] });

test("보내다 실패하면 선택·그림이 돌아온다", () => {
  const c = makeContext(처음());
  c.clear("sent");
  assert.deepEqual(c.get(), { a: [], s: [], m: [] }, "보내는 순간에는 칩이 내려가야 한다");
  c.restore();
  assert.deepEqual(c.get(), 처음());
});

test("직접 지운 것은 되살아나지 않는다", () => {
  const c = makeContext(처음());
  c.clear();          // '모두 지우기'
  c.restore();        // 그 뒤 다른 보내기가 실패해도
  assert.deepEqual(c.get(), { a: [], s: [], m: [] }, "일부러 지운 것을 되살리면 안 된다");
});

test("그 사이 새로 고른 것은 덮지 않는다", () => {
  const c = makeContext(처음());
  c.clear("sent");
  c.add({ id: "새문단" });
  c.restore();
  assert.deepEqual(c.get().s, [{ id: "새문단" }], "쓰던 것을 덮는 게 더 나쁘다");
  assert.deepEqual(c.get().a, [{ id: "그림1" }], "비어 있는 갈래는 되돌려도 된다");
});

test("성공하면 되돌리지 않는다(restore 를 안 부른다)", () => {
  const c = makeContext(처음());
  c.clear("sent");
  assert.deepEqual(c.get(), { a: [], s: [], m: [] });
});

test("화면이 실제로 그렇게 이어져 있다", () => {
  const chat = readFileSync(new URL("../src/components/ai/ChatPanel.tsx", import.meta.url), "utf8");
  assert.match(chat, /onClearContext\?\.\("sent"\)/, "보낼 때는 이유를 알려야 부모가 챙긴다");
  const giveBack = chat.slice(chat.indexOf("const giveBack"), chat.indexOf("const ctrl"));
  assert.match(giveBack, /onRestoreContext\?\.\(\)/, "글만 돌려주면 반쪽이다");

  const papers = readFileSync(new URL("../src/pages/Papers.tsx", import.meta.url), "utf8");
  assert.match(papers, /onRestoreContext=\{restoreContext\}/);
  assert.match(papers, /reason === "sent"/, "직접 지운 것과 구별해야 한다");
});
