/**
 * 창을 열 때의 포커스(디자인 21차) — 보려고 여는 창이 휴대폰 자판을 띄우지 않는가.
 *
 * 실측(390px 손가락): 대화 지도를 열면 Modal 이 첫 입력칸('가지 찾기')에 포커스를 두어, 휴대폰에서는 열자마자 자판이
 * 올라와 지도의 반을 가렸다. 이름을 짓는 창(새 노트 등)은 치려고 여는 창이라 전처럼 입력칸에 둔다.
 *
 * 돌리는 법: node --test test/modalFocus.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("Modal 은 창 자체에 포커스를 둘 수 있고, 대화 지도는 그렇게 연다", () => {
  const modal = read("../src/components/ui/Modal.tsx");
  assert.match(modal, /initialFocus = "first"/, "기본은 첫 입력칸(이름 짓는 창)");
  assert.match(modal, /if \(initialFocus === "panel"\) \{\s*panelRef\.current\?\.focus\(\);/);
  assert.match(modal, /tabIndex=\{-1\}/, "창이 포커스를 받을 수 없으면 panel 이 헛돈다");
  const chat = read("../src/components/ai/ChatPanel.tsx");
  const popup = chat.slice(chat.indexOf("const treePopup"), chat.indexOf("</Modal>", chat.indexOf("const treePopup")));
  assert.match(popup, /initialFocus="panel"/, "지도를 열자마자 휴대폰 자판이 뜬다");
});

test("손가락 화면에서 치려고 여는 게 아닌 창은 입력칸에 포커스를 두지 않는다(디자인 22차)", () => {
  // 녹음 창: 제목은 미리 채워져 있고 여는 까닭은 녹음 — 자판이 녹음 단추를 가렸다
  const rec = read("../src/components/meetings/Recorder.tsx");
  assert.match(rec, /title="회의 녹음" width="max-w-md" initialFocus=\{touch \? "panel" : "first"\}/);
  // 있던 일정: 보거나 지우려고 여는 때가 많다. 새 일정은 제목부터 친다
  const ev = read("../src/components/calendar/EventDialog.tsx");
  assert.match(ev, /initialFocus=\{isEdit && touch \? "panel" : "first"\}/);
  assert.match(ev, /<input autoFocus=\{!\(isEdit && touch\)\}/, "제목칸의 autoFocus 가 창의 선택을 이긴다");
});
