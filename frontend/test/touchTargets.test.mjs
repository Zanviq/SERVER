/**
 * 손가락으로 누를 수 있어야 한다.
 *
 * 실측(390px 휴대폰 크기)으로 세 화면을 훑었더니 이런 자리가 나왔다.
 *   회의 받아쓰기의 시각  33×19   ← 녹음을 되감는 **주된 조작**이고 한 회의에 수백 개
 *   회의 목록으로 단추     24×24
 *   화자 이름 칩          58×22
 *   목록 줄 끝 아이콘      24×24 (논문·회의)
 *   좁은 화면 전환 단추    54×27 (영어의 대화/단어장)
 * 권장 최소치는 44×44 이다.
 *
 * 두 가지로 고쳤다.
 *   - 받아쓰기는 **줄 전체**를 눌러 되감게 했다(작은 글자를 정확히 짚을 필요가 없다).
 *   - 작게 보여야 하는 아이콘은 `.tap` 으로 **보이는 크기는 그대로 두고 눌리는
 *     자리만** 44×44 로 넓혔다. 마우스에서는 켜지 않는다 — 넓은 자리가 옆 줄을
 *     가로챌 이유가 없다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test(".tap 은 손가락일 때만, 보이는 크기는 그대로", () => {
  const css = read("../src/index.css");
  const block = css.slice(css.indexOf("@media (pointer: coarse)"));
  assert.match(block, /\.tap::after/, "가짜 요소로 눌리는 자리만 넓힌다");
  assert.match(block, /width: max\(100%, 44px\)/);
  assert.match(block, /height: max\(100%, 44px\)/);
  assert.ok(css.indexOf("@media (pointer: coarse)") > 0, "마우스에서는 켜지지 않아야 한다");
});

test("받아쓰기는 줄 전체가 되감기 단추다", () => {
  const src = read("../src/components/meetings/TranscriptView.tsx");
  const li = src.slice(src.indexOf("<li key={i}>"), src.indexOf("</li>"));
  assert.match(li, /<button[\s\S]*?onSeek\(toSec\(s\.start\)\)/, "줄을 감싸는 단추가 되감는다");
  assert.match(li, /w-full/, "줄 너비를 다 쓴다");
  // 단추 안에 또 단추를 넣으면 안 된다 — 줄에는 되감기 단추 하나뿐이어야 한다
  assert.equal(li.match(/<button/g).length, 1, `줄 안의 단추가 하나가 아니다`);
});

test("작게 남아야 하는 아이콘에는 .tap 이 붙어 있다", () => {
  for (const [file, what] of [
    ["../src/components/papers/PaperList.tsx", "논문 줄 끝 아이콘"],
    ["../src/components/meetings/MeetingList.tsx", "회의 줄 끝 아이콘"],
    ["../src/components/meetings/TranscriptView.tsx", "화자 이름 칩"],
    ["../src/pages/Meetings.tsx", "회의 목록으로"],
  ]) {
    assert.match(read(file), /className=\{?[`"][^`"]*\btap\b/, `${what} 에 .tap 이 없다`);
  }
});

test("좁은 화면의 전환 단추는 넉넉하다", () => {
  const src = read("../src/components/notes/ThreePane.tsx");
  const sw = src.slice(src.indexOf("function MobileSwitch"), src.indexOf("function MobileSwitch") + 1400);
  assert.match(sw, /h-10/, "h-8 이면 테두리 안쪽이 27px 이라 손가락에 작다");
});
