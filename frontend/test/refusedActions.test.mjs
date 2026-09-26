/**
 * 서버가 늘 거절하는 동작을 화면이 권하지 않는가(디자인 31·32차).
 *
 * 32차: 문서 트리의 '논문'·'회의'(다른 화면에서 붙여 온 것) 안쪽 줄의 … 메뉴에 '이동'이 있었는데, 서버는 붙여 온 것의
 * 옮기기를 늘 400 으로 거절한다(routers/notes._reject_mount_reshape — "논문·회의에서 온 파일은 여기서 옮길 수 없습니다").
 * 이름 바꾸기·휴지통은 그 논문·회의 자체에 대해 된다(_rename_mounted·delete_note 의 마운트 갈래)라 그대로 둔다.
 * 31차(계정 관리 내 줄의 비활성화·삭제)는 test/accountAdmin.
 *
 * 돌리는 법: node --test test/refusedActions.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("붙여 온 줄의 … 메뉴에는 '이동'이 없다", () => {
  const menu = read("../src/components/notes/RowMenu.tsx");
  assert.match(menu, /onMove\?: \(\) => void;/, "이동을 뺄 수 없다");
  assert.match(menu, /\{onMove && <MenuItem icon=\{FolderInput\} label="이동"/);
  const notes = read("../src/pages/Notes.tsx");
  assert.match(notes, /const onMount = \(path: string\) => pinned\.some\(\(p\) => path\.startsWith\(`\$\{p\}\/`\)\);/);
  assert.equal(notes.match(/onMove=\{onMount\((?:child|n)\.path\) \? undefined : /g)?.length, 2, "폴더 줄·문서 줄 모두");
  // 서버 쪽 규칙이 그대로인지 — 바뀌면(옮기기를 받게 되면) 이 시험과 화면을 다시 볼 것
  const server = readFileSync(new URL("../../backend/routers/notes.py", import.meta.url), "utf8");
  assert.match(server, /_reject_mount_reshape\(user, settings, req\.path, "옮길"\)/);
});
