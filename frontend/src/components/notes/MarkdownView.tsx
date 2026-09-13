import { ReactNode, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";
// 코드 색은 앱 테마 변수로 칠한다(index.css 의 .hljs-* 규칙) — 별도 테마 CSS 를
// 가져오면 다크/라이트를 따라오지 못해 어두운 배경에 검은 글씨가 된다.
// 수식 글꼴·자리잡기. **여기서 가져온다** — 이 화면은 지연 로드되므로 수식을
// 쓰지 않는 사람은 이 CSS·폰트를 내려받지 않는다.
import "katex/dist/katex.min.css";
import type { EmbedResolver } from "../../lib/embeds";
import { transformWiki } from "../../lib/wikiTransform";
import { remarkHighlight } from "../../lib/markdownExtras";
import { CALLOUTS, parseCallout } from "../../lib/callouts";
import { mdSanitizeSchema } from "../../lib/sanitizeSchema";

// 코드블록: 뚜렷한 테두리 + 우측 상단 복사 버튼. 버튼은 <pre> 바깥이라 복사 텍스트에 안 섞임.
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const onCopy = () => {
    const text = preRef.current?.innerText ?? "";
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className="group relative my-2">
      <button
        type="button"
        onClick={onCopy}
        title="코드 복사"
        aria-label="코드 복사"
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-line bg-surface/90 px-2 py-1 text-[11px] text-fg-muted opacity-70 backdrop-blur transition-opacity hover:text-fg group-hover:opacity-100"
      >
        {copied ? <><Check size={12} /> 복사됨</> : <><Copy size={12} /> 복사</>}
      </button>
      <pre ref={preRef} className="!my-0">{children}</pre>
    </div>
  );
}

/** `100%.png` 처럼 %가 든 파일명이면 decodeURIComponent가 URIError를 던진다.
 *  여기서 던지면 렌더 도중이라 ErrorBoundary가 앱 전체를 오류 화면으로 바꾼다. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface MarkdownViewProps {
  content: string;
  onWikiClick: (title: string) => void;
  /** ![[대상]]·상대경로 이미지를 실제 URL로 바꾼다(문서 목록 기준). */
  resolveEmbed?: EmbedResolver;
}

