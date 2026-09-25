/**
 * 입력칸의 도움(목록 잇기·링크 후보 넣기) 뒤에도 Ctrl+Z 가 산다(24차).
 *
 * 값을 스크립트로 통째로 넣으면 브라우저가 되돌리기 기록을 지운다. 실측(운영 번들): `- 사과`
 * 에서 줄을 바꿔 목록이 이어진 뒤 Ctrl+Z 를 세 번 눌러도 아무것도 되돌아가지 않았다 — 그 전에 친
 * 글까지. 링크 후보를 고른 뒤·빈 항목에서 목록을 끝낸 뒤도 같았다. 이제 바뀐 조각만(diffRange)
 * 브라우저의 편집 명령으로 넣는다.
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/textEdit.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { diffRange } from "../src/lib/textEdit.ts";

const apply = (before, r) => before.slice(0, r.from) + r.insert + before.slice(r.to);

test("바뀐 한 조각만 — 적용하면 뒤 글이 된다", () => {
  const cases = [
    ["- 사과", "- 사과\n- "],                       // 목록 잇기(끝에 붙임)
    ["- 배\n- ", "- 배\n"],                          // 빈 항목에서 끝내기(지움)
    ["앞말 [note/폴더 뒷말", "앞말 [note/폴더00/ 뒷말"],  // 가운데 바꿈
    ["aaa", "aaaa"],                                 // 같은 글자가 이어져도
    ["", "새 글"],
    ["같다", "같다"],
  ];
  for (const [before, after] of cases) {
    const r = diffRange(before, after);
    assert.equal(apply(before, r), after, JSON.stringify([before, after, r]));
  }
  assert.deepEqual(diffRange("- 사과", "- 사과\n- "), { from: 4, to: 4, insert: "\n- " });
  assert.deepEqual(diffRange("같다", "같다"), { from: 2, to: 2, insert: "" });
});

test("입력칸 도움은 값을 통째로 넣지 않고 편집 명령으로 넣는다", () => {
  const src = readFileSync(new URL("../src/components/links/useMarkdownInput.tsx", import.meta.url), "utf8");
  assert.match(src, /execCommand\("insertText"/, "편집 명령을 쓰지 않는다 — 되돌리기 기록이 지워진다");
  // 통째로 넣는 것은 명령을 못 쓸 때의 대비 한 곳뿐이어야 한다(정의 + replaceValue 안의 대비)
  const calls = src.match(/setNativeValue\(el, /g) ?? [];
  assert.equal(calls.length, 1, `값을 통째로 넣는 곳이 ${calls.length}곳 — 되돌리기가 다시 끊긴다`);
});
