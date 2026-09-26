/**
 * 휴지통 줄의 부제(디자인 5차) — 휴대폰 한 줄에서 **지운 때가 잘리지 않고**, 문서는 제 이름을 되풀이하지 않는가.
 *
 * 실측(390px): 부제가 `시험79링크-ik0s · 2026.09.26 1…` — 맨 위 문서는 경로가 곧 제 이름이라 이름을 한 번 더
 * 적었고, 한 줄로 이어 쓴 끝의 날짜부터 잘렸다. 고친 뒤 `폴더 · 맨 위 · 삭제 09.26 16:57`.
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/trashRows.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatIsoDay, formatStamp } from "../src/lib/format.ts";

const now = new Date(2026, 8, 26, 18, 0);
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;

test("지운 때 — 올해면 해를 뺀다", () => {
  assert.equal(formatStamp(at(2026, 9, 26, 16, 57), now), "09.26 16:57");
  assert.equal(formatStamp(at(2025, 12, 31, 9, 5), now), "2025.12.31 09:05");
});

test("일정 시작·할 일 마감도 같은 꼴", () => {
  assert.equal(formatIsoDay("2026-09-27", now), "09.27");
  assert.equal(formatIsoDay("2026-09-27T10:00:00", now), "09.27 10:00");
  assert.equal(formatIsoDay("2027-01-02T08:30", now), "2027.01.02 08:30");
  assert.equal(formatIsoDay("", now), "");
  assert.equal(formatIsoDay(undefined, now), "");
  assert.equal(formatIsoDay("아무 글", now), "");
});

test("부제는 설명 쪽만 줄고, 문서는 있던 폴더를 적는다", () => {
  const src = readFileSync(new URL("../src/pages/Trash.tsx", import.meta.url), "utf8");
  assert.match(src, /<span className="truncate">\{detail\}<\/span>\s*<span className="shrink-0 whitespace-pre"> · 삭제 \{formatStamp\(e\.deleted_at\)\}<\/span>/,
    "지운 때가 줄어드는 쪽에 있다 — 휴대폰에서 날짜부터 잘린다");
  assert.match(src, /const from = parentDir\(e\.orig_rel\);/);
  assert.doesNotMatch(src, /\$\{e\.orig_rel\} ·/, "경로 전체를 적으면 맨 위 문서가 제 이름을 되풀이한다");
});
