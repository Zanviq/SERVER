/**
 * 입력칸에서 목록·인용을 이어 쓰는가(문서 편집기와 같은 규칙).
 *
 * 돌리는 법:
 *   node --experimental-strip-types --import ./test/tsResolve.mjs --test test/mdInput.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { continueList } from "../src/lib/mdInput.ts";

/** `|` 가 커서 자리 */
const at = (s) => {
  const r = continueList(s.replace("|", ""), s.indexOf("|"));
  return r && r.text.slice(0, r.caret) + "|" + r.text.slice(r.caret);
};

test("목록 줄에서 줄을 바꾸면 같은 표시를 잇는다", () => {
  assert.equal(at("- 첫째|"), "- 첫째\n- |");
  assert.equal(at("* 별|"), "* 별\n* |");
  assert.equal(at("  - 안쪽|"), "  - 안쪽\n  - |", "들여쓰기를 지킨다");
  assert.equal(at("1. 가|"), "1. 가\n2. |", "번호는 하나 올린다");
  assert.equal(at("9) 끝|"), "9) 끝\n10) |");
  assert.equal(at("- [x] 한 일|"), "- [x] 한 일\n- [ ] |", "체크박스는 빈 칸으로");
});

test("빈 항목에서 줄을 바꾸면 목록을 끝낸다", () => {
  assert.equal(at("- 첫째\n- |"), "- 첫째\n|");
  assert.equal(at("1. 가\n2. |"), "1. 가\n|");
  assert.equal(at("  - |"), "  |", "안쪽 목록은 들여쓰기만 남긴다");
});

test("줄 가운데서 바꾸면 뒷부분이 새 항목이 된다", () => {
  assert.equal(at("- 우유| 계란"), "- 우유\n- | 계란");
});

test("인용도 잇고, 빈 인용 줄에서 끝낸다", () => {
  assert.equal(at("> 인용|"), "> 인용\n> |");
  assert.equal(at("> 인용\n> |"), "> 인용\n|");
});

test("목록이 아닌 줄, 표시보다 앞에 커서가 있으면 손대지 않는다", () => {
  assert.equal(at("그냥 글|"), null);
  assert.equal(at("|- 첫째"), null, "표시 앞에서 바꾸면 그냥 줄바꿈이다");
  assert.equal(at("-없음|"), null, "공백 없는 하이픈은 목록이 아니다");
  assert.equal(at("2026-09-25|"), null);
});

test("코드 울타리 안에서는 목록을 잇지 않는다(코드 속 '- '·'1. ' 는 목록이 아니다)", () => {
  // 예전에는 YAML·셸 스크립트를 적다 줄을 바꾸면 '- '·'2. ' 가 코드에 끼어들었다(17차)
  assert.equal(at("```yaml\nitems:\n  - a|"), null);
  assert.equal(at("~~~\n1. 코드 속 번호|"), null);
  assert.equal(at("````\n```\n- 긴 울타리 안의 짧은 울타리|"), null, "짧은 울타리는 긴 것을 닫지 못한다");
  // 닫힌 뒤에는 다시 목록이다
  assert.equal(at("```\n코드\n```\n- 밖|"), "```\n코드\n```\n- 밖\n- |");
  assert.equal(at("~~~\n코드\n```\n- 아직 안|"), null, "다른 글자의 울타리는 닫지 못한다");
});
