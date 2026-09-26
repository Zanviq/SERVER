/**
 * 머리의 '대화 비우기'(휴지통)는 그 대화가 **보일 때만** 있다(디자인 7·9차).
 *
 * 한 칸 화면에서 대화가 숨어 있는데 머리에 휴지통이 있으면 지금 보이는 것을 지우는 단추로 읽힌다 — 영어는 단어장,
 * 논문은 PDF, 회의는 회의 본문 위였다(실측: 논문 PDF 를 보는 중에도 휴지통). 넓은 화면은 대화가 늘 옆에 있어 그대로.
 *
 * 돌리는 법: node --test test/chatClear.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("곁칸에 대화가 있는 화면은 그 칸을 볼 때만 휴지통을 둔다", () => {
  for (const [page, shown] of [
    ["../src/pages/Papers.tsx", 'paneTab === "side"'],
    ["../src/pages/Meetings.tsx", 'paneTab === "side"'],
    ["../src/pages/English.tsx", 'mobileView === "vocab"'],
  ]) {
    const src = read(page);
    const btn = src.slice(src.indexOf("<button onClick={clearChat}"), src.indexOf('aria-label="대화 비우기"'));
    assert.ok(btn.includes(shown), `${page}: 휴지통이 대화가 보이는지와 상관없이 나온다`);
    assert.match(btn, /hidden lg:inline-flex/, `${page}: 넓은 화면에서는 늘 보여야 한다`);
  }
  for (const page of ["../src/pages/Papers.tsx", "../src/pages/Meetings.tsx"]) {
    assert.match(read(page), /onMobileTab=\{setPaneTab\}/, `${page}: 어느 칸을 보는지 받지 않는다`);
  }
  // 대화만 있는 화면(AI 비서)은 늘 보여도 된다
  assert.match(read("../src/pages/Assistant.tsx"), /aria-label="대화 비우기"/);
});

test("ThreePane 은 좁은 화면에서 보고 있는 칸을 알린다", () => {
  const src = read("../src/components/notes/ThreePane.tsx");
  assert.match(src, /useEffect\(\(\) => \{ onMobileTab\?\.\(mobileTab\); \}, \[mobileTab, onMobileTab\]\);/);
});
