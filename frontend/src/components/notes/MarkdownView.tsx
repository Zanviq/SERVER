import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** [[제목]] / [[제목|별칭]] → 내부 위키링크 마크다운으로 변환. */
function transformWikilinks(text: string): string {
  return text.replace(/\[\[([^\[\]]+?)\]\]/g, (_m, inner: string) => {
    const [target, alias] = inner.split("|");
    const t = target.split("#")[0].trim();
    return `[${(alias ?? target).trim()}](#wiki/${encodeURIComponent(t)})`;
  });
}

export function MarkdownView({
  content,
  onWikiClick,
}: {
  content: string;
  onWikiClick: (title: string) => void;
}) {
  return (
    <div className="prose-twoems">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
