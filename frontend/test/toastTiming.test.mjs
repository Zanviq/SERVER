/**
 * 알림이 떠 있는 시간(디자인 18차) — 긴 오류가 다 읽기 전에 사라지지 않는가.
 *
 * 모든 알림이 3.8초였다. 알림은 탭을 삼키지 않도록 누를 수 없게 해 두어(Toaster 의 pointer-events-none) 붙잡을 길이
 * 없는데, 긴 오류 문장은 그 안에 다 읽을 수 없었다. 진짜 store/toast 의 toastMs 를 부른다.
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/toastTiming.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toastMs, useToast } from "../src/store/toast.ts";

test("짧은 알림은 예전 그대로, 오류는 조금 더, 긴 글은 길이에 맞춰(10초까지)", () => {
  assert.equal(toastMs("복원됨", "ok"), 3800);
  assert.equal(toastMs("저장 실패", "error"), 5000);
  const long = '이름에 쓸 수 없는 글자(< > : " | ? *)가 있습니다 — 다른 글자로 바꿔 주세요.';
  assert.ok(toastMs(long, "error") > 6000, `${toastMs(long, "error")}ms — 긴 오류가 짧다`);
  assert.equal(toastMs("가".repeat(500), "error"), 10000, "끝없이 떠 있지는 않는다");
});

test("알림을 띄우면 그 시간 뒤에 사라진다", async () => {
  const realSet = globalThis.setTimeout;
  const waits = [];
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); return realSet(fn, 0); };
  try {
    useToast.getState().push("시험 오류 알림 문장", "error");
    assert.deepEqual(waits, [toastMs("시험 오류 알림 문장", "error")]);
  } finally {
    globalThis.setTimeout = realSet;
  }
});
