/**
 * 할 일 완료 표시 — 잇달아 눌러도 모두 되고, 한 줄만 고친다(44차).
 *
 * 예전엔 완료 표시가 guard 를 탔다. guard 는 다른 조작이 도는 동안 들어온 것을 말없이 버리므로,
 * 목록을 훑으며 잇달아 누르면 사이의 것들이 완료되지 않았다(실측: 60ms 간격 넷 중 둘, 알림 없음).
 * 또 매번 보드 전체를 다시 받아 600줄을 다시 그렸다(CPU 4배에서 한 번에 약 1.1~1.3초 → 0.4~0.6초).
 *
 * 돌리는 법: node --test test/todoToggle.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/pages/Todo.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const body = src.slice(src.indexOf("const toggleDone = "), src.indexOf("const removeTodo = "));

test("완료 표시는 guard 를 타지 않는다(바쁜 동안 누른 것을 버리지 않게)", () => {
  assert.ok(body.length > 0, "toggleDone 을 못 찾았다 — 이 시험의 자르는 자리를 확인할 것");
  assert.doesNotMatch(body, /guard\(/, "완료 표시가 guard 를 탄다 — 잇달아 누른 것이 말없이 버려진다");
});

test("완료 표시는 서버가 돌려준 한 줄과 배지 수만 고친다(보드 전체를 다시 받지 않는다)", () => {
  assert.doesNotMatch(body, /reload\(\)/, "완료 표시마다 보드 전체를 다시 받는다");
  assert.match(body, /replaceTodo\(saved\)/);
  assert.match(src, /const replaceTodo = \(saved: TodoItem\) => setTodos\(\(ts\) => ts\.map\(\(x\) => \(x\.id === saved\.id \? saved : x\)\)\)/);
  assert.match(body, /setCounts\(/, "배지 수를 고치지 않는다 — 트리의 남은 개수가 어긋난다");
  assert.match(body, /toast\.error\(/, "실패를 알리지 않는다");
});
