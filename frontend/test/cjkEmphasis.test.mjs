/**
 * 한글 친화 강조(69차) — 문장부호 바로 뒤에 조사가 붙은 굵게·기울임·취소선이 **두 파서 모두에서** 되는가.
 *
 * 표준(CommonMark) 규칙에서는 `**중요!**라고` 의 닫는 `**` 가 닫히지 않는다(앞이 문장부호면 뒤가
 * 공백·문장부호여야 한다). 한국어에서 가장 흔한 꼴이라 편집기·읽기 보기 모두 `**` 가 그대로 보였다(실측).
 * 편집기(lezer)와 읽기 보기(remark)는 파서가 달라 **같은 입력을 둘 다에 먹여** 결과가 같은지 본다.
 * 영어 문장의 결과는 예전(표준)과 같아야 한다.
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/cjkEmphasis.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parser as base, GFM } from "@lezer/markdown";
import { render } from "./mdPipeline.mjs";

const { cmCjkFriendly } = await import("../src/lib/markdownExtras.ts");
const gfm = base.configure(GFM);
const editor = gfm.configure(cmCjkFriendly(gfm));

const TAG = { StrongEmphasis: "strong", Emphasis: "em", Strikethrough: "del" };

/** 편집기 파서가 강조로 잡은 구간 — [태그, 표시를 뺀 알맹이] */
function editorMarks(text) {
  const out = [];
  editor.parse(text).iterate({
    enter(n) {
      const tag = TAG[n.name];
      if (!tag) return;
      const w = tag === "em" ? 1 : 2;
      out.push([tag, text.slice(n.from + w, n.to - w)]);
    },
  });
  return out;
}

/** 읽기 보기(실제 파이프라인)가 만든 강조 태그 — [태그, 글자] */
function readerMarks(text) {
  const html = render(text);
  return [...html.matchAll(/<(strong|em|del)>([^<]*)<\/\1>/g)].map((m) => [m[1], m[2].replace(/&#x27;/g, "'")]);
}

const CASES = [
  // 한국어 — 문장부호 뒤에 조사(고치기 전에는 편집기·읽기 보기 모두 표시가 그대로 보였다)
  ["**중요!**라고", [["strong", "중요!"]]],
  ["**'인용'**이다", [["strong", "'인용'"]]],
  ["**함수(인자)**를", [["strong", "함수(인자)"]]],
  ["**쉼표,**다음", [["strong", "쉼표,"]]],
  ["*기울임.*이다", [["em", "기울임."]]],
  ["~~취소!~~했다", [["del", "취소!"]]],
  ["**「괄호」**라는", [["strong", "「괄호」"]]],
  ["문장 **(설명)**을 보라", [["strong", "(설명)"]]],
  // 원래 되던 것은 그대로
  ["**굵게**와", [["strong", "굵게"]]],
  ["한**국**어", [["strong", "국"]]],
  // 영어는 표준 그대로 — 바뀌면 안 된다
  ["a **bold** word", [["strong", "bold"]]],
  ["**foo.**bar", []],
  ["foo_bar_baz", []],
  ["2 * 3 * 4", []],
  ["~~gone~~ text", [["del", "gone"]]],
  ["H~2~O", []],
];

for (const [text, want] of CASES) {
  test(`${text} → ${JSON.stringify(want)}`, () => {
    const r = readerMarks(text);
    const e = editorMarks(text);
    assert.deepEqual(r, want, `읽기 보기: ${render(text)}`);
    assert.deepEqual(e, want, "편집기");
  });
}

test("편집기가 이 규칙을 쓴다", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/components/notes/LiveEditor.tsx", import.meta.url), "utf8");
  assert.match(src, /cmCjkFriendly\(markdownLanguage\.parser\)/);
});
