/**
 * 대화 나무 — 줄기 고르기와 지도 배치.
 *
 * 이 파일은 화면이 쓰는 **진짜 모듈**을 그대로 부른다(노드 22 의 타입 벗기기).
 * 규칙을 테스트에 베껴 적으면 원본이 바뀌어도 테스트는 통과해 버린다.
 *
 * 여기서 붙잡는 것:
 *  1) 보이는 것은 한 줄기뿐이다 — 다른 가지가 말풍선에 섞이면 가지를 나눈 의미가 없다.
 *  2) 옛 대화(parent 없음)도 한 줄 나무로 읽힌다.
 *  3) 지도의 노드는 **겹치지 않는다**. 레퍼런스는 물리 시뮬레이션이라 노드가
 *     서로 밀며 떨리고 열 때마다 모양이 달라졌다.
 *  4) 같은 대화면 언제나 같은 그림이다(자리를 기억할 수 있어야 한다).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  threadOf, siblingsOf, deepestLeaf, buildTurns, layout, hiddenCount, findTurns, fitLabel,
  NODE_H, NODE_W, ROW_GAP,
} = await import("../src/lib/chatTree.ts");

/** u1→a1→u2→a2 로 이어지고, a1 에서 u3→a3 가 갈라진 나무 */
function forked() {
  return [
    { id: "u1", role: "user", text: "1 2 3 을 설명해줘", parent: null },
    { id: "a1", role: "assistant", text: "1번은 …, 2번은 …, 3번은 …", parent: "u1" },
    { id: "u2", role: "user", text: "1번 더 자세히", parent: "a1" },
    { id: "a2", role: "assistant", text: "1번은 이러이러합니다", parent: "u2" },
    { id: "u3", role: "user", text: "2번 더 자세히", parent: "a1" },
    { id: "a3", role: "assistant", text: "2번은 저러저러합니다", parent: "u3" },
  ];
}

test("보이는 것은 지금 가지 한 줄기뿐이다", () => {
  const msgs = forked();
  const left = threadOf(msgs, "a2").map((m) => m.id);
  assert.deepEqual(left, ["u1", "a1", "u2", "a2"]);
  assert.ok(!left.includes("u3"), "다른 가지가 섞이면 가지를 나눈 의미가 없다");

  const right = threadOf(msgs, "a3").map((m) => m.id);
  assert.deepEqual(right, ["u1", "a1", "u3", "a3"]);
});

test("head 가 없거나 사라졌으면 마지막 메시지를 본다(옛 파일)", () => {
  const msgs = forked();
  assert.equal(threadOf(msgs, "").at(-1).id, "a3");
  assert.equal(threadOf(msgs, "없는id").at(-1).id, "a3");
  assert.deepEqual(threadOf([], "x"), []);
});

test("parent 가 없던 옛 대화도 한 줄 나무로 읽힌다", () => {
  // 서버가 읽을 때 목록 순서대로 이어 준다 — 화면은 그 결과를 받는다
  const old = [
    { id: "m1", role: "user", text: "안녕", parent: null },
    { id: "m2", role: "assistant", text: "안녕하세요", parent: "m1" },
    { id: "m3", role: "user", text: "고마워", parent: "m2" },
  ];
  assert.deepEqual(threadOf(old, "m3").map((m) => m.id), ["m1", "m2", "m3"]);
  const turns = buildTurns(old, "m3");
  assert.equal(turns.length, 1, "가지가 하나뿐인 나무여야 한다");
  assert.equal(turns[0].children.length, 1);
});

test("형제는 같은 자리에서 갈라진 것들이다(◀ 2/3 ▶ 가 쓴다)", () => {
  const msgs = forked();
  assert.deepEqual(siblingsOf(msgs, "u2").map((m) => m.id), ["u2", "u3"]);
  assert.deepEqual(siblingsOf(msgs, "u1").map((m) => m.id), ["u1"]);
  assert.deepEqual(siblingsOf(msgs, "없는id"), []);
});

test("가지를 갈아타면 그 가지의 끝까지 따라간다", () => {
  const msgs = forked();
  // u3 로 갈아타면 a3 까지 — 반쪽만 보이면 안 된다
  assert.equal(deepestLeaf(msgs, "u3"), "a3");
  assert.equal(deepestLeaf(msgs, "a3"), "a3");
  assert.equal(deepestLeaf(msgs, "u1"), "a3", "마지막에 난 가지를 따라간다");
});

test("질문과 답은 한 노드로 묶인다", () => {
  const turns = buildTurns(forked(), "a2");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, "a1", "차례의 끝(답)이 노드 id 다");
  assert.equal(turns[0].userId, "u1");
  assert.match(turns[0].label, /^1 2 3 을 설명해줘/);
  assert.equal(turns[0].children.length, 2, "가지 둘");
  assert.equal(turns[0].children[0].onPath, true);
  assert.equal(turns[0].children[1].onPath, false);
});

test("답이 아직 없는 차례도 노드로 남는다(끊긴 대화)", () => {
  const msgs = [
    { id: "u1", role: "user", text: "질문", parent: null },
  ];
  const [t] = buildTurns(msgs, "u1");
  assert.equal(t.id, "u1");
  assert.equal(t.pending, true, "답이 없다는 것이 보여야 끊긴 줄 안다");
});

test("부모를 잃은 옛 메시지는 뿌리가 된다(숲을 그린다)", () => {
  const msgs = [
    { id: "u1", role: "user", text: "하나", parent: null },
    { id: "a1", role: "assistant", text: "답1", parent: "u1" },
    { id: "u9", role: "user", text: "잘려서 부모가 없어진 것", parent: null },
  ];
  assert.equal(buildTurns(msgs, "a1").length, 2, "미아를 버리면 대화가 사라진다");
});

