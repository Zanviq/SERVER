/**
 * 읽기 뷰가 실제로 쓰는 **그 파이프라인**을 화면 없이 돌린다.
 *
 * MarkdownView.tsx 는 CSS 를 가져오므로 노드에서 그대로 못 부른다. 대신 플러그인
 * 구성을 그대로 옮겨 HTML 을 뽑는다 — 문법이 되는지 안 되는지는 여기서 판가름 난다
 * (리액트 components 로 바꿔 그리는 부분은 태그 모양만 다르고 파싱은 같다).
 *
 * 구성이 어긋나면 이 파일이 거짓말을 하므로, mdSyntax.test.mjs 가 MarkdownView.tsx
 * 의 플러그인 목록과 여기 목록이 같은지 대조한다.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";
import rehypeStringify from "rehype-stringify";

const { remarkHighlight, remarkCjkPlugins } = await import("../src/lib/markdownExtras.ts");
const { mdSanitizeSchema } = await import("../src/lib/sanitizeSchema.ts");
const { transformWiki } = await import("../src/lib/wikiTransform.ts");

/** MarkdownView 와 같은 차례로 엮는다. */
export function render(md, { wiki = false, resolve } = {}) {
  const proc = unified()
    .use(remarkParse)
    .use(remarkGfm, { singleTilde: false });
  for (const p of remarkCjkPlugins) proc.use(...(Array.isArray(p) ? p : [p]));
  proc
    .use(remarkBreaks)
    .use(remarkHighlight)
    .use(remarkMath)
    // react-markdown 은 raw HTML 을 살리려고 allowDangerousHtml 로 넘긴다
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    .use(rehypeSanitize, mdSanitizeSchema)
    .use(rehypeKatex, { throwOnError: false })
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(rehypeStringify, { allowDangerousHtml: true });
  return String(proc.processSync(wiki ? transformWiki(md, resolve) : md));
}

/** 태그가 실제로 나왔는가(속성이 붙어도 잡히게). */
export function has(html, tag) {
  return new RegExp(`<${tag}[\\s>]`).test(html);
}

/**
 * 줄바꿈을 걷어낸다 — 모양을 비교할 때 공백까지 따질 이유가 없다.
 *
 * 출력의 `\n` 은 블록 사이를 보기 좋게 띄운 것일 뿐이다. 글 안의 진짜 줄바꿈은
 * `<br>` 로 나오므로 이렇게 지워도 뜻이 바뀌지 않는다.
 */
export function norm(html) {
  return html.replace(/\n/g, "").trim();
}
