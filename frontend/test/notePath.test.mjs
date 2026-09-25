/**
 * 연 문서가 트리에서 보인다(21차).
 *
 * 링크·검색·그래프로 문서를 열면 트리의 폴더가 접힌 채였다 — 문서 2천 개 트리에서 지금 연
 * 문서가 어디 있는지 찾을 수 없었고, 이름 바꾸기·옮기기 메뉴는 그 줄에만 있다. 문서를 열 때
 * 조상 폴더를 모두 펼친다(ancestorsOf).
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/notePath.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ancestorsOf, fileName, parentDir } from "../src/lib/notePath.ts";

test("파일명·부모 폴더", () => {
  assert.equal(fileName("서버/설정/기록.md"), "기록.md");
  assert.equal(fileName("루트.md"), "루트.md");
  assert.equal(parentDir("서버/설정/기록.md"), "서버/설정");
  assert.equal(parentDir("루트.md"), "");
});

test("조상 폴더는 뿌리부터 가까운 쪽까지 전부", () => {
  assert.deepEqual(ancestorsOf("서버/설정/기록.md"), ["서버", "서버/설정"]);
  assert.deepEqual(ancestorsOf("루트문서.md"), []);
  assert.deepEqual(ancestorsOf("/a/b/"), ["a"]);          // 앞뒤 빗금은 없는 것으로
  assert.deepEqual(ancestorsOf("2026.08 회고/v1.2 계획"), ["2026.08 회고"]);
});

test("문서 화면은 문서가 바뀔 때 그 조상 폴더를 펼치고 그 줄로 내린다", () => {
  const src = readFileSync(new URL("../src/pages/Notes.tsx", import.meta.url), "utf8");
  assert.match(src, /ancestorsOf\(current\)/, "연 문서의 조상 폴더를 펼치지 않는다");
  assert.match(src, /data-note=\{n\.path\}/, "트리 줄을 찾을 표식이 없다");
  assert.match(src, /scrollIntoView\(\{ block: "nearest" \}\)/, "연 문서의 줄로 내리지 않는다");
});
