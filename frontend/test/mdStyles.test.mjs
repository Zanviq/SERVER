/**
 * 렌더러가 내놓는 태그·클래스에 **전부 스타일이 있는가**.
 *
 * 문법이 파싱되는 것과 화면에 제대로 보이는 것은 다른 문제다. 실제로 h4~h6 은
 * 파싱은 됐지만 `.prose-server` 에 규칙이 없어 본문과 똑같이 보였고, 할 일 목록은
 * 체크박스 옆에 글머리 점이 하나 더 찍혔다. 눈으로만 보면 놓친다.
 *
 * 그래서 문법 표본을 **실제로 렌더링해** 나온 태그·클래스를 모으고, index.css 에
 * 그 이름을 다루는 규칙이 있는지 대조한다. 새 문법을 켜면 여기서 먼저 걸린다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { render } from "./mdPipeline.mjs";

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

/** 화면에 나올 수 있는 것을 되도록 넓게 적는다. */
const SAMPLES = [
  "# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6",
  "- 하나\n- 둘\n  - 중첩\n    - 더 중첩",
  "1. 하나\n2. 둘\n   1. 중첩",
  "- [ ] 안 함\n- [x] 함",
  "| 가 | 나 |\n| --- | --- |\n| 1 | 2 |",
  "---",
  "> 인용",
  "**굵게** *기울임* ~~취소~~ ==형광== `코드`",
  "```js\na\n```",
  "[링크](https://a.b) ![그림](https://a.b/c.png)",
  "본문[^1]\n\n[^1]: 각주",
  "<kbd>Ctrl</kbd> x<sup>2</sup> H<sub>2</sub>O",
  "<dl><dt>용어</dt><dd>뜻</dd></dl>",
  "<details><summary>제목</summary>\n\n본문\n\n</details>",
];

/** 스타일이 굳이 필요 없는 것들 — 브라우저 기본으로 충분하거나 부모가 책임진다. */
const NO_STYLE_NEEDED = new Set([
  "p", "strong", "em", "b", "i", "br", "span", "div", "input",
  "thead", "tbody", "tr", "section", "h2", "annotation", "semantics",
  // 수식은 KaTeX 제 CSS 가 꾸민다(katex.min.css 를 MarkdownView 가 가져온다)
  "math", "mrow", "mi", "mo", "mn", "msup", "mfrac", "svg", "path",
]);

function tagsIn(html) {
  return new Set([...html.matchAll(/<([a-z][a-z0-9]*)[\s>]/gi)].map((m) => m[1].toLowerCase()));
}

test("렌더러가 내놓는 모든 태그에 .prose-server 규칙이 있다", () => {
  const seen = new Set();
  for (const md of SAMPLES) for (const t of tagsIn(render(md))) seen.add(t);
  assert.ok(seen.size > 15, `표본이 너무 적다(${seen.size}) — SAMPLES 를 확인해라`);

  const missing = [...seen]
    .filter((t) => !NO_STYLE_NEEDED.has(t))
    .filter((t) => !new RegExp(`\\.prose-server[^{]*\\b${t}\\b`).test(css));
  assert.deepEqual(missing, [],
    "이 태그들은 스타일 없이 본문과 똑같이 보인다 — .prose-server 에 규칙을 더해라");
});

test("할 일 목록·각주가 쓰는 클래스에 규칙이 있다", () => {
  // 이 이름들은 remark-gfm 이 붙이고 살균을 통과한다. 규칙이 없으면
  // 체크박스 옆에 글머리 점이 하나 더 찍히고, 각주 목록이 본문처럼 보인다.
  for (const cls of ["contains-task-list", "task-list-item", "footnotes", "sr-only"]) {
    const html = SAMPLES.map((s) => render(s)).join("");
    assert.ok(html.includes(cls), `표본에서 ${cls} 가 안 나온다 — 시험이 무의미하다`);
    assert.ok(css.includes(cls), `.prose-server 에 ${cls} 규칙이 없다`);
  }
});

