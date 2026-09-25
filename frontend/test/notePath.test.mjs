/**
 * 문서 공간의 경로 — 연 문서가 어디 있는지 트리와 주소가 늘 말한다.
 *
 * - 연 문서가 트리에서 보인다(21차): 링크·검색·그래프로 문서를 열면 트리의 폴더가 접힌 채였다 —
 *   문서 2천 개 트리에서 지금 연 문서를 찾을 수 없었고, 이름 바꾸기·옮기기 메뉴는 그 줄에만 있다.
 *   문서를 열 때 조상 폴더를 모두 펼친다(ancestorsOf).
 * - 폴더 줄에도 이름 바꾸기·옮기기가 있고(36·38차), 폴더를 옮길 때 제 자신·하위는 고를 수 없다.
 * - 주소(?path=)가 열린 문서를 따라간다(49차): 새로고침·이름 바꾸기 뒤에도 그 문서가 열린다.
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

test("폴더 줄에도 이름 바꾸기가 있고, 바꾸면 펼침·위치·열린 문서·밑글이 따라간다(36차)", () => {
  const src = readFileSync(new URL("../src/pages/Notes.tsx", import.meta.url), "utf8");
  // 폴더 줄도 문서 줄과 같은 … 메뉴(이름 변경·이동·휴지통) — 끌기가 안 되는 휴대폰·키보드도 옮긴다(38차)
  assert.match(src, /setRenameFor\(\{ path: child\.path, folder: true \}\)/, "폴더 줄에 이름 바꾸기가 없다");
  assert.match(src, /setMoveFor\(\{ path: child\.path, folder: true \}\)/, "폴더 줄에 옮기기(메뉴)가 없다");
  assert.match(src, /f !== moveFor\.path && !f\.startsWith\(`\$\{moveFor\.path\}\/`\)/, "폴더 이동 대상에 제 자신·하위가 뜬다");
  // 뒤처리(밑글·펼침·위치·열린 문서)는 이름 바꾸기와 옮기기가 한 곳(followMove)을 쓴다
  const follow = src.slice(src.indexOf("const followMove"), src.indexOf("const doRenameNote"));
  for (const must of ["moveDraftsUnder(from, to)", "setExpanded(", "setCurFolder(", "moveDraft(from, to)"]) {
    assert.ok(follow.includes(must), `경로가 바뀐 뒤 ${must} 를 하지 않는다`);
  }
  const rename = src.slice(src.indexOf("const doRenameNote"), src.indexOf("const doMoveNote"));
  const move = src.slice(src.indexOf("const doMoveNote"), src.indexOf("const doDeleteNotePath"));
  for (const [name, fn] of [["이름 바꾸기", rename], ["옮기기", move]]) {
    assert.ok(fn.includes("followMove(") && fn.includes("openNote(reopen)"), `${name} 가 뒤처리를 하지 않는다`);
  }
});

test("폴더도 끌어 옮긴다 — 고정 폴더는 빼고, 제 안으로는 놓지 않는다(37차)", () => {
  const src = readFileSync(new URL("../src/pages/Notes.tsx", import.meta.url), "utf8");
  assert.match(src, /draggable=\{!isPinned\(child\.path\)\}/, "폴더 줄을 끌 수 없다");
  const move = src.slice(src.indexOf("const doMoveNote"), src.indexOf("const doDeleteNotePath"));
  assert.match(move, /folder === path \|\| folder\.startsWith\(`\$\{path\}\/`\)/, "폴더를 제 안으로 놓는 것을 막지 않는다");
});

test("주소(?path=)가 열린 문서를 따라간다 — 49차", () => {
  // 전에는 path 를 읽고 곧바로 지워, 새로고침·휴대폰이 되살린 탭이 빈 문서 화면으로 돌아갔고
  // 이름을 바꾼 뒤에는 주소가 옛 경로였다.
  const src = readFileSync(new URL("../src/pages/Notes.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.doesNotMatch(src, /params\.delete\("path"\)/, "주소의 path 를 지운다 — 새로고침하면 연 문서가 사라진다");
  assert.match(src, /if \(current\) next\.set\("path", current\);\s*else next\.delete\("path"\);/, "열린 문서를 주소에 적지 않는다");
  // 적은 값을 다룬 것으로 남겨야 효과가 두 문서를 오가지 않는다
  assert.match(src, /shownPath\.current = current;\s*handledPath\.current = current;/);
  assert.match(src, /if \(path !== handledPath\.current\) \{\s*handledPath\.current = path;\s*if \(path !== current\) openNote\(path\);/);
});