/**
 * 단어장 작업 추적 — **결과를 모르게 됐을 때 모른다고 말하는가.**
 *
 * 작업 기록은 서버 메모리에만 있다. 그래서 **배포할 때마다** 진행 중인 작업이
 * 사라진다. 예전에는 그때 조용히 추적만 접었다 — 사용자는 "정리를 시작했습니다"
 * 만 보고 그 뒤로 성공도 실패도 듣지 못했고, 단어장을 다시 읽지도 않아 이미
 * 들어간 단어가 있어도 화면에 안 나왔다.
 *
 * zustand·fetch 없이 순수 규칙만 확인한다(store 는 브라우저 API 를 쓴다).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

/** vocabJobs.tick 의 판단 부분과 같은 규칙. 여기서 규칙만 따로 확인한다. */
function decide(watching, rows, now, giveUpMs) {
  const byId = new Map(rows.map((j) => [j.id, j]));
  const still = [];
  const announced = [];
  const lost = [];
  for (const w of watching) {
    const cur = byId.get(w.id);
    if (!cur) {
      lost.push(w.id);
      continue;
    }
    if (cur.status === "pending") {
      if (now - w.startedAt > giveUpMs) lost.push(w.id);
      else still.push(cur);
      continue;
    }
    announced.push(cur.id);
  }
  return { still, announced, lost, reload: announced.length + lost.length > 0 };
}

const GIVE_UP = 5 * 60 * 1000;
const job = (id, status = "pending") => ({ id, status, words: ["a", "b"] });

test("끝나면 알리고 단어장을 다시 읽는다", () => {
  const r = decide([{ id: "j1", startedAt: 0 }], [job("j1", "done")], 1000, GIVE_UP);
  assert.deepEqual(r.announced, ["j1"]);
  assert.equal(r.reload, true);
  assert.equal(r.still.length, 0);
});

test("아직 돌고 있으면 계속 지켜본다", () => {
  const r = decide([{ id: "j1", startedAt: 0 }], [job("j1")], 1000, GIVE_UP);
  assert.equal(r.still.length, 1);
  assert.deepEqual(r.lost, []);
  assert.equal(r.reload, false);
});

test("서버가 재시작돼 기록이 사라지면 — 조용히 넘기지 않는다", () => {
  const r = decide([{ id: "j1", startedAt: 0 }], [], 1000, GIVE_UP);
  assert.deepEqual(r.lost, ["j1"], "사라진 작업을 알려야 한다");
  assert.equal(r.reload, true, "단어장을 다시 읽어야 이미 들어간 것이 보인다");
  assert.equal(r.still.length, 0, "없는 작업을 계속 지켜보면 안 된다");
});

test("영영 pending 이면 상한에서 접는다", () => {
  const watching = [{ id: "j1", startedAt: 0 }];
  const before = decide(watching, [job("j1")], GIVE_UP - 1, GIVE_UP);
  assert.equal(before.still.length, 1, "상한 전에는 계속 본다");
  const after = decide(watching, [job("j1")], GIVE_UP + 1, GIVE_UP);
  assert.deepEqual(after.lost, ["j1"], "상한을 넘으면 접고 알린다");
});

test("여러 작업 중 하나만 사라져도 나머지는 계속 본다", () => {
  const r = decide(
    [{ id: "j1", startedAt: 0 }, { id: "j2", startedAt: 0 }],
    [job("j2")], 1000, GIVE_UP);
  assert.deepEqual(r.lost, ["j1"]);
  assert.equal(r.still.length, 1);
  assert.equal(r.still[0].id, "j2");
});