test("지도의 노드는 겹치지 않는다", () => {
  // 가지가 많은 나무를 만든다: 뿌리 하나에서 다섯 갈래, 각 갈래가 또 셋
  const msgs = [
    { id: "u0", role: "user", text: "뿌리", parent: null },
    { id: "a0", role: "assistant", text: "답", parent: "u0" },
  ];
  for (let i = 0; i < 5; i++) {
    msgs.push({ id: `u${i}x`, role: "user", text: `가지 ${i}`, parent: "a0" });
    msgs.push({ id: `a${i}x`, role: "assistant", text: "답", parent: `u${i}x` });
    for (let j = 0; j < 3; j++) {
      msgs.push({ id: `u${i}_${j}`, role: "user", text: `잎 ${i}-${j}`, parent: `a${i}x` });
      msgs.push({ id: `a${i}_${j}`, role: "assistant", text: "답", parent: `u${i}_${j}` });
    }
  }
  const { nodes, edges } = layout(buildTurns(msgs, "a0"));
  assert.equal(nodes.length, 1 + 5 + 15);
  assert.equal(edges.length, 5 + 15, "모든 노드는 뿌리 말고 선 하나로 매달린다");

  const byCol = new Map();
  for (const n of nodes) {
    const arr = byCol.get(n.x) ?? [];
    arr.push(n);
    byCol.set(n.x, arr);
  }
  for (const [x, col] of byCol) {
    const ys = col.map((n) => n.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      assert.ok(ys[i] - ys[i - 1] >= NODE_H, `x=${x} 에서 노드가 겹쳤다: ${ys[i - 1]} vs ${ys[i]}`);
    }
  }
});

test("부모는 자식들 한가운데에 선다", () => {
  const msgs = [
    { id: "u0", role: "user", text: "뿌리", parent: null },
    { id: "a0", role: "assistant", text: "답", parent: "u0" },
    { id: "uA", role: "user", text: "A", parent: "a0" },
    { id: "aA", role: "assistant", text: "답", parent: "uA" },
    { id: "uB", role: "user", text: "B", parent: "a0" },
    { id: "aB", role: "assistant", text: "답", parent: "uB" },
  ];
  const { nodes } = layout(buildTurns(msgs, "a0"));
  const at = (id) => nodes.find((n) => n.id === id);
  assert.equal(at("a0").y, (at("aA").y + at("aB").y) / 2);
  assert.equal(at("aB").y - at("aA").y, NODE_H + ROW_GAP);
});

test("같은 대화면 언제나 같은 그림이다", () => {
  const a = layout(buildTurns(forked(), "a2"));
  const b = layout(buildTurns(forked(), "a3"));
  const pos = (r) => r.nodes.map((n) => `${n.id}@${n.x},${n.y}`).sort().join("|");
  assert.equal(pos(a), pos(b), "고른 가지가 달라도 자리는 그대로여야 기억할 수 있다");
});

test("접으면 아래가 사라지고 감춘 개수를 셀 수 있다", () => {
  const turns = buildTurns(forked(), "a2");
  const all = layout(turns);
  const folded = layout(turns, new Set(["a1"]));
  assert.equal(all.nodes.length, 3);
  assert.equal(folded.nodes.length, 1, "접었는데 자식이 남아 있다");
  assert.equal(hiddenCount(turns[0]), 2);
});

test("노드 글자는 글자 수가 아니라 **폭**으로 자른다", () => {
  // 한글은 라틴 문자의 두 배 가까이 넓다. 글자 수로 자르면 같은 17자라도 한글만
  // 상자 밖으로 삐져나온다(실제로 그랬다).
  const size = 11.5;
  const px = (s) => [...s].reduce(
    (w, ch) => w + (/[ᄀ-ᇿ⺀-鿿가-힯＀-｠]/.test(ch) ? size : size * 0.52), 0);
  const 여유 = NODE_W - 22;

  const ko = fitLabel("역전파, 정규화, 초기화를 한꺼번에 설명해줘");
  const en = fitLabel("explain backprop and normalization together please");
  for (const [name, s] of [["한글", ko], ["영문", en]]) {
    assert.ok(px(s) <= 여유, `${name}이 상자 밖으로 나갔다: ${px(s).toFixed(0)}px > ${여유}px — ${s}`);
    assert.ok(s.endsWith("…"), `${name}: 잘렸으면 잘린 표시가 있어야 한다`);
  }
  assert.ok([...ko].length < [...en].length, "넓은 글자는 더 적게 들어가야 한다");

  // 짧으면 그대로 둔다(까닭 없이 자르지 않는다)
  assert.equal(fitLabel("짧은 질문"), "짧은 질문");
  assert.equal(fitLabel("  여러   칸  "), "여러 칸", "줄바꿈·연속 공백은 한 칸으로");
  assert.equal(fitLabel(""), "(빈 메시지)");
});

test("검색은 질문과 답을 모두 본다", () => {
  const turns = buildTurns(forked(), "a2");
  assert.deepEqual([...findTurns(turns, forked(), "저러저러")], ["a3"], "답에서도 찾아야 한다");
  assert.deepEqual([...findTurns(turns, forked(), "2번 더")], ["a3"]);
  assert.equal(findTurns(turns, forked(), "   ").size, 0, "빈 검색어는 전부 걸리면 안 된다");
});
