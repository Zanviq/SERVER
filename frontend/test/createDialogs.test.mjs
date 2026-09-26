/**
 * 문서 화면의 만들기 창(디자인 18차) — 서버가 이름을 거절해도 적은 이름이 창에 남는가.
 *
 * 실측(390px): 새 노트 `시험D18:콜론` → 서버 400("이름에 쓸 수 없는 글자…"). 창은 보내기 **전에** 닫혀 적은 이름이
 * 사라졌고, 한 글자를 고치려고 창을 다시 열어 처음부터 쳐야 했다. 이름 바꾸기 창은 이미 받아 준 뒤에 닫았다.
 *
 * 돌리는 법: node --test test/createDialogs.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/pages/Notes.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const body = (name) => {
  const s = src.indexOf(`const ${name} = async () => {`);
  assert.ok(s > 0, `${name} 를 못 찾았다`);
  return src.slice(s, src.indexOf("\n  };\n", s));
};

test("새 노트 창은 서버가 받아 준 뒤에 닫는다", () => {
  const b = body("createNote");
  const sent = b.indexOf("await makeDoc(");
  const closes = [...b.matchAll(/setNewNoteOpen\(false\)/g)].map((m) => m.index);
  // 닫는 곳은 둘 — '이미 있는 문서를 연다'(보내지 않는 갈래)와 받아 준 뒤
  assert.equal(closes.length, 2, `${closes.length}`);
  assert.ok(closes[0] < b.indexOf("openNote(path);\n      return;"), "이미 있으면 닫고 그 문서를 연다");
  assert.ok(closes[1] > sent && closes[1] > b.indexOf("if (!made.ok)"), "보내기 전에 닫으면 거절될 때 적은 이름이 사라진다");
  assert.match(b, /creating\.current/, "도는 동안 Enter 를 또 누르면 두 번 보낸다");
});

test("새 폴더 창도 받아 준 뒤에 닫는다", () => {
  const b = body("createFolder");
  assert.ok(b.indexOf("setNewFolderOpen(false)") > b.indexOf("await api.noteFolderCreate(path)"));
  assert.match(b, /finally \{\s*creating\.current = false;/);
});
