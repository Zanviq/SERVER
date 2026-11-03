/**
 * 제목(섹션) 링크 — `[[문서#섹션]]`·`[[#섹션]]`·`[글](문서.md#섹션)`·`[글](#섹션)` 이 그 제목으로 간다(lib/headings).
 *
 * 예전엔 `#섹션` 을 떼고 문서만 열었고(79차에 남긴 것), 읽기 보기의 `[[#섹션]]` 은 제목 없는 위키링크라 누르면 맨 위에
 * 이름 없는 `.md` 문서를 만들었다. 편집기와 읽기 보기가 각자 제목 목록을 뽑으므로, 둘이 같은 제목을 같은 글로 보는지와
 * 이름표가 **실제 파이프라인(rehype-slug)의 id** 와 같은지를 여기서 맞대어 본다 — 손으로 적은 기대값은 화면과 다를 수 있다.
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/headings.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { findHeading, headingText, hrefSection, slugsOf, splitSection } from "../src/lib/headings.ts";
import { headingsIn } from "../src/components/notes/headingJump.ts";
import { linkDecorations } from "../src/components/links/cmLinkDeco.ts";
import { wikiHref } from "../src/lib/notePath.ts";
import { transformWiki } from "../src/lib/wikiTransform.ts";
import { render } from "./mdPipeline.mjs";

/** 읽기 보기가 그린 제목들 — [id, 보이는 글] (태그를 걷어낸 글은 textContent 와 같다) */
function rendered(md, wiki = false) {
  const html = render(md, { wiki });
  return [...html.matchAll(/<h[1-6] id="([^"]*)">([\s\S]*?)<\/h[1-6]>/g)].map((m) => [
    m[1],
    m[2].replace(/<[^>]+>/g, "").replace(/&#x26;|&amp;/g, "&").replace(/&#x3C;|&lt;/g, "<"),
  ]);
}

test("섹션 떼기: 하위 제목 사슬은 마지막 조각, 블록 참조는 섹션이 아니다", () => {
  assert.deepEqual(splitSection("문서#결론"), { doc: "문서", section: "결론" });
  assert.deepEqual(splitSection("#결론"), { doc: "", section: "결론" });
  assert.deepEqual(splitSection("문서#가#나"), { doc: "문서", section: "나" });
  assert.deepEqual(splitSection("문서#^abc12"), { doc: "문서", section: null });
  assert.deepEqual(splitSection("문서"), { doc: "문서", section: null });
  assert.deepEqual(splitSection("문서#"), { doc: "문서", section: null });
  assert.equal(hrefSection("보고서.md#%EA%B2%B0%EB%A1%A0"), "결론");
  assert.equal(hrefSection("#설치-방법"), "설치-방법");
  assert.equal(hrefSection("보고서.md"), null);
  assert.equal(hrefSection("보고서.md#"), null);
});

test("이름표가 읽기 보기의 실제 id(rehype-slug)와 같다 — 같은 제목 둘째의 -1 까지", () => {
  const titles = ["설치 방법", "Setup Guide (Windows)", "1. 개요", "C# & .NET", "질문?", "같은 제목", "같은 제목",
                  "이모지 🎉 끝", "a_b-c", "Ünïcödé 쉼표, 마침표.", "같은 제목"];
  const got = rendered(titles.map((t) => `## ${t}`).join("\n\n"));
  assert.equal(got.length, titles.length);
  assert.deepEqual(slugsOf(got.map(([, text]) => text)), got.map(([id]) => id));
});

test("편집기가 원문 제목에서 뽑은 글이 읽기 보기가 그린 글과 같다", () => {
  const lines = ["## **굵게** 제목", "## [링크](a.md) 뒤", "## [[메모|별칭]] 정리", "## [[메모#가]] 원문",
                 "## `코드` 설명", "## 닫는 표시 ##", "## 1. 개요", "## ~~취소~~ 됨", "## *기울임* 과 _밑줄_",
                 "## C# 언어", "## 탈출 \\*별\\*", "### 깊은 <kbd>Ctrl</kbd> 키"];
  const got = rendered(lines.join("\n\n"), true).map(([, text]) => text);
  assert.deepEqual(lines.map(headingText), got);
});

