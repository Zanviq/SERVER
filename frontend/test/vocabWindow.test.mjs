/**
 * 단어장 목록의 창 규칙.
 *
 * 3000개를 전부 그리면 DOM 노드가 63,866개가 되고 다 그릴 때까지 8.4초가 걸렸다
 * (실측 390px). 창을 150개로 줄여 1.8초·4,019노드가 됐는데, 이때 조용히 깨지기
 * 쉬운 규칙이 둘 생긴다 — 여기서 그 둘을 붙잡는다.
 *
 * window.ts 와 같은 규칙(그 파일은 TS 라 노드에서 그대로 못 부른다).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const PAGE = 150;

function windowOf(all, shown) {
  const n = Math.max(0, Math.min(shown, all.length));
  return { visible: all.slice(0, n), hidden: all.length - n };
}

function shownForFocus(index, shown) {
  return index >= 0 && index >= shown ? index + 1 : shown;
}

const words = Array.from({ length: 3000 }, (_, i) => ({ id: `w${i}`, word: `word${i}` }));

test("창보다 많으면 감춘 개수를 알려 준다", () => {
  const { visible, hidden } = windowOf(words, PAGE);
  assert.equal(visible.length, 150);
  assert.equal(hidden, 2850, "감춘 개수를 모르면 화면이 '몇 개 더 있다'고 말할 수 없다");
});

test("창보다 적으면 감춘 것이 없다", () => {
  const { visible, hidden } = windowOf(words.slice(0, 12), PAGE);
  assert.equal(visible.length, 12);
  assert.equal(hidden, 0);
});

test("거르기는 전체에 대고 한다 — 먼저 자르면 찾던 단어가 사라진다", () => {
  // 화면이 하는 순서: 전체를 거른 뒤에 자른다
  const 거른것 = words.filter((w) => w.word === "word2999");
  assert.deepEqual(windowOf(거른것, PAGE).visible.map((w) => w.word), ["word2999"]);

  // 뒤집힌 순서(먼저 자르고 거르기)면 못 찾는다 — 이게 막으려는 실수다
  const 잘못 = windowOf(words, PAGE).visible.filter((w) => w.word === "word2999");
  assert.equal(잘못.length, 0);
});

test("찾아온 단어가 창 밖이면 창을 늘린다", () => {
  assert.equal(shownForFocus(2999, PAGE), 3000, "2999번째가 DOM 에 없으면 열리지도 않는다");
  assert.equal(shownForFocus(10, PAGE), PAGE, "창 안이면 그대로 둔다(공연히 늘리지 않는다)");
  assert.equal(shownForFocus(-1, PAGE), PAGE, "없는 단어면 그대로");
  // 늘린 창에는 그 단어가 실제로 들어 있어야 한다
  const n = shownForFocus(2999, PAGE);
  assert.equal(windowOf(words, n).visible.at(-1).word, "word2999");
});

test("이상한 값에도 무너지지 않는다", () => {
  assert.equal(windowOf(words, 0).visible.length, 0);
  assert.equal(windowOf(words, -5).visible.length, 0);
  assert.equal(windowOf(words, 99999).hidden, 0);
  assert.deepEqual(windowOf([], PAGE), { visible: [], hidden: 0 });
});
