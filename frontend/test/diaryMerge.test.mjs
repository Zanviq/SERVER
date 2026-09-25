/**
 * 두 곳에서 같은 날 일기를 고쳤을 때 둘 다 남기는 합치기(28차).
 *
 * 서버가 409(연 뒤에 다른 곳에서 바뀜)를 주면 화면은 서버 글 뒤에 이 기기에서 쓴 부분만 표시를 달아
 * 붙여 저장한다. 같이 시작한 앞부분은 한 번만, 줄 머리에서 자른다.
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/diaryMerge.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MERGE_MARK, mergeDiaryText } from "../src/lib/diaryMerge.ts";

test("같이 시작한 줄은 한 번만, 이 기기에서 쓴 부분만 붙인다", () => {
  const merged = mergeDiaryText("아침 첫 줄\n폰 문단", "아침 첫 줄\nPC 덧붙임");
  assert.equal(merged, `아침 첫 줄\n폰 문단\n\n${MERGE_MARK}\nPC 덧붙임`);
});

test("붙일 것이 없으면 저쪽 글 그대로", () => {
  assert.equal(mergeDiaryText("아침 첫 줄\n폰 문단", "아침 첫 줄"), "아침 첫 줄\n폰 문단");   // 내 글은 이미 들어 있다
  assert.equal(mergeDiaryText("같다", "같다"), "같다");
  assert.equal(mergeDiaryText("저쪽", ""), "저쪽");
  assert.equal(mergeDiaryText("", "내 글"), "내 글");                                      // 저쪽이 비웠다
});

test("낱말 한가운데서 가르지 않는다(줄 머리에서 자른다)", () => {
  const merged = mergeDiaryText("오늘은 비가 왔다", "오늘은 맑았다");
  assert.equal(merged, `오늘은 비가 왔다\n\n${MERGE_MARK}\n오늘은 맑았다`);
});

test("일기 칸은 연 때의 base 를 실어 보내고, 409 면 합친다 — 저장은 한 줄로 세운다", () => {
  const src = readFileSync(new URL("../src/components/calendar/DiaryPanel.tsx", import.meta.url), "utf8");
  assert.match(src, /base_at: baseAt\.current/, "저장에 base 를 싣지 않는다 — 다른 곳의 글을 덮는다");
  assert.match(src, /e\.status === 409/, "409 를 받아 합치지 않는다");
  assert.match(src, /schedule\(autosaveMs, \(\) => enqueue\(async \(\) => \{\s*setSaving\(true\);\s*try \{\s*const saved = await saveText/,
    "글 저장이 한 줄로 서지 않는다 — 제 앞 저장과 충돌한다");
  assert.match(src, /void enqueue\(async \(\) => \{\s*try \{\s*const saved = await api\.diarySave\(day, patch\)/,
    "도형 저장이 글 저장과 같은 줄에 서지 않는다");
});