test("고르기: 글이 같은 것 → 이름표 → 띄어쓰기·문장부호 뺀 것, 없으면 -1", () => {
  const hs = ["개요", "설치 방법", "1단계: 준비", "같은 제목", "같은 제목", "Setup Guide"];
  assert.equal(findHeading(hs, "설치 방법"), 1);           // [[문서#설치 방법]]
  assert.equal(findHeading(hs, "설치-방법"), 1);           // 문서.md#설치-방법
  assert.equal(findHeading(hs, "setup guide"), 5);         // 대소문자
  assert.equal(findHeading(hs, "같은-제목-1"), 4);          // 같은 제목 둘째
  assert.equal(findHeading(hs, "같은 제목"), 3);            // 글로는 첫째
  assert.equal(findHeading(hs, "1단계 준비"), 2);           // 옵시디언은 `:` 를 빼고 적는다
  assert.equal(findHeading(hs, "없는 제목"), -1);
  assert.equal(findHeading(hs, "  "), -1);
  // 그려진 id 를 함께 주면 그것도 본다(읽기 보기)
  assert.equal(findHeading(["가"], "user-given", ["user-given"]), 0);
});

test("편집기 제목 목록: 구문 나무로 — 코드 안의 `#` 은 제목이 아니고, 밑줄 제목도 센다", () => {
  const doc = [
    "# 첫 제목", "", "```python", "# 주석이지 제목이 아니다", "```", "",
    "밑줄 제목", "=====", "", "    # 들여쓴 코드", "", "## **둘째** 제목 ##", "본문 #태그",
  ].join("\n");
  const state = EditorState.create({ doc, extensions: [markdown()] });
  const hs = headingsIn(state);
  assert.deepEqual(hs.map((h) => h.text), ["첫 제목", "밑줄 제목", "둘째 제목"]);
  for (const h of hs) assert.equal(state.doc.lineAt(h.from).from, h.from, "제목 줄의 시작이어야 한다");
  assert.equal(doc.slice(hs[2].from).split("\n")[0], "## **둘째** 제목 ##");
});

test("읽기 보기: `[[문서#섹션]]` 은 섹션을 싣고, `[[#섹션]]` 은 이 문서, 갈 곳 없는 `[[#]]` 은 글자 그대로", () => {
  const href = (md) => transformWiki(md).match(/\]\((#wiki\/[^)]*)\)/)?.[1] ?? null;
  assert.equal(href("[[설치 안내#2단계 설정]]"),
               `#wiki/${encodeURIComponent("설치 안내")}#${encodeURIComponent("2단계 설정")}`);
  assert.equal(href("[[#결론]]"), `#wiki/#${encodeURIComponent("결론")}`);
  assert.equal(href("[[문서#^abc]]"), `#wiki/${encodeURIComponent("문서")}`);
  assert.equal(href("[[문서]]"), `#wiki/${encodeURIComponent("문서")}`);
  // 갈 곳이 없는 것은 적은 글자 그대로 — 예전엔 빈 제목 링크가 되어 누르면 `.md` 문서를 만들었다
  assert.equal(transformWiki("[[#]]"), "[[#]]");
  // 보이는 글은 적은 그대로(별칭이 있으면 별칭)
  assert.match(transformWiki("[[문서#결론|맺음]]"), /^\[맺음\]\(#wiki\//);
  assert.match(transformWiki("[[문서#결론]]"), /^\[문서#결론\]\(#wiki\//);
});

test("편집기: `[[#섹션]]` 도 칩이 되고 누르면 (빈 제목, 섹션)을 넘긴다", () => {
  const doc = "첫 줄\n[[#결론]] 과 [[설치#2단계]] 그리고 [[#]]\n끝";
  const state = EditorState.create({ doc, extensions: [markdown()], selection: EditorSelection.cursor(0) });
  const opened = [];
  const set = linkDecorations(state, [{ from: 0, to: doc.length }], {
    item: () => {},
    wiki: (t, s) => opened.push([t, s]),
  });
  const chips = [];
  set.between(0, doc.length, (from, to, d) => {
    if (d.spec.widget) chips.push({ text: doc.slice(from, to), w: d.spec.widget });
  });
  assert.deepEqual(chips.map((c) => c.text), ["[[#결론]]", "[[설치#2단계]]"]);
  for (const c of chips) c.w.go();
  assert.deepEqual(opened, [["", "결론"], ["설치", "2단계"]]);
  assert.match(chips[0].w.tip, /이 문서 › 결론/);
});

test("문서 화면 밖(대화·단어 카드)의 위키링크 주소 — 섹션을 싣고, 제목이 없으면 가지 않는다", () => {
  assert.equal(wikiHref("회의록"), `/notes?open=${encodeURIComponent("회의록")}&create=0`);
  assert.equal(wikiHref("회의록", "결정 사항"),
               `/notes?open=${encodeURIComponent("회의록")}&create=0&section=${encodeURIComponent("결정 사항")}`);
  assert.equal(wikiHref("", "결론"), null);
  assert.equal(wikiHref("  "), null);
});
