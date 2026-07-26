import { ReactNode, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/** [[제목]] / [[제목|별칭]] → 내부 위키링크 마크다운으로 변환. */
function transformWikilinks(text: string): string {
  return text.replace(/\[\[([^\[\]]+?)\]\]/g, (_m, inner: string) => {
    const [target, alias] = inner.split("|");
    const t = target.split("#")[0].trim();
    return `[${(alias ?? target).trim()}](#wiki/${encodeURIComponent(t)})`;
  });
}

// 인라인 SVG/HTML을 허용하되 script·이벤트 핸들러·위험 프로토콜은 계속 차단(살균).
// foreignObject(임의 HTML 삽입)·xlink:href(프로토콜 필터 우회) 등 위험 요소는 제외.
const SVG_TAGS = [
  "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect",
  "text", "tspan", "defs", "linearGradient", "radialGradient", "stop", "use",
  "marker", "clipPath", "mask", "pattern", "image", "title", "desc", "symbol",
];
// hast는 SVG 속성을 property-information의 camelCase 프로퍼티로 다룬다(하이픈 이름은 매칭 안 됨).
const SVG_ATTRS = [
  "viewBox", "xmlns", "fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin",
  "strokeDasharray", "strokeDashoffset", "strokeOpacity", "fillOpacity", "fillRule",
  "clipRule", "clipPath", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "x2", "y1", "y2",
  "width", "height", "points", "transform", "offset", "stopColor", "stopOpacity",
  "gradientUnits", "gradientTransform", "preserveAspectRatio", "opacity", "textAnchor",
  "fontSize", "fontFamily", "dominantBaseline", "markerEnd", "markerStart", "role",
  "href", // svg <a>/<use> href — 아래 protocols로 javascript: 등 차단
];
const SAFE_PROTOCOLS = defaultSchema.protocols?.href ?? ["http", "https", "mailto", "tel"];
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...SVG_TAGS],
  protocols: {
    ...defaultSchema.protocols,
    href: SAFE_PROTOCOLS,
    xlinkHref: SAFE_PROTOCOLS, // 방어: 혹시 남아도 위험 프로토콜 차단
  },
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", ...SVG_ATTRS],
  },
};

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

export function MarkdownView({
  content,
  onWikiClick,
}: {
  content: string;
  onWikiClick: (title: string) => void;
}) {
  return (
    <div className="prose-server">
      <ReactMarkdown
        // 단일 엔터 줄바꿈(remarkBreaks) + GFM(표/체크박스/취소선/자동링크)
        remarkPlugins={[remarkGfm, remarkBreaks]}
        // 인라인 HTML/SVG 파싱(rehypeRaw) 후 살균(rehypeSanitize, svg 허용 스키마)
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a({ href, children, ...props }) {
            if (href?.startsWith("#wiki/")) {
              const title = decodeURIComponent(href.slice(6));
              return (
                <button
                  onClick={() => onWikiClick(title)}
                  className="rounded bg-accent-muted px-1 font-medium text-accent-fg hover:bg-accent-soft"
                >
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-info underline" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {transformWikilinks(content)}
      </ReactMarkdown>
    </div>
  );
}
