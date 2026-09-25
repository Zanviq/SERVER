/**
 * 마크다운 보기는 수식(KaTeX)·코드 칠(highlight.js)을 **그것이 있는 글에서만** 불러 온다(35차).
 *
 * 늘 싣던 때 MarkdownView 조각은 780KB(gzip 239KB) — 말풍선 하나를 그려도 전부 해석·실행했다.
 * 지금 349KB. 실측(운영 번들, CPU 4배 느림): 대화 화면 첫 말풍선 2037ms → 1758ms(아예 뺀 실험
 * 1752ms 와 같다). 다시 맨 위에서 가져오면 그 값이 되돌아온다.
 *
 * 돌리는 법: node --test test/lazyMarkdown.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const view = readFileSync(new URL("../src/components/notes/MarkdownView.tsx", import.meta.url), "utf8");
const src = readFileSync(new URL("../src/components/notes/richPlugins.ts", import.meta.url), "utf8");

test("무거운 플러그인을 맨 위에서 가져오지 않는다", () => {
  for (const mod of ["rehype-katex", "rehype-highlight", "katex/dist/katex.min.css"]) {
    assert.ok(!new RegExp(`^import[^\\n]*["']${mod.replace(/[./]/g, "\\$&")}["']`, "m").test(src),
      `${mod} 를 맨 위에서 가져온다 — 모든 말풍선이 그 값을 치른다`);
    assert.ok(!view.includes(`"${mod}"`), `MarkdownView 가 ${mod} 를 직접 가져온다`);
    assert.ok(src.includes(`import("${mod}")`), `${mod} 를 필요할 때 불러 오지 않는다`);
  }
});

test("수식·코드 울타리를 알아본다(필요한 글에서는 불러 온다)", () => {
  const math = new RegExp(src.match(/const MATH_HINT = \/(.+)\/;/)[1]);
  const code = new RegExp(src.match(/const CODE_HINT = \/(.+)\/;/)[1]);
  assert.ok(math.test("넓이는 $x^2$ 이다") && math.test("\\(a+b\\)") && math.test("\\[\\int f\\]"));
  assert.ok(!math.test("그냥 글"));
  assert.ok(code.test("앞말\n```js\nconst a = 1;\n```") && code.test("~~~\n코드\n~~~") && code.test("```\nx\n```"));
  assert.ok(!code.test("`한 줄 코드` 는 칠하지 않는다"), "인라인 코드만 있는 글까지 불러 온다");
  // 살균 뒤에 끼운다(앞에 두면 살균이 KaTeX·칠의 class 를 모두 걷어 낸다)
  assert.match(view, /\[rehypeSanitize, mdSanitizeSchema\], \.\.\.rich\]/);
  assert.match(view, /const rich = useRichPlugins\(content\);/);
});
