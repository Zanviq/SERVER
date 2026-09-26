/**
 * 표준 링크 `[글](다른 문서.md)` 로 문서 열기(79차) — 읽기 보기와 편집기가 같은 기준(lib/embeds.docLinkTarget)으로
 * 벌트 안 문서 링크를 가리고, 링크를 적은 문서의 폴더 기준으로 경로를 푸는가(joinVaultPath).
 *
 * 예전엔 읽기 보기가 이런 링크를 모두 바깥 주소로 보고 새 탭에 열어(앱이 모르는 주소 → 첫 화면), 편집기는 Ctrl+클릭에
 * 아무 일도 없었다(실측: 상대·루트·꺾쇠·%20·하위 폴더·확장자 없음 여섯 모양 모두). 읽기 보기 쪽은 **실제 파이프라인이
 * 내놓는 href**(퍼센트로 적힌 것)를 그대로 넣어 본다 — 손으로 적은 href 는 화면이 받는 것과 다를 수 있다.
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/docLinks.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { docLinkTarget, joinVaultPath } from "../src/lib/embeds.ts";
import { linkUrlAt } from "../src/components/notes/mdLinkClick.ts";
import { render } from "./mdPipeline.mjs";

const hrefOf = (md) => {
  const m = render(md).match(/<a href="([^"]*)"/);
  assert.ok(m, `링크가 안 나왔다: ${md}`);
  return m[1].replace(/&#x26;|&amp;/g, "&");
};

test("읽기 보기: 파이프라인이 내놓은 href 에서 벌트 안 문서를 가린다", () => {
  const cases = [
    ["[보고서로](보고서.md)", "보고서.md"],
    ["[공백으로](<내 문서.md>)", "내 문서.md"],
    ["[퍼센트로](내%20문서.md)", "내 문서.md"],
    ["[하위로](아래/깊은.md)", "아래/깊은.md"],
    ["[위로](../다른/글.md)", "../다른/글.md"],
    ["[루트로](/폴더/보고서.md)", "/폴더/보고서.md"],
    ["[이름만](보고서)", "보고서"],
    ["[섹션](보고서.md#결론)", "보고서.md"],
    ["[첨부](자료.pdf)", "자료.pdf"],
  ];
  for (const [md, want] of cases) assert.equal(docLinkTarget(hrefOf(md)), want, md);
  // 바깥 주소·같은 문서 앵커·앱 주소는 문서 링크가 아니다(그대로 새 탭·앵커로)
  for (const md of ["[웹](https://example.com/a.md)", "[메일](mailto:a@b.c)", "[각주](#결론)",
    "[원본](/api/notes/raw?path=a.png)", "[cdn](//cdn.example.com/x.md)",
    // 앱 화면 주소 — 문서로 보면 누르는 순간 `calendar.md` 가 생긴다
    "[달력](/calendar)", "[할 일](/todo)"]) {
    assert.equal(docLinkTarget(hrefOf(md)), null, md);
  }
  // `%` 가 잘못 든 이름도 화면을 깨지 않는다(decodeTarget)
  assert.equal(docLinkTarget("100%.md"), "100%.md");
});

test("경로는 링크를 적은 문서의 폴더 기준 — `/` 는 맨 위, `..` 은 한 칸 위, 밖으로는 못 나간다", () => {
  assert.equal(joinVaultPath("보고서.md", "일/글.md"), "일/보고서.md");
  assert.equal(joinVaultPath("아래/깊은.md", "일/글.md"), "일/아래/깊은.md");
  assert.equal(joinVaultPath("../다른/글.md", "일/안/글.md"), "일/다른/글.md");
  assert.equal(joinVaultPath("./보고서.md", "글.md"), "보고서.md");
  assert.equal(joinVaultPath("/폴더/보고서.md", "일/글.md"), "폴더/보고서.md");
  assert.equal(joinVaultPath("보고서.md", null), "보고서.md");
  assert.equal(joinVaultPath("../../밖.md", "일/글.md"), null);
  assert.equal(joinVaultPath("..", "글.md"), null);
});

test("편집기: 누른 자리의 표준 링크 대상을 구문 나무에서 읽는다(꺾쇠 벗김·그림·코드는 아님)", () => {
  const doc = "가 [보고서](보고서.md) 나 [공백](<내 문서.md>) 다 ![그림](a.png) 라 `[코드](x.md)` 마 [웹](https://e.com)";
  const state = EditorState.create({ doc, extensions: [markdown()] });
  ensureSyntaxTree(state, doc.length, 5000);
  const at = (needle, off = 1) => linkUrlAt(state, doc.indexOf(needle) + off);
  assert.equal(at("[보고서]"), "보고서.md");       // 글자 위
  assert.equal(at("(보고서.md)"), "보고서.md");    // 주소 위
  assert.equal(at("[공백]"), "내 문서.md");
  assert.equal(at("![그림]", 3), null);             // 그림은 링크로 열지 않는다
  assert.equal(at("`[코드]", 2), null);             // 코드 안은 글자다
  assert.equal(at("[웹]"), "https://e.com");        // 주소는 docLinkTarget 이 가른다
  assert.equal(docLinkTarget(at("[웹]")), null);
  assert.equal(at("가 "), null);
});

test("문서 화면이 두 보기에 같은 여는 함수를 넘긴다", () => {
  const notes = readFileSync(new URL("../src/pages/Notes.tsx", import.meta.url), "utf8");
  assert.match(notes, /onDocLink=\{openDocLink\}/, "읽기 보기가 문서 링크를 여는 함수를 못 받는다");
  assert.match(notes, /onOpenLink=\{openDocLink\}/, "편집기가 문서 링크를 여는 함수를 못 받는다");
  const view = readFileSync(new URL("../src/components/notes/MarkdownView.tsx", import.meta.url), "utf8");
  // 문서 링크를 가리는 곳이 새 탭(target=_blank)으로 여는 곳보다 앞이어야 한다
  assert.ok(view.indexOf("docLinkTarget(href)") > 0
    && view.indexOf("docLinkTarget(href)") < view.indexOf('target="_blank"'), "읽기 보기가 문서 링크를 새 탭으로 연다");
});
