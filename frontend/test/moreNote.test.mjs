/**
 * "N개 더" 한 줄 — 링크 후보(8차)와 전체 검색(13차)이 같은 문구를 쓴다.
 *
 * 돌리는 법:
 *   node --experimental-strip-types --import ./test/tsResolve.mjs --test test/moreNote.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { moreNote } from "../src/lib/moreNote.ts";

test("끝까지 센 수와 '적어도' 인 수를 가른다", () => {
  assert.equal(moreNote(15, "이름을 더 쳐서 좁히세요"), "… 15개 더 있습니다 — 이름을 더 쳐서 좁히세요");
  assert.equal(moreNote(17, "검색어를 좁혀 보세요", true), "… 17개 넘게 더 있습니다 — 검색어를 좁혀 보세요");
});

test("문구는 한 곳에만 있다(한쪽만 고쳐 두 가지 말이 되지 않게)", () => {
  for (const f of ["components/links/linkFetch.ts", "components/search/SearchPalette.tsx"]) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /더 있습니다/, `${f} 에 문구가 따로 있다`);
    assert.match(src, /moreNote\(/, `${f} 가 moreNote 를 안 쓴다`);
  }
});
