/**
 * 캘린더의 낱말·단추 이름이 한국어인가(디자인 3차).
 *
 * 실측(390px, 단추 이름 훑기): "Previous 월"·"Next 월"·"This 월"·"월 view", 주 보기의 "all-day". `locale="ko"`
 * 라는 이름만 주고 로케일 묶음을 불러오지 않아 날짜 꼴(Intl)만 한국어였고 FC 의 낱말은 영어였다. 게다가 ko 묶음에도
 * 단추 이름(hint)은 없어 따로 준다. 손가락으로 누른 단추에 FC 기본 :focus 의 굵은 회색 테두리가 남던 것도 여기서 본다.
 *
 * 돌리는 법: node --test test/calendarLabels.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ko from "@fullcalendar/core/locales/ko.js";

const cal = readFileSync(new URL("../src/pages/Calendar.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

test("로케일 묶음을 불러와 넘긴다 — 이름만 주면 FC 의 낱말은 영어로 남는다", () => {
  assert.match(cal, /import koLocale from "@fullcalendar\/core\/locales\/ko";/);
  assert.match(cal, /locale=\{koLocale\}/);
  assert.doesNotMatch(cal, /locale="ko"/, "이름만 주는 꼴이 남아 있다");
  // 그 묶음이 실제로 한국어 낱말을 들고 있다(묶음이 바뀌면 여기서 안다)
  assert.equal(ko.allDayText, "종일");
});

test("ko 묶음에 없는 단추 이름(hint)을 한국어로 준다", () => {
  assert.equal(ko.buttonHints, undefined, "ko 묶음에 hint 가 생겼다면 FC_HINTS 를 다시 볼 것");
  assert.match(cal, /\{\.\.\.FC_HINTS\}/, "FullCalendar 에 hint 를 넘기지 않는다");
  const block = cal.slice(cal.indexOf("const FC_HINTS"), cal.indexOf("};", cal.indexOf("const FC_HINTS")));
  for (const key of ["prev:", "next:", "today:", "viewHint:", "navLinkHint:", "moreLinkHint:", "closeHint:", "timeHint:", "eventHint:"]) {
    assert.ok(block.includes(key), `${key} 가 없다 — 영어 기본값("Previous $0" 등)이 읽힌다`);
  }
  // 읽히는 글자(따옴표·백틱 안, `${…}` 뺀 것)에 영어 낱말이 없다
  const said = (block.replace(/===\s*"[^"]*"/g, "").match(/`[^`]*`|"[^"]*"/g) ?? [])
    .map((s) => s.replace(/\$\{[^}]*\}/g, ""));
  assert.ok(said.length >= 6, `읽히는 글자를 거의 못 찾았다: ${said}`);
  for (const s of said) assert.doesNotMatch(s, /[A-Za-z]{2,}/, `영어 낱말이 섞였다: ${s}`);
});

test("누른 단추에 초점 테두리가 남지 않는다 — 자판으로 올 때만", () => {
  assert.match(css, /\.fc-server \.fc-button:focus \{\s*box-shadow: none !important;/);
  assert.match(css, /\.fc-server \.fc-button:focus-visible \{/);
  // 휴대폰에서 한 글자 단추(월·주·일)가 30px 로 좁지 않게
  const mobile = css.slice(css.indexOf("min-height: 34px;") - 200, css.indexOf("min-height: 34px;") + 200);
  assert.match(mobile, /min-width: 40px;/);
});
