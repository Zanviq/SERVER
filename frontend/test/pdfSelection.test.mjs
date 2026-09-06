/**
 * PDF 에서 글을 고르면 말풍선이 떠야 한다 — **휴대폰에서도.**
 *
 * 뷰어는 `pointerup` 하나만 듣고 있었다. 마우스로 끌 때는 맞지만, 손가락으로
 * 글을 고르는 두 가지 방법은 둘 다 그 이벤트를 주지 않는다.
 *   - 길게 눌러 고르기: 브라우저가 그 제스처를 가져가면서 pointerup 대신
 *     **pointercancel** 만 보낸다(편집기가 같은 것에 데였다 — LiveEditor).
 *   - 선택 손잡이 끌어 늘리기: 손잡이는 뷰어 밖이라 pointerup 이 안 온다.
 *     바뀐 것은 **selectionchange** 로만 알 수 있다.
 * 실측(390px): 이 둘로는 말풍선이 영영 뜨지 않았다. 고친 뒤 셋 다 뜬다.
 *
 * 브라우저 없이 붙잡을 수 있는 것은 "무엇을 듣는가"다. 이 셋 중 하나라도
 * 빠지면 휴대폰에서 조용히 못 쓰게 되므로, 소스에서 직접 확인한다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/components/papers/PdfViewer.tsx", import.meta.url), "utf8");

test("마우스로 끌어 놓는 길", () => {
  assert.match(src, /addEventListener\("pointerup", onUp\)/);
});

test("길게 눌러 고르는 길 — pointercancel 도 끝으로 친다", () => {
  assert.match(src, /addEventListener\("pointercancel", onUp\)/,
    "제스처를 뺏기면 pointerup 이 아예 오지 않는다");
  assert.match(src, /removeEventListener\("pointercancel", onUp\)/, "치울 때도 같이 뗀다");
});

test("손잡이를 끌어 늘리는 길 — selectionchange 로 띄운다", () => {
  const block = src.slice(src.indexOf('addEventListener("selectionchange"') - 1200,
                          src.indexOf('addEventListener("selectionchange"') + 200);
  assert.match(block, /showFromSelection/,
    "selectionchange 가 말풍선을 띄우지 않으면 손잡이로 고른 것은 아무 데도 안 간다");
});

test("끄는 중에는 띄우지 않는다", () => {
  assert.match(src, /dragging\.current/, "마우스로 끄는 내내 말풍선이 따라다니면 성가시다");
  assert.match(src, /SELECT_SETTLE_MS/, "손잡이가 멎기를 기다렸다가 띄운다");
});

test("고른 것을 풀면 말풍선도 사라진다", () => {
  assert.match(src, /isCollapsed\)\s*\{\s*setPop\(null\)/,
    "선택이 풀렸는데 말풍선만 남으면 무엇에 대한 단추인지 알 수 없다");
});
