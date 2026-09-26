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
import { ancestorsOf, fileName, parentDir, pickByTitle } from "../src/lib/notePath.ts";

test("[[제목]] 은 같은 제목 중 링크를 적은 문서에서 가까운 것 — 서버 nearest 와 같은 사례(65차)", () => {
  const n = (path) => ({ path, title: fileName(path).replace(/\.md$/, "") });
  const two = [n("가/메모.md"), n("나/메모.md")];
  assert.equal(pickByTitle(two, "메모", "나/출발.md")?.path, "나/메모.md");   // 같은 폴더
  assert.equal(pickByTitle(two, "메모", "다/출발.md")?.path, "가/메모.md");   // 없으면 얕은 것, 같으면 경로 순서
  assert.equal(pickByTitle([n("가/깊은/메모.md"), n("메모.md")], "메모", "나/출발.md")?.path, "메모.md");
  assert.equal(pickByTitle([n("가/메모.md"), n("메모.md")], "메모", "출발.md")?.path, "메모.md");
  assert.equal(pickByTitle(two, "메모", null)?.path, "가/메모.md");          // 다른 화면에서 온 것(자리 없음)
  assert.equal(pickByTitle([n("가/하나.md")], "하나", "나/x.md")?.path, "가/하나.md");
  assert.equal(pickByTitle([n("가/todo.txt")], "가/todo.txt")?.path, "가/todo.txt"); // 경로로도
  assert.equal(pickByTitle(two, "없음", "나/x.md"), undefined);
  // [[폴더/제목]] — 제목이 겹칠 때 쓰는 꼴(66차: 못 찾아서 '만들기'가 있던 문서를 덮었다)
  assert.equal(pickByTitle(two, "나/메모", "가/x.md")?.path, "나/메모.md");
  assert.equal(pickByTitle(two, "가/메모.md", null)?.path, "가/메모.md");
  assert.equal(pickByTitle(two, "다/메모", null), undefined);
  const src = readFileSync(new URL("../src/pages/Notes.tsx", import.meta.url), "utf8");
  assert.match(src, /pickByTitle\(notes, title, from\)/, "문서 화면이 이 규칙으로 찾지 않는다");
});

test("문서 화면의 '만들기'는 모두 만들기만 한다 — 있으면 덮지 않는다(66차)", () => {
  // 새 노트·링크로 만들기·'새 문서 만들어 링크' 셋. 화면의 '있나?' 확인은 낡은 목록을 보므로 서버가 막는다.
  const src = readFileSync(new URL("../src/pages/Notes.tsx", import.meta.url), "utf8");
  assert.equal(src.match(/api\.noteCreate\(/g)?.length, 3, "만들기가 noteCreate 를 거치지 않는 곳이 있다");
  assert.doesNotMatch(src, /save\(`\$\{title\}\.md`/, "링크로 만들기가 덮어쓰는 저장을 쓴다");
  assert.doesNotMatch(src, /api\.noteSave\(path, `# /, "'새 문서 만들어 링크'가 덮어쓰는 저장을 쓴다");
});

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
test("마크다운과 평문은 확장자로 가린다 — 평문은 글자 그대로 연다(50차)", async () => {
  const { isMarkdownPath } = await import("../src/lib/notePath.ts");
  for (const p of ["메모.md", "a/b/회의.MD", "긴글.markdown"]) assert.equal(isMarkdownPath(p), true, p);
  for (const p of ["메모.txt", "코드.py", "설정.json", "2026.08 회고", "md", "a.md.txt"]) assert.equal(isMarkdownPath(p), false, p);
  // 평문을 마크다운으로 열면 `# 주석` 이 제목으로, `**kw` 의 별표가 사라져 보였다
  const ed = readFileSync(new URL("../src/components/notes/LiveEditor.tsx", import.meta.url), "utf8");
  assert.match(ed, /const md = \(\.\.\.e: Extension\[\]\): Extension\[\] => \(plain \? \[\] : e\);/);
  for (const ext of ["markdown\\(\\{", "livePreview", "embedDeco", "itemLinks\\(\\{", "autocompletion\\(\\{", "tableTools\\(\\)"]) {
    assert.match(ed, new RegExp(`\\.\\.\\.md\\([\\s\\S]{0,400}${ext}`), `${ext} 가 평문에서도 켜진다`);
  }
  const notes = readFileSync(new URL("../src/pages/Notes.tsx", import.meta.url), "utf8");
  assert.match(notes, /plain=\{!isMarkdown\}/);
  assert.match(notes, /current && isEditable && isMarkdown && \(/, "평문에도 읽기(마크다운 보기) 단추가 뜬다");
});