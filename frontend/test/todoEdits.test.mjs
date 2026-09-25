/**
 * 할 일 고치기 — 잇달아 해도 버려지지 않고, 떠나도 사라지지 않는다(44·45차).
 *
 * guard 는 다른 조작이 도는 동안 들어온 것을 말없이 버린다(새 할 일 두 번 누름을 막는 규칙).
 * 완료 표시(44차)와 상세의 색·마감(45차)이 그 규칙에 걸려, 잇달아 누르면 사이의 것 또는 마지막
 * 것이 알림 없이 사라졌다. 완료 표시는 또 매번 보드 전체를 다시 받아 600줄을 다시 그렸다
 * (CPU 4배에서 한 번에 약 1.1~1.3초 → 0.4~0.6초). 제목은 칸을 벗어날 때만 보내 새로고침에 사라졌다.
 * (예전 이름 todoToggle.test.mjs — 완료 표시만 보던 때의 이름.)
 *
 * 돌리는 법: node --test test/todoEdits.test.mjs
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

test("상세의 고치기(마감·카테고리·색)는 guard 없이 차례로 보낸다 — 45차", () => {
  // guard 는 도는 중 들어온 것을 말없이 버려 색을 잇달아 두 번 고르면 마지막 것이 사라졌다(연두→노랑이 연두로)
  const patch = src.slice(src.indexOf("const patchDetail = "), src.indexOf("const titleSave = "));
  assert.ok(patch.length > 0, "patchDetail 을 못 찾았다");
  assert.doesNotMatch(patch, /guard\(/, "상세의 고치기가 guard 를 탄다 — 잇달아 고른 것이 버려진다");
  assert.match(patch, /patchChain\.current = patchChain\.current\.then\(/, "차례로 줄을 세우지 않는다 — 응답이 뒤집히면 앞의 값으로 돌아간다");
});

test("할 일 제목은 칠 때 모아 보내고 칸을 벗어나면 곧바로 보낸다 — 45차", () => {
  // 칸을 벗어날 때만 보내 새로고침·앱 전환에 고친 제목이 사라졌다
  assert.match(src, /const titleSave = usePendingSave\(\[selectedTodo\]\)/);
  assert.match(src, /onChange=\{\(e\) => typeTitle\(detail\.id, e\.target\.value\)\}\s*onBlur=\{\(\) => \{ void titleSave\.flush\(\); \}\}/);
  // 설명과 같은 PendingSave 를 쓰면 마지막 하나만 남아 한쪽이 다른 쪽을 지운다
  assert.notEqual(src.indexOf("const titleSave"), src.indexOf("const descSave"));
});