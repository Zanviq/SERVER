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

test("빈 항목에서 줄을 바꾸면 목록을 끝낸다 — 빈 줄을 하나 둔다(71차)", () => {
  // 표시만 지우면(`- 첫째\n|`) 다음 글이 위 항목에 붙는다(게으른 이어짐) — 아래 '읽기 보기' 시험
  assert.equal(at("- 첫째\n- |"), "- 첫째\n\n|");
  assert.equal(at("1. 가\n2. |"), "1. 가\n\n|");
  assert.equal(at("- [ ] 할 일\n- [ ] |"), "- [ ] 할 일\n\n|", "빈 체크 항목도");
  assert.equal(at("글\n\n- |"), "글\n\n|", "위가 이미 빈 줄이면 더 두지 않는다");
  assert.equal(at("- |"), "|", "첫 줄이면 빈 줄이 필요 없다");
});

test("들여쓴 빈 항목은 한 단계 바깥 목록의 새 항목이 된다(편집기와 같다)", () => {
  assert.equal(at("- 부모\n  - 자식\n  - |"), "- 부모\n  - 자식\n- |");
  assert.equal(at("1. 가\n   - 안\n   - |"), "1. 가\n   - 안\n2. |", "바깥이 번호면 다음 번호");
  assert.equal(at("  - |"), "|", "바깥 목록이 없으면 끝낸다");
});

test("끝낸 뒤 쓴 글은 읽기 보기에서 목록·인용 밖이다 — 71차", async () => {
  const { render, norm } = await import("./mdPipeline.mjs");
  const typed = (s) => at(s).replace("|", "밖");
  assert.match(norm(render(typed("- 하나\n- |"))), /<\/ul><p>밖<\/p>/, "목록 끝낸 뒤의 글이 마지막 항목에 붙었다");
  assert.match(norm(render(typed("> 말\n> |"))), /<\/blockquote><p>밖<\/p>/, "인용 끝낸 뒤의 글이 인용 안에 남았다");
  // 예전 결과(표시만 지움)는 붙었다 — 이 시험이 무엇을 막는지
  assert.doesNotMatch(norm(render("- 하나\n밖")), /<\/ul><p>밖/);
});

test("문서 편집기도 같은 규칙으로 끝낸다(71차)", async () => {
  // 편집기(CM6)는 항목 하나짜리 목록의 빈 둘째 항목에서 목록을 끝내지 않고 느슨한 목록을 만들었다
  // (`- 하나\n\n- 밖`) — 그 동작(nonTightLists)을 끄고, 끝내기는 endsBlock 을 쓴다.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/components/notes/LiveEditor.tsx", import.meta.url), "utf8");
  assert.match(src, /endsBlock\(state\.doc\.sliceString\(0, line\.to\), line\.to\)/, "편집기가 endsBlock 을 안 쓴다");
  assert.match(src, /insertNewlineContinueMarkupCommand\(\{ nonTightLists: false \}\)/);
  assert.match(src, /addKeymap: false/, "markdown() 의 기본 keymap(느슨한 목록 만들기)이 그대로 걸린다");
});

test("줄 가운데서 바꾸면 뒷부분이 새 항목이 된다", () => {
  assert.equal(at("- 우유| 계란"), "- 우유\n- | 계란");
});

test("인용도 잇고, 빈 인용 줄에서 끝낸다", () => {
  assert.equal(at("> 인용|"), "> 인용\n> |");
  assert.equal(at("> 인용\n> |"), "> 인용\n\n|");
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
