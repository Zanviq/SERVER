import { ReactNode, useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import { decodeTarget, docLinkTarget, isVaultTarget, type EmbedResolver } from "../../lib/embeds";
import { blockIdOf, endsWithBlockId, findHeading, hrefSection } from "../../lib/headings";
import { stripMarkdownExt } from "../../lib/notePath";
import { transformWiki } from "../../lib/wikiTransform";
import { remarkPlugins } from "../../lib/mdPlugins";
import { CALLOUTS, parseCallout } from "../../lib/callouts";
import { mdSanitizeSchema } from "../../lib/sanitizeSchema";
import { LinkChip } from "../links/LinkChip";
import { useRichPlugins } from "./richPlugins";

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


/**
 * 그려진 글에서 section 이 가리키는 것 — 제목(h1~h6 의 글·id, lib/headings.findHeading) 또는 블록 `^id`(그 글로 끝나는
 * 가장 안쪽 블록: 문단·항목·칸·인용). 편집기(headingJump.sectionLineIn)와 같은 규칙이다.
 */
function sectionElement(root: HTMLElement, section: string): HTMLElement | undefined {
  const block = blockIdOf(section);
  if (block) {
    const hits = [...root.querySelectorAll<HTMLElement>("p, li, td, th, blockquote, dd, h1, h2, h3, h4, h5, h6")]
      .filter((el) => endsWithBlockId(el.textContent ?? "", block));
    return hits.find((el) => !hits.some((o) => o !== el && el.contains(o)));
  }
  const hs = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")];
  return hs[findHeading(hs.map((h) => h.textContent ?? ""), section, hs.map((h) => h.id))];
}

export interface MarkdownViewProps {
  content: string;
  /** `[[제목]]` 을 눌렀을 때. `[[제목#섹션]]` 이면 section, `[[#섹션]]`(이 문서 안)은 title 이 빈다. */
  onWikiClick: (title: string, section?: string | null) => void;
  /** ![[대상]]·상대경로 이미지를 실제 URL로 바꾼다(문서 목록 기준). */
  resolveEmbed?: EmbedResolver;
  /** 표준 링크 `[글](다른 문서.md)` 를 눌렀을 때 — 대상은 적힌 그대로(lib/embeds.docLinkTarget), `#섹션` 은 section.
   *  같은 문서 안 제목(`[차례](#결론)`)은 target 이 빈다. 없으면 onWikiClick(같은 문서 안 앵커는 브라우저 그대로). */
  onDocLink?: (target: string, section: string | null) => void;
  /** 이 제목(섹션)으로 굴린다 — 바뀔 때마다 한 번(n 이 다르면 같은 섹션도 다시). */
  jumpTo?: { section: string; n: number } | null;
  /** jumpTo 를 처리했다 — 그 제목이 있었는가 */
  onJumped?: (found: boolean) => void;
}

export function MarkdownView({
  content,
  onWikiClick,
  resolveEmbed,
  onDocLink,
  jumpTo,
  onJumped,
}: MarkdownViewProps) {
  const rich = useRichPlugins(content);
  const box = useRef<HTMLDivElement>(null);
  const jumped = useRef(onJumped);
  jumped.current = onJumped;
  // 제목(섹션) 링크로 왔다 — 그려진 제목(h1~h6)의 글·id 로 고른다. 편집기와 같은 규칙(lib/headings.findHeading).
  useEffect(() => {
    if (!jumpTo || !box.current) return;
    const el = sectionElement(box.current, jumpTo.section);
    if (el) {
      const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
      el.classList.add("jump-flash");
      window.setTimeout(() => el.classList.remove("jump-flash"), 1600);
    }
    jumped.current?.(!!el);
  }, [jumpTo]);
  return (
    <div ref={box} className="prose-server">
      <ReactMarkdown
        // 마크다운 문법 단계는 시험 파이프라인과 같은 한 목록(lib/mdPlugins — 차례와 까닭은 거기)
        remarkPlugins={remarkPlugins}
        // 인라인 HTML/SVG 파싱(rehypeRaw) 후 살균(rehypeSanitize, svg 허용 스키마).
        // **수식은 살균 뒤에 그린다**(rehypeKatex). 앞에서 그리면 KaTeX 가 만든
        // 수백 개의 class 를 살균이 전부 지워 글자만 남고, 통과시키자니 className
        // 을 통째로 여는 셈이라 위험하다. 뒤에 두면 KaTeX 는 이미 걸러진 수식
        // 문자열만 받고, 그 출력은 KaTeX 가 만든 것이라 믿을 수 있다
        // (trust 기본값 false — \href·\htmlClass 같은 것은 그리지 않는다).
        // rehypeSlug 는 살균 **앞**이라도 되지만, 뒤에 두면 살균이 id 를 지운다.
        // rehypeHighlight 는 살균 뒤다 — 토큰마다 class 를 수백 개 붙이므로 앞에
        // 두면 살균이 전부 걷어내 색이 사라진다(수식과 같은 이유).
        // 수식·코드 칠은 이 글에 있을 때만 불러 와 끼운다(useRichPlugins).
        rehypePlugins={[rehypeRaw, rehypeSlug, [rehypeSanitize, mdSanitizeSchema], ...rich]}
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
            if (isVaultTarget(url)) { // 편집기(eachMdImage)와 같은 기준 — lib/embeds
              const hit = resolveEmbed?.(decodeTarget(url));
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
            // `[note/서버/기록.md]` 같은 항목 링크(transformLinks 가 만든 것)
            if (href?.startsWith("#link/")) {
              return <LinkChip path={decodeTarget(href.slice(6))}>{children}</LinkChip>;
            }
            if (href?.startsWith("#wiki/")) {
              // `#wiki/제목#섹션` — 제목·섹션은 퍼센트로 적혀 있어 `#` 이 섞이지 않는다(wikiTransform)
              const [t, s] = href.slice(6).split("#");
              const title = decodeTarget(t);
              const section = s ? decodeTarget(s) : null;
              return (
                <button
                  onClick={() => onWikiClick(title, section)}
                  className="rounded bg-accent-muted px-1 font-medium text-accent-fg hover:bg-accent-soft"
                >
                  {children}
                </button>
              );
            }
            const { node: _n, className: _c, ...rest } = props as Record<string, unknown>;
            // `[보고서](보고서.md)` 같은 벌트 안 문서 링크는 앱 안에서 연다(79차 — 전엔 새 탭의 모르는 주소 → 첫 화면).
            // 여는 쪽이 없으면(대화·단어장 등) 위키링크처럼 제목으로 넘긴다.
            const doc = docLinkTarget(href);
            if (doc !== null) {
              const section = hrefSection(href!);
              const open = onDocLink ?? ((t: string, s: string | null) => onWikiClick(stripMarkdownExt(t), s));
              return (
                <a {...rest} href={href} onClick={(e) => { e.preventDefault(); open(doc, section); }}
                   className="text-info underline">
                  {children}
                </a>
              );
            }
            // 같은 문서 안 앵커(각주 등)는 새 탭으로 열면 안 된다 — 빈 탭만 뜨고
            // 정작 각주로 이동하지 않는다. 제목 앵커(`[차례](#설치-방법)`)는 문서 화면이면 편집기와 같은 길로
            // 간다(글로도 찾고 칠해 준다 — 브라우저는 id 가 꼭 같아야 가고 주소에 `#…` 를 남긴다). 각주는 브라우저 그대로.
            if (href?.startsWith("#")) {
              const section = hrefSection(href);
              const jump = onDocLink && section && !href.startsWith("#user-content-") ? onDocLink : null;
              return (
                <a {...rest} href={href} className="text-info underline"
                   onClick={jump ? (e) => { e.preventDefault(); jump("", section); } : undefined}>
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