test("체크박스와 보통 항목이 섞인 목록에서 보통 항목의 점이 사라지지 않는다 — 67차", () => {
  // GFM 은 체크박스 항목이 하나라도 있으면 목록 전체에 contains-task-list 를 붙인다. 그 목록에서
  // 점을 빼면 섞인 `- 글머리` 까지 점이 사라진다. 점은 체크박스 항목(task-list-item)에서만 뺀다.
  const html = render("- [ ] 할 일\n- 글머리");
  assert.match(html, /<ul class="contains-task-list">/);
  assert.match(html, /<li>글머리<\/li>/, "보통 항목에 task-list-item 이 붙었다 — 표본이 무의미하다");
  const rule = (sel) => css.match(new RegExp(`\\.prose-server ${sel.replace(".", "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";
  assert.doesNotMatch(rule("ul.contains-task-list"), /list-none/, "목록 전체의 점을 뺀다");
  assert.match(rule("li.task-list-item"), /list-none/, "체크박스 항목의 점을 빼지 않는다");
});

test("표는 감싸는 칸이 가로 넘침을 맡는다", () => {
  // 표 자체를 block 스크롤로 만들면 너비 100%가 안 먹혀 좁은 표가 쪼그라든다.
  const view = readFileSync(
    new URL("../src/components/notes/MarkdownView.tsx", import.meta.url), "utf8");
  assert.match(view, /table-wrap/, "표를 감싸는 칸이 없다");
  assert.match(css, /\.prose-server \.table-wrap[\s\S]{0,120}overflow-x-auto/,
    "감싸는 칸이 가로로 흐르지 않는다");
  assert.ok(!/\.prose-server table \{[^}]*\bblock\b/.test(css),
    "표를 block 으로 만들면 너비 100%가 먹히지 않는다");
});

test("표 정렬을 CSS 가 덮어쓰지 않는다", () => {
  // `|:---:|` 로 준 정렬은 HTML align 힌트인데, author 규칙(text-left)이 항상
  // 이긴다. 기본 왼쪽 정렬은 align 이 **없는** 칸에만 걸어야 한다.
  assert.match(css, /th:not\(\[align\]\)/, "align 있는 칸까지 왼쪽으로 밀고 있다");
  assert.ok(!/\.prose-server th,\s*\.prose-server td \{[^}]*text-left/.test(css),
    "th,td 에 무조건 text-left 를 걸면 정렬이 전부 왼쪽이 된다");
});

test("코드 강조 색이 앱 테마 변수로 칠해진다", () => {
  // highlight.js 테마 CSS 를 가져오면 다크/라이트를 못 따라와 어두운 배경에
  // 검은 글씨가 된다. 우리 변수로 칠하고 있는지 본다.
  assert.match(css, /\.hljs-keyword/, "코드 강조 색 규칙이 없다");
  assert.match(css, /\.prose-server \.hljs-comment[\s\S]{0,160}var\(--/, "테마 변수를 안 쓴다");
});

test("편집기 라이브 프리뷰가 쓰는 클래스에 스타일이 있다", () => {
  // 편집기는 제 테마를 LiveEditor 안에 들고 있다. 장식만 붙이고 스타일을
  // 빠뜨리면 `-` 가 그냥 사라져 글이 왼쪽으로 밀린다.
  const editor = readFileSync(
    new URL("../src/components/notes/LiveEditor.tsx", import.meta.url), "utf8");
  const used = [...editor.matchAll(/"(cm-md[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 0, "편집기 장식 클래스를 못 찾았다");
  for (const cls of new Set(used)) {
    assert.match(editor, new RegExp(`"\\.${cls}"`), `${cls} 에 테마 규칙이 없다`);
  }
});

test("강조색 말풍선 안의 코드 칠은 글자색을 따른다 — 51차", () => {
  // 코드 칠의 예약어 색(--accent)이 말풍선 바탕과 같아 `const` 가 보이지 않았다(대비 1.0)
  assert.match(css, /\.md-on-accent \.prose-server pre \[class\*="hljs-"\] \{\s*color: inherit;/);
  // 보통 바탕의 칠은 그대로 — 말풍선 밖(AI 답)은 색으로 가른다
  assert.match(css, /\.prose-server \.hljs-keyword,[\s\S]{0,120}color: rgb\(var\(--accent\)\)/);
});