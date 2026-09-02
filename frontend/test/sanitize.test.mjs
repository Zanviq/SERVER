/**
 * 읽기 뷰 살균 규칙 회귀 테스트.  실행: npm test  (frontend 폴더에서)
 *
 * 문서 본문은 사용자가 쓴 것만이 아니다 — AI가 웹에서 가져와 붙여 넣기도 하고,
 * 남이 만든 파일을 열기도 한다. 그래서 본문에 든 HTML은 남이 준 것으로 보고
 * 다뤄야 한다. 이 서버는 세션 쿠키가 HttpOnly라 토큰 자체는 못 훔치지만,
 * 스크립트가 한 번 돌면 그 사람 권한으로 API를 그대로 호출할 수 있다
 * (문서 전체 열람·삭제·터미널까지).
 *
 * 통과 목록에 태그를 하나 더 넣는 일은 쉽고 그게 위험한지 눈으로 아는 건
 * 어렵다. 그래서 규칙(lib/sanitizeSchema)에 실제 페이로드를 먹여 확인한다.
 *
 * 앱과 같은 단계를 재현한다: 마크다운 파싱 → HTML 허용 → rehype-raw → 살균.
 * (react-markdown 이 내부에서 하는 것과 같은 순서)
 */
import { bundle } from "./bundle.mjs";

const { mdSanitizeSchema } = await bundle("src/lib/sanitizeSchema.ts");

const { unified } = await import("unified");
const remarkParse = (await import("remark-parse")).default;
const remarkGfm = (await import("remark-gfm")).default;
const remarkRehype = (await import("remark-rehype")).default;
const rehypeRaw = (await import("rehype-raw")).default;
const rehypeSanitize = (await import("rehype-sanitize")).default;

const pipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, mdSanitizeSchema);

function render(md) {
  return pipeline.runSync(pipeline.parse(md));
}

/** 트리를 훑어 태그·속성을 전부 모은다(문자열 매칭보다 정확하다). */
function collect(tree) {
  const tags = [];
  const attrs = [];
  const values = [];
  (function walk(n) {
    if (n.type === "element") {
      tags.push(n.tagName);
      for (const [k, v] of Object.entries(n.properties ?? {})) {
        attrs.push(k);
        values.push(String(Array.isArray(v) ? v.join(" ") : v));
      }
    }
    if (n.type === "raw") values.push(String(n.value)); // 살균 후에도 남았다면 그 자체가 문제
    (n.children ?? []).forEach(walk);
  })(tree);
  return { tags, attrs, values };
}

let fails = 0;
function check(label, ok, extra = "") {
  if (ok) {
    console.log(`  OK   ${label}`);
  } else {
    fails++;
    console.log(`  FAIL ${label}${extra ? "\n       " + extra : ""}`);
  }
}

/** 이 페이로드가 살균을 통과해도 스크립트가 될 수 없는지 확인한다. */
function blocked(label, md, { tag, attr, value } = {}) {
  const { tags, attrs, values } = collect(render(md));
  const hits = [];
  if (tag && tags.includes(tag)) hits.push(`태그 ${tag} 남음`);
  if (attr && attrs.some((a) => a.toLowerCase() === attr.toLowerCase())) hits.push(`속성 ${attr} 남음`);
  // 브라우저는 URL 안의 탭·개행을 **버리고** 해석한다. 그러니 검사도 버리고 봐야
  // 한다 — 안 그러면 `java\nscript:` 같은 값이 그대로 남아도 통과 도장을 찍는다.
  const bare = (v) => [...v].filter((c) => c.charCodeAt(0) > 32).join("");
  if (value && values.some((v) => {
    const want = value.toLowerCase();
    return v.toLowerCase().includes(want) || bare(v).toLowerCase().includes(bare(value).toLowerCase());
  })) {
    hits.push(`값 ${value} 남음`);
  }
  // 무엇을 지정했든, 이벤트 핸들러와 script/style 은 언제나 없어야 한다
  const handler = attrs.find((a) => /^on[a-z]/i.test(a));
  if (handler) hits.push(`이벤트 핸들러 ${handler}`);
  for (const t of ["script", "style", "iframe", "object", "embed", "form", "base", "meta", "link"]) {
    if (tags.includes(t)) hits.push(`위험 태그 ${t}`);
  }
  // `\s*:` 만 보면 안 된다 — 위험한 건 콜론 앞 공백이 아니라 **낱말 속**에 낀
  // 탭·개행(`java\nscript:`)이다. 브라우저가 버리고 읽는 대로 검사한다.
  if (values.some((v) => /javascript:/i.test(bare(v)))) hits.push("javascript: URL");
  check(label, hits.length === 0, hits.join(", "));
}

