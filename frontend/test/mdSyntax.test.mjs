/**
 * 마크다운 문법이 **실제로 그려지는가**.
 *
 * 읽기 뷰가 쓰는 플러그인 구성을 그대로 돌려(HTML 로) 확인한다. 규칙을 베껴 적지
 * 않고 진짜 모듈(sanitizeSchema·markdownExtras·wikiTransform)을 부른다 — 베껴
 * 적은 규칙은 원본이 바뀌어도 조용히 통과한다.
 *
 * 돌리는 법:
 *   node --experimental-strip-types --import ./test/tsResolve.mjs --test test/mdSyntax.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { render, has, norm } from "./mdPipeline.mjs";

const src = new URL("../src/", import.meta.url);

test("이 시험의 파이프라인이 화면의 것과 같다", () => {
  // mdPipeline.mjs 가 MarkdownView 와 다른 플러그인을 쓰면 이 파일 전체가 거짓말이 된다
  // 수식·코드 칠은 필요할 때 불러 오는 곳(richPlugins)에 있다 — 둘을 합쳐 본다
  const view = readFileSync(new URL("./components/notes/MarkdownView.tsx", src), "utf8") +
    readFileSync(new URL("./components/notes/richPlugins.ts", src), "utf8");
  const harness = readFileSync(new URL("./mdPipeline.mjs", import.meta.url), "utf8");
  for (const p of ["remarkGfm", "remarkBreaks", "remarkHighlight", "remarkMath",
                   "rehypeRaw", "rehypeSanitize", "rehypeKatex"]) {
    assert.ok(view.includes(p), `MarkdownView 가 ${p} 를 안 쓴다 — 시험 구성을 맞춰라`);
    assert.ok(harness.includes(p), `시험 파이프라인에 ${p} 가 빠졌다`);
  }
});

test("목록 — 대시·별표·더하기·번호", () => {
  for (const mark of ["-", "*", "+"]) {
    const html = render(`${mark} 하나\n${mark} 둘`);
    assert.ok(has(html, "ul"), `${mark} 목록이 <ul> 이 아니다: ${html}`);
    assert.equal((html.match(/<li>/g) ?? []).length, 2, html);
  }
  assert.ok(has(render("1. 하나\n2. 둘"), "ol"));
});

test("목록 — 문단 바로 뒤에 빈 줄 없이 써도 목록이다", () => {
  // 사람들이 가장 많이 쓰는 모양이다. 여기서 깨지면 "- 이 안 된다"가 된다.
  const html = render("설명하는 글\n- 하나\n- 둘");
  assert.ok(has(html, "ul"), html);
  assert.ok(!/<p>설명하는 글<br>- 하나/.test(html), `목록이 문단에 먹혔다: ${html}`);
});

test("목록 — 중첩과 체크박스", () => {
  assert.match(norm(render("- 상위\n  - 하위")), /<ul><li>상위<ul><li>하위<\/li><\/ul><\/li><\/ul>/);
  const task = render("- [ ] 안 함\n- [x] 함");
  assert.ok(/type="checkbox"/.test(task), task);
  assert.ok(/checked/.test(task), task);
});

test("표 — 머리글·정렬·인라인 서식", () => {
  const t = render("| 가 | 나 |\n| --- | --- |\n| 1 | 2 |");
  assert.ok(has(t, "table") && has(t, "thead") && has(t, "tbody"), t);
  assert.match(render("| 가 | 나 |\n|:---|---:|\n| 1 | 2 |"), /align="left"[\s\S]*align="right"/);
  assert.match(render("| 가 |\n| --- |\n| **굵게** |"), /<strong>굵게<\/strong>/);
});

test("구분선 — ---, ***, ___", () => {
  for (const rule of ["---", "***", "___"]) {
    assert.ok(has(render(`위\n\n${rule}\n\n아래`), "hr"), `${rule} 이 <hr> 이 아니다`);
  }
});

test("구분선 — 문단 바로 아래 --- 는 제목이 된다(마크다운 규칙)", () => {
  // CommonMark 의 setext 제목이다. 고치는 것이 아니라 **알고 있어야 하는** 동작이라
  // 여기 못 박아 둔다. 편집기가 사용자에게 이 함정을 알려 줘야 한다.
  assert.ok(has(render("위\n---\n아래"), "h2"));
});

test("제목 — h1..h6", () => {
  const html = render("# 하나\n## 둘\n### 셋\n#### 넷\n##### 다섯\n###### 여섯");
  for (let i = 1; i <= 6; i++) assert.ok(has(html, `h${i}`), `h${i} 없음: ${html}`);
});

test("서식 — 굵게·기울임·취소선·형광펜·인라인 코드", () => {
  assert.match(render("**굵게**"), /<strong>굵게<\/strong>/);
  assert.match(render("*기울임*"), /<em>기울임<\/em>/);
  assert.match(render("~~지움~~"), /<del>지움<\/del>/);
  assert.match(render("==강조=="), /<mark>강조<\/mark>/);
  assert.match(render("`코드`"), /<code>코드<\/code>/);
  // 산문에 섞인 비교 연산자는 형광펜이 아니다
  assert.ok(!/<mark>/.test(render("a == b 이고 c == d")));
});

test("코드블록 — 언어 표시가 남고 색이 입혀진다", () => {
  const html = render("```js\nconst a = 1;\n```");
  assert.match(html, /<code class="[^"]*language-js/, html);
  // 언어를 적었는데 한 가지 색 평문이면 적은 보람이 없다
  assert.match(html, /class="hljs-keyword"/, `문법 강조가 안 된다: ${html}`);
});

test("표 정렬 — :---: 가 align 으로 남는다", () => {
  // CSS 가 text-left 로 덮어써서 어떤 정렬도 왼쪽으로 보이던 적이 있다.
  // 여기서는 속성이 살아 있는지만 보고, CSS 쪽은 mdStyles 가 본다.
  assert.match(render("| 가 |\n|:---:|\n| 1 |"), /<th align="center">/);
  assert.match(render("| 가 |\n|---:|\n| 1 |"), /<td align="right">/);
});

test("제목에 id 가 붙어 문서 안 링크가 닿는다", () => {
  // id 가 없으면 `[가기](#제목)` 이 아무 데도 가지 않는다.
  assert.match(render("# 제목 하나"), /<h1 id="[^"]+">/);
  assert.match(render("### 작은 제목"), /<h3 id="[^"]+">/);
});

test("흔히 쓰는 서식 태그가 살균을 통과한다", () => {
  // 허용 목록에 없으면 **태그만 사라지고 글자는 남아** 설명이 본문에 뒤섞인다.
  const html = render('<u>밑줄</u> <abbr title="설명">약어</abbr> <small>작게</small>');
  for (const tag of ["u", "abbr", "small"]) assert.ok(has(html, tag), `${tag} 가 지워졌다: ${html}`);
  assert.match(html, /title="설명"/, "abbr 설명이 사라졌다");
  const fig = render("<figure><img src='https://a/b.png' alt='x'><figcaption>설명</figcaption></figure>");
  assert.ok(has(fig, "figure") && has(fig, "figcaption"), fig);
});

test("물결 하나는 취소선이 아니다(화학식·첨자)", () => {
  assert.equal(norm(render("H~2~O")), "<p>H~2~O</p>");
  assert.match(render("~~취소~~"), /<del>취소<\/del>/, "물결 둘은 그대로 취소선이어야 한다");
});

test("인용과 콜아웃 표시", () => {
  assert.ok(has(render("> 인용"), "blockquote"));
  // 콜아웃은 화면(React)이 blockquote 를 가로채 그린다. 여기서는 표시가 살아서
  // 첫 문단 맨 앞에 오는지만 본다 — parseCallout 이 그걸 보고 갈래를 정한다.
  assert.match(norm(render("> [!NOTE] 제목\n> 본문")), /<blockquote><p>\[!NOTE\] 제목/);
});

test("링크·이미지·각주", () => {
  assert.match(render("[글](https://example.com)"), /<a href="https:\/\/example.com">글<\/a>/);
  assert.match(render("https://example.com"), /<a href="https:\/\/example.com">/);
  assert.match(render("![대체](https://example.com/a.png)"), /<img src="[^"]+" alt="대체">/);
  const fn = render("본문[^1]\n\n[^1]: 각주");
  assert.ok(/<sup>/.test(fn) && /footnotes/.test(fn), fn);
});

test("수식 — 인라인과 블록", () => {
  assert.match(render("$E = mc^2$"), /class="katex"/);
  const block = render("$$\n\\frac{a}{b}\n$$");
  assert.match(block, /katex-display/, "블록 수식이 가운데 줄로 안 나온다");
});

test("줄바꿈 — 엔터 한 번이 줄바꿈이다", () => {
  assert.match(norm(render("첫 줄\n둘째 줄")), /첫 줄<br>둘째 줄/);
});

test("살균 — 위험한 것은 지우고 쓸 것은 남긴다", () => {
  const evil = render('<script>alert(1)</script><img src=x onerror="alert(1)">');
  assert.ok(!/<script/.test(evil), evil);
  assert.ok(!/onerror/.test(evil), evil);
  // 쓰는 것들은 살아 있어야 한다
  assert.ok(has(render("<b>굵게</b>"), "b"));
  assert.ok(has(render("<details><summary>제목</summary>\n\n본문\n\n</details>"), "details"));
});

test("위키 링크와 임베드", () => {
  const link = render("[[다른 문서]]", { wiki: true });
  assert.match(link, /href="#wiki\/%EB%8B%A4%EB%A5%B8%20%EB%AC%B8%EC%84%9C"/, link);
  // 코드 안의 [[ ]] 는 건드리지 않는다
  assert.match(render("`[[그대로]]`", { wiki: true }), /<code>\[\[그대로\]\]<\/code>/);
});