export function MarkdownView({
  content,
  onWikiClick,
  resolveEmbed,
}: MarkdownViewProps) {
  return (
    <div className="prose-server">
      <ReactMarkdown
        // 단일 엔터 줄바꿈(remarkBreaks) + GFM(표/체크박스/취소선/자동링크)
        // singleTilde:false — 물결 하나(`H~2~O`)를 취소선으로 보지 않는다. 화학식·
        // 첨자 표기가 통째로 <del> 이 되던 것을 막는다(취소선은 `~~두 개~~` 만).
        remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkBreaks,
                        remarkHighlight, remarkMath]}
        // 인라인 HTML/SVG 파싱(rehypeRaw) 후 살균(rehypeSanitize, svg 허용 스키마).
        // **수식은 살균 뒤에 그린다**(rehypeKatex). 앞에서 그리면 KaTeX 가 만든
        // 수백 개의 class 를 살균이 전부 지워 글자만 남고, 통과시키자니 className
        // 을 통째로 여는 셈이라 위험하다. 뒤에 두면 KaTeX 는 이미 걸러진 수식
        // 문자열만 받고, 그 출력은 KaTeX 가 만든 것이라 믿을 수 있다
        // (trust 기본값 false — \href·\htmlClass 같은 것은 그리지 않는다).
        // rehypeSlug 는 살균 **앞**이라도 되지만, 뒤에 두면 살균이 id 를 지운다.
        // rehypeHighlight 는 살균 뒤다 — 토큰마다 class 를 수백 개 붙이므로 앞에
        // 두면 살균이 전부 걷어내 색이 사라진다(수식과 같은 이유).
        rehypePlugins={[rehypeRaw, rehypeSlug, [rehypeSanitize, mdSanitizeSchema],
                        [rehypeKatex, { throwOnError: false, errorColor: "rgb(var(--danger))" }],
                        [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // 칸이 많은 표가 화면을 옆으로 밀지 않도록 **감싸서** 그 안에서만 흐르게
          // 한다. 표 자체를 스크롤 상자로 만들면(display:block) 너비 100%가 먹히지
          // 않아 좁은 표가 내용만큼 쪼그라든다.
          table: ({ children, ...props }) => {
            const { node: _n, ...rest } = props as Record<string, unknown>;
            return (
              <div className="table-wrap">
                <table {...rest}>{children}</table>
              </div>
            );
          },
          blockquote: ({ children, ...props }) => {
            // `> [!NOTE] 제목` 형태면 콜아웃으로 그린다(GitHub·옵시디언과 같은 표기).
            const hit = parseCallout(children);
            const { node: _n, ...rest } = props as Record<string, unknown>;
            if (!hit) return <blockquote {...rest}>{children}</blockquote>;
            const spec = CALLOUTS[hit.kind];
            return (
              <div className={`callout callout-${hit.kind}`}>
                <div className="callout-head">
                  <span aria-hidden="true">{spec.icon}</span>
                  {/* 제목에 서식(굵게·형광펜·링크)이 있으면 조각으로 온다 —
                      글자만 쓰면 그 서식이 본문으로 새어 나간다. */}
                  <span>{hit.titleRest.length > 0 ? hit.titleRest : spec.label}</span>
                </div>
                {hit.body.length > 0 && <div className="callout-body">{hit.body}</div>}
              </div>
            );
          },
          img({ src, alt, ...props }) {
            // 상대경로(`![](사진.png)`)도 벌트에서 찾아 실제 URL로 바꾼다.
            let url = src ?? "";
            let width: number | undefined;
            const bar = (alt ?? "").lastIndexOf("|");
            if (bar > 0) {
              const w = parseInt((alt ?? "").slice(bar + 1), 10);
              if (Number.isFinite(w) && w > 0) width = w;
            }
            const label = bar > 0 ? (alt ?? "").slice(0, bar) : alt;
            if (url && !/^(https?:|data:|blob:|\/)/.test(url)) {
              const hit = resolveEmbed?.(safeDecode(url));
              if (!hit) {
                return <span className="rounded bg-danger/10 px-1 text-[12px] text-danger">이미지 없음: {url}</span>;
              }
              url = hit.url;
            }
            // node 는 react-markdown 이 넘기는 내부 객체다. 그대로 펼치면 DOM 속성으로
            // 새어 콘솔 경고가 나고, 뒤에 펼치면 위에서 정한 className 까지 덮인다.
            const { node: _n, className: _c, ...rest } = props as Record<string, unknown>;
            return (
              <img
                {...rest}
                src={url}
                alt={label}
                width={width}
                loading="lazy"
                className="my-2 max-w-full rounded-md border border-line"
              />
            );
          },
          a({ href, children, ...props }) {
            if (href?.startsWith("#wiki/")) {
              const title = safeDecode(href.slice(6));
              return (
                <button
                  onClick={() => onWikiClick(title)}
                  className="rounded bg-accent-muted px-1 font-medium text-accent-fg hover:bg-accent-soft"
                >
                  {children}
                </button>
              );
            }
            const { node: _n, className: _c, ...rest } = props as Record<string, unknown>;
            // 같은 문서 안 앵커(각주 등)는 새 탭으로 열면 안 된다 — 빈 탭만 뜨고
            // 정작 각주로 이동하지 않는다.
            if (href?.startsWith("#")) {
              return (
                <a {...rest} href={href} className="text-info underline">
                  {children}
                </a>
              );
            }
            return (
              <a {...rest} href={href} target="_blank" rel="noreferrer" className="text-info underline">
                {children}
              </a>
            );
          },
        }}
      >
        {transformWiki(content, resolveEmbed)}
      </ReactMarkdown>
    </div>
  );
}