console.log("살균 — 막아야 하는 것");
blocked("script 태그", "<script>window.__x=1</script>", { tag: "script" });
blocked("script 대소문자", "<ScRiPt>window.__x=1</ScRiPt>", { tag: "script" });
blocked("img onerror", '<img src=x onerror="window.__x=1">');
blocked("body onload", '<body onload="window.__x=1">글</body>');
blocked("svg onload", '<svg onload="window.__x=1"></svg>');
blocked("a javascript:", "[누르기](javascript:window.__x=1)");
blocked("a javascript 대소문자", "[누르기](JaVaScRiPt:alert(1))");
blocked("a javascript 공백/개행", "<a href='java\nscript:alert(1)'>누르기</a>");
blocked("img data: URL", "![](data:text/html;base64,PHNjcmlwdD4x)", { value: "data:" });
blocked("iframe", '<iframe src="https://evil.example"></iframe>', { tag: "iframe" });
blocked("object/embed", '<object data="x"></object><embed src="x">');
blocked("form + formaction", '<form action="https://evil.example"><button formaction="x">보내기</button></form>');
blocked("base 태그", '<base href="https://evil.example/">', { tag: "base" });
blocked("meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example">', { tag: "meta" });
blocked("link stylesheet", '<link rel="stylesheet" href="https://evil.example/x.css">', { tag: "link" });
blocked("style 태그", "<style>body{display:none}</style>", { tag: "style" });
blocked("style 속성", '<p style="position:fixed;inset:0">덮기</p>', { attr: "style" });
blocked("svg foreignObject", '<svg><foreignObject><script>1</script></foreignObject></svg>', { tag: "foreignObject" });
blocked("svg animate href 바꿔치기",
  '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>',
  { tag: "animate" });
blocked("svg set", '<svg><set attributeName="onload" to="alert(1)"/></svg>', { tag: "set" });
blocked("svg script", "<svg><script>window.__x=1</script></svg>", { tag: "script" });
blocked("use xlink:href javascript", '<svg><use xlink:href="javascript:alert(1)"/></svg>');
blocked("use href javascript", '<svg><use href="javascript:alert(1)"/></svg>');
blocked("image href javascript", '<svg><image href="javascript:alert(1)"/></svg>');
blocked("details ontoggle", '<details ontoggle="window.__x=1"><summary>열기</summary>내용</details>');
blocked("mark onmouseover", '<mark onmouseover="window.__x=1">형광펜</mark>');
blocked("텍스트 노드 위장", "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>", { tag: "script" });
blocked("주석 안 스크립트", "<!--><script>window.__x=1</script>-->", { tag: "script" });
blocked("srcdoc", '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>', { attr: "srcdoc" });
blocked("표 안 스크립트", "| 값 |\n| --- |\n| <script>alert(1)</script> |", { tag: "script" });
blocked("코드펜스 안은 텍스트", "```\n<script>alert(1)</script>\n```", { tag: "script" });
blocked("링크 title 이벤트", '<a href="https://x.example" onclick="alert(1)">링크</a>');

console.log("\n덮개 만들기 — class 로도 style 과 같은 일을 할 수 있다");
{
  // 이 앱은 Tailwind 유틸리티가 전역에 깔려 있어 class 하나로 화면을 덮을 수 있다
  const { attrs, values } = collect(render('<div class="fixed inset-0 z-50 bg-white">가짜 화면</div>'));
  check("div 에 class 가 남지 않는다",
    !attrs.some((a) => a.toLowerCase() === "classname"), values.join(" | "));
}
{
  const { values } = collect(render("```python\nprint(1)\n```"));
  check("코드블록 문법 강조 class 는 남는다",
    values.some((v) => v.includes("language-python")), values.join(" | "));
}

console.log("\n각주 — id 와 href 가 맞아야 눌러서 이동한다");
{
  const tree = render("본문[^1]\n\n[^1]: 각주 내용");
  const ids = [];
  const hrefs = [];
  (function walk(n) {
    if (n.type === "element") {
      const p = n.properties ?? {};
      if (p.id) ids.push(String(p.id));
      if (p.href) hrefs.push(String(p.href));
    }
    (n.children ?? []).forEach(walk);
  })(tree);
  check("각주 링크가 실제 id 를 가리킨다",
    hrefs.filter((h) => h.startsWith("#")).every((h) => ids.includes(h.slice(1))),
    true, `id=${ids.join(",")} href=${hrefs.join(",")}`);
}

console.log("\n살균 — 통과해야 하는 것(기능이 죽으면 안 된다)");
function survives(label, md, tag) {
  const { tags } = collect(render(md));
  check(label, tags.includes(tag), `남은 태그: ${tags.join(",")}`);
}
survives("형광펜 mark", "<mark>강조</mark>", "mark");
survives("토글 details", "<details><summary>열기</summary>내용</details>", "details");
survives("토글 summary", "<details><summary>열기</summary>내용</details>", "summary");
survives("인라인 svg", '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>', "svg");
survives("표", "| 이름 | 값 |\n| --- | --- |\n| 가 | 1 |", "table");
survives("체크박스", "- [x] 끝난 일", "input");
survives("코드블록", "```js\nlet a = 1;\n```", "code");
survives("이미지(https)", "![그림](https://example.com/a.png)", "img");
survives("링크(https)", "[링크](https://example.com)", "a");

{
  const { values } = collect(render("![그림](https://example.com/a.png)"));
  check("이미지 src 유지", values.some((v) => v.includes("example.com/a.png")), values.join(" | "));
}
{
  // 위키링크는 앱이 `#wiki/...` 로 바꿔 넣는다 — 살균이 이걸 지우면 링크가 죽는다
  const { values } = collect(render("[제목](#wiki/%EC%A0%9C%EB%AA%A9)"));
  check("위키링크 href 유지", values.some((v) => v.startsWith("#wiki/")), values.join(" | "));
}

console.log(fails === 0 ? "\n모두 통과" : `\n실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
