/**
 * 설정 화면의 줄(디자인 12차) — 휴대폰에서 넓은 조작이 이름을 짓누르지 않는가.
 *
 * 실측(390px): 캘린더 탭의 "기본 색상" 이 **기/본/색/상** 한 글자씩 세로로 섰고(색 열한 개가 줄을 다 차지), AI 탭의
 * "AI 모델" 설명은 "상위 모/델일수록/판단이…" 로 부서져 줄 높이가 250px 가 됐다. Row 의 이름 칸이 min-w-0 이고 조작이
 * shrink-0 이라 줄어드는 쪽이 늘 이름이었다. 이제 이름은 9rem 을 지키고 조작이 아랫줄로 내려간다.
 *
 * 돌리는 법: node --test test/settingsLayout.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/pages/Settings.tsx", import.meta.url), "utf8");

test("줄은 넘치면 조작을 아랫줄로 내리고, 이름 칸은 짓눌리지 않는다", () => {
  const row = src.slice(src.indexOf("function Row("), src.indexOf("function DiaryPin"));
  assert.match(row, /className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line py-3"/);
  assert.match(row, /<div className="min-w-\[9rem\] flex-1">/, "이름 칸에 최소 폭이 없으면 넓은 조작이 짓누른다");
  assert.doesNotMatch(row, /<div className="min-w-0">/);
});

test("설정 분류는 이름이 있고, 고른 것을 알린다", () => {
  assert.match(src, /<nav aria-label="설정 분류"/);
  assert.match(src, /aria-current=\{tab === t\.id \? "true" : undefined\}/);
});
