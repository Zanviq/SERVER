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

test("앱 전체: 창을 닫은 다음에 서버에 보내는 함수는 허락한 것뿐이다(디자인 19차)", async () => {
  // 회의 문서 만들기·이름 바꾸기가 같은 모양이었다(19차에 고침). 남은 것은 까닭이 있는 것들:
  const ALLOWED = new Set([
    "pages/Notes.tsx:createNote",   // '이미 있는 문서' 갈래만 먼저 닫는다(보내지 않고 그 문서를 연다)
    "pages/Notes.tsx:doRenameNote", // 이름을 안 바꿨을 때만 먼저 닫는다(보낼 것이 없다)
    "pages/Notes.tsx:delNote",      // 확인 창 — 잃을 입력이 없다
    "pages/Trash.tsx:doEmpty",      // 확인 창 — 잃을 입력이 없다
  ]);
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const files = [];
  (function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(n) && files.push(p); } })(root);
  const CLOSE = /\bset\w*(?:Open|Dialog|For|Edit|Modal)\w*\((?:false|null|""|undefined)\)/;
  const found = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    for (const m of text.matchAll(/(?:const (\w+) = (?:useCallback\()?)?async \([^)]*\) => \{/g)) {
      let depth = 0, end = -1;
      for (let i = m.index + m[0].length - 1; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) { end = i; break; }
      }
      const b = text.slice(m.index, end);
      const close = b.search(CLOSE);
      const send = b.search(/await (?:api\.|makeDoc|onSave|onSubmit|save\(|props\.on)/);
      if (close >= 0 && send >= 0 && close < send) found.push(`${f.slice(root.length).replace(/\\/g, "/")}:${m[1] ?? "?"}`);
    }
  }
  assert.ok(found.length >= ALLOWED.size, `훑은 것이 이상하다: ${found}`);
  assert.deepEqual(found.filter((k) => !ALLOWED.has(k)), [],
    "창을 닫은 다음에 서버에 보낸다 — 거절되면 적은 것이 사라진다. 받아 준 뒤에 닫을 것");
});

test("새 폴더 창도 받아 준 뒤에 닫는다", () => {
  const b = body("createFolder");
  assert.ok(b.indexOf("setNewFolderOpen(false)") > b.indexOf("await api.noteFolderCreate(path)"));
  assert.match(b, /finally \{\s*creating\.current = false;/);
});

test("회의 문서 지우기는 휴지통으로 간다고 말한다 — 실제보다 겁주지 않는다(디자인 19차)", () => {
  const m = readFileSync(new URL("../src/pages/Meetings.tsx", import.meta.url), "utf8");
  const del = m.slice(m.indexOf("const deleteDoc"), m.indexOf("const deleteDoc") + 600);
  // 주석이 아니라 사용자에게 뜨는 확인 문구만 본다
  const said = del.match(/confirm\(`([^`]*)`\)/)?.[1] ?? "";
  assert.doesNotMatch(said, /되돌릴 수 없습니다/, "meeting_store.delete_doc 은 휴지통으로 옮긴다");
  assert.match(said, /휴지통으로 옮길까요/);
});

test("이동 창은 무엇을 어디서 옮기는지 보이고, 처음엔 지금 폴더라 그냥 누르면 아무 데도 안 간다(디자인 28차)", () => {
  // 처음 고른 것이 '(루트)' 이던 때는 창을 열고 바로 이동을 누르면 문서가 맨 위로 가 버렸다
  assert.equal(src.match(/setMoveTarget\(""\)/g), null, "이동 창이 맨 위(루트)를 고른 채 열린다");
  assert.equal(src.match(/setMoveTarget\(parentDir\((?:child|n)\.path\)\)/g)?.length, 2, "폴더 줄·문서 줄 모두");
  const dlg = src.slice(src.indexOf('title={moveFor?.folder ? "폴더 이동" : "노트 이동"}'), src.indexOf("</Modal>", src.indexOf('title={moveFor?.folder ? "폴더 이동"')));
  assert.match(dlg, /\{fileName\(moveFor\.path\)\}/, "무엇을 옮기는지 안 보인다");
  assert.match(dlg, /disabled=\{!moveFor \|\| moveTarget === parentDir\(moveFor\.path\)\}/);
});
