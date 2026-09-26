/**
 * 처음 온 사람이 보는 빈 화면(디자인 20차) — 첫걸음이 바로 보이고, 휴대폰에서 할 수 없는 것을 시키지 않는가.
 *
 * 실측(격리 서버에 새 회원으로 가입·승인해 둘러봄 — 끝나고 지웠다): 문서 화면은 "노트가 없습니다" 한 줄뿐이라 위의 작은
 * 아이콘 둘이 만들기인 줄 알기 어려웠고, 논문 화면은 휴대폰에서도 "PDF를 여기로 끌어다 놓으세요"(끌어 놓기가 없다)였다.
 *
 * 돌리는 법: node --test test/emptyStates.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("빈 문서 화면에서 바로 새 노트를 만들거나 파일을 올린다", () => {
  const src = read("../src/pages/Notes.tsx");
  const empty = src.slice(src.indexOf("notes.length === 0 && folders.length === 0 ? ("), src.indexOf("renderNode(tree, 0)"));
  assert.match(empty, /setNewNoteOpen\(true\)/, "빈 목록에 새 노트 단추가 없다");
  assert.match(empty, /<input type="file" multiple/, "빈 목록에 올리기가 없다");
});

test("논문이 없을 때 손가락 화면에는 끌어 놓기 대신 PDF 단추를 안내한다", () => {
  const src = read("../src/components/papers/PaperList.tsx");
  assert.match(src, /const touch = useTouch\(\);/);
  assert.match(src, /\{touch \? "위의 'PDF' 단추로 논문을 올리세요\." : "PDF를 여기로 끌어다 놓으세요\."\}/);
});
