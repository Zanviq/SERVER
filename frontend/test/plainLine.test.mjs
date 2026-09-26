/**
 * 마크다운 → 한 줄 평문(디자인 25차) — 대화 지도의 차례 이름(화면)과 컨텍스트 세션 미리보기(서버)가 **같은 규칙**인가.
 *
 * 원문을 그대로 한 줄로 이으면 `## 시험51 제목 - **굵게** 와 \`코드\` - [ ] 할 일 > 인용 | 가 | 나` 처럼 기호가 글보다
 * 먼저 보였다(휴대폰 한 줄·지도의 좁은 이름 칸에서는 기호만 남았다). 표본은 plainLineCases.json 하나를 서버 시험
 * (test_smoke 의 test_context_preview_is_plain_text)도 같이 읽는다 — 한쪽만 고치면 다른 쪽이 깨진다.
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/plainLine.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { plainLine } from "../src/lib/plainLine.ts";

const CASES = JSON.parse(readFileSync(new URL("./plainLineCases.json", import.meta.url), "utf8"));

test("표본마다 뜻 있는 글만 남는다", () => {
  for (const [md, want] of CASES) assert.equal(plainLine(md), want, JSON.stringify(md));
});

test("대화 지도의 차례 이름이 이 규칙을 쓴다", () => {
  const src = readFileSync(new URL("../src/lib/chatTree.ts", import.meta.url), "utf8");
  assert.match(src, /plainLine\(plainRefs\(userMsg\.text\)\)/);
});
