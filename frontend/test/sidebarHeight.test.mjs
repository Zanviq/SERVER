/**
 * 화면이 낮아도 앱이 통째로 밀려 내려가면 안 된다.
 *
 * 왼쪽 아이콘 줄은 항목이 열둘이라 **화면보다 길어질 수 있다.** 그때 높이를
 * 화면에 묶어 두지 않으면 사이드바가 문서를 늘려서, 위쪽 머리글과 화면 전환
 * 단추가 통째로 화면 밖으로 밀려난다.
 *
 * 실측(844×390, 가로로 돌린 휴대폰): 사이드바 524px → 문서 671px 이 되어
 * 영어 학습의 "대화/단어장" 전환을 포함해 단추 여덟 개가 화면 밖에 있었다.
 * 고친 뒤 문서 390px, 화면 밖 단추 0개.
 *
 * **키보드가 올라온 세로 화면도 같은 상황이다** — 이쪽이 훨씬 자주 일어난다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/components/layout/Sidebar.tsx", import.meta.url), "utf8");
const aside = src.slice(src.indexOf("<aside"), src.indexOf("</aside>"));

test("사이드바 높이를 화면에 묶는다", () => {
  const tag = aside.slice(0, aside.indexOf(">"));
  assert.match(tag, /\bh-screen\b/, "높이를 안 묶으면 내용만큼 늘어나 문서를 밀어낸다");
  assert.match(tag, /\boverflow-hidden\b/);
});

test("넘치는 메뉴는 사이드바 안에서 굴린다", () => {
  const nav = aside.slice(aside.indexOf("<nav"), aside.indexOf("</nav>"));
  assert.match(nav, /overflow-y-auto/, "항목이 늘면 스스로 굴러야 한다");
  assert.match(nav, /\bmin-h-0\b/,
    "flex 자식은 min-h-0 없이는 제 내용보다 작아지지 않는다 — overflow 를 줘도 그대로 넘친다");
});

test("모바일 하단 탭바는 그대로 화면에 붙어 있다", () => {
  const bottom = src.slice(src.indexOf("fixed inset-x-0 bottom-0"));
  assert.ok(bottom.length > 0, "작은 화면의 이동 수단은 하단 탭바다");
  assert.match(bottom.slice(0, 200), /sm:hidden/);
});
