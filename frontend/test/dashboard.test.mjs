/**
 * 대시보드(디자인 13차) — '최근 노트' 의 줄이 **그 문서**를 열고, 같은 이름의 두 문서를 가려 보이는가.
 *
 * 실측(운영 번들): 최근 다섯 가운데 `확장자시험21b/메모.markdown` 줄을 누르면 `확장자시험21/메모.py` 가 열렸다 — 제목
 * (`?open=메모`)으로 열어 같은 제목이면 한쪽만 열렸고, 두 줄이 모두 "메모" 로만 보였다. 제목으로 열면 목록이 낡았을 때
 * 없는 제목으로 빈 노트를 새로 만들기도 한다(`?open=` 의 기본은 만들기다 — 그래프는 이미 경로로 연다).
 *
 * 돌리는 법: node --test test/dashboard.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/pages/Dashboard.tsx", import.meta.url), "utf8");

test("최근 노트는 경로로 열고, 파일 이름과 폴더를 보인다", () => {
  assert.match(src, /navigate\(`\/notes\?path=\$\{encodeURIComponent\(n\.path\)\}`\)/);
  assert.doesNotMatch(src, /\/notes\?open=/, "제목으로 열면 같은 제목의 다른 문서가 열리거나 빈 노트가 생긴다");
  assert.match(src, /\{fileName\(n\.path\)\}/);
  assert.match(src, /\{parentDir\(n\.path\)\}/);
});

test("바로가기는 좁은 화면에서 세 칸 — 하나가 혼자 한 줄을 차지하지 않는다", () => {
  assert.match(src, /<div className="grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-4">/);
  assert.match(src, /<p className="hidden text-\[12px\] text-fg-muted sm:block">\{s\.desc\}<\/p>/);
});
