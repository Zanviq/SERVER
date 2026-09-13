/**
 * 대화 지도는 **한 번만 엮는다**.
 *
 * 지도는 두 자리에 나타난다 — 넓은 비서 화면의 오른쪽 칸, 그 밖의 모든 화면에서
 * 단추로 여는 팝업. 두 자리가 각자 `<ConversationTree …>` 를 엮으면, 나중에
 * 기능을 하나 고칠 때 한쪽만 고쳐지고 "팝업에서는 되는데 사이드바에서는 안 된다"가
 * 생긴다. 그릇은 둘이어도 **내용물은 하나**여야 한다.
 *
 * 눈으로 지킬 수 있는 규칙이 아니라서(두 곳은 파일에서 200줄 넘게 떨어져 있다)
 * 여기서 센다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = new URL("../src/", import.meta.url);
const panel = readFileSync(new URL("./components/ai/ChatPanel.tsx", src), "utf8");

/** 주석을 뺀 본문 — 설명 글에 적힌 이름까지 세면 안 된다 */
const code = panel
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

test("<ConversationTree> 를 엮는 자리는 하나뿐이다", () => {
  const used = [...code.matchAll(/<ConversationTree[\s/>]/g)].length;
  assert.equal(used, 1,
    `지도를 ${used}곳에서 엮고 있다 — 그릇은 여럿이어도 엮는 곳은 하나여야 한다`);
});

test("그 하나를 두 그릇이 나눠 쓴다(사이드바 · 팝업)", () => {
  // 엮은 결과를 담아 두는 이름
  assert.match(code, /const tree = space \?/, "엮은 결과를 이름 하나에 담아 둬야 한다");
  // 그 이름을 두 자리에서 쓴다
  const placed = [...code.matchAll(/\{tree\}/g)].length;
  assert.equal(placed, 2, `그릇이 ${placed}개다 — 오른쪽 칸과 팝업 둘이어야 한다`);
});

test("팝업은 배경·Esc·포커스를 스스로 만들지 않고 Modal 에 맡긴다", () => {
  assert.match(code, /<Modal\b[\s\S]{0,400}?\{tree\}/,
    "지도 팝업은 공용 Modal 안에 들어가야 한다(배경 닫기·Esc·포커스 가두기가 거기 있다)");
  assert.ok(!/fixed inset-0/.test(code),
    "ChatPanel 이 제 손으로 배경을 그리면 Modal 의 Esc·포커스 처리를 못 받는다");
});

test("오른쪽 칸이 설 자리가 없을 때만 팝업을 쓴다", () => {
  // 둘이 동시에 뜨면 같은 지도가 화면에 두 벌 보인다
  assert.match(code, /const treePopup = space && !treeAside \?/,
    "오른쪽 칸이 있으면 팝업을 만들지 않아야 한다");
});

test("비서 화면은 폭을 묶지 않는다(좌우 빈 띠가 생기지 않게)", () => {
  const page = readFileSync(new URL("./pages/Assistant.tsx", src), "utf8");
  // `\s` 를 빼면 `useRef<ChatPanelHandle>` 부터 걸린다
  const tag = page.match(/<ChatPanel\s[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(tag, "Assistant 화면에서 <ChatPanel …/> 을 찾지 못했다");
  assert.ok(!/max-w-/.test(tag),
    `폭을 묶으면 화면을 축소했을 때 좌우에 빈 띠가 남는다: ${tag}`);
  assert.match(tag, /w-full/);
});
