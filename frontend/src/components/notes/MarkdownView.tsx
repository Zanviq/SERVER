import { ReactNode, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
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
        remarkPlugins={[remarkGfm, remarkBreaks, remarkHighlight]}
        // 인라인 HTML/SVG 파싱(rehypeRaw) 후 살균(rehypeSanitize, svg 허용 스키마)
        rehypePlugins={[rehypeRaw, [rehypeSanitize, mdSanitizeSchema]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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
                  <span>{hit.title || spec.label}</span>
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
