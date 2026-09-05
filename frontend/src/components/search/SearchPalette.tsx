import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search, FileText, BookOpen, Mic, Languages, CheckSquare, CalendarDays,
  MessageSquare, Loader2, CornerDownLeft,
} from "lucide-react";
import { api, SearchHit, SearchKind } from "../../lib/api";

/** 검색창을 열어 달라는 신호. 상태 저장소를 새로 만들 만한 일이 아니다. */
export const OPEN_SEARCH = "twoems:open-search";
export const openSearch = () => window.dispatchEvent(new CustomEvent(OPEN_SEARCH));

/** 갈래마다 이름·아이콘·갈 곳. 여기 한 군데만 고치면 전부 따라온다. */
const KIND: Record<SearchKind, { label: string; icon: typeof FileText; href: (h: SearchHit) => string }> = {
  note: { label: "노트", icon: FileText, href: (h) => `/notes?path=${encodeURIComponent(h.id)}` },
  paper: { label: "논문", icon: BookOpen, href: (h) => `/papers?p=${encodeURIComponent(h.id)}` },
  meeting: { label: "회의", icon: Mic, href: (h) => `/meetings?m=${encodeURIComponent(h.id)}` },
  vocab: { label: "단어", icon: Languages, href: (h) => `/english?w=${encodeURIComponent(h.id)}` },
  todo: { label: "할 일", icon: CheckSquare, href: (h) => `/todo?t=${encodeURIComponent(h.id)}` },
  event: { label: "일정", icon: CalendarDays, href: (h) => `/calendar?d=${encodeURIComponent(h.when)}` },
  chat: {
    label: "대화", icon: MessageSquare,
    href: (h) => {
      const [space, session] = h.id.split("|");
      return `/context?space=${encodeURIComponent(space ?? "")}&s=${encodeURIComponent(session ?? "")}`;
    },
  },
};

/** 화면을 가로지르는 검색창. Ctrl/⌘+K 로 열린다.
 *
 *  검색은 화면마다 따로 있었다 — 노트에서는 노트만, 논문에서는 논문만. 무엇을
 *  어디에 넣었는지 먼저 떠올려야 찾을 수 있었다. 여기서는 한 번에 훑고, 고르면
 *  그 화면의 그 자리로 바로 간다.
 */
export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // 전역 단축키. 입력칸 안에서도 열려야 한다(글을 쓰다 문득 찾는 일이 잦다).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    // 단축키가 없는 기기(휴대폰)에서는 사이드바 버튼이 이 신호를 보낸다.
    const onAsk = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH, onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH, onAsk);
    };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
    else { setQuery(""); setHits([]); setCursor(0); }
  }, [open]);

  // 타자마다 서버를 두드리지 않는다. 마지막 응답만 반영한다(늦게 온 옛 답이
  // 새 답을 덮으면 글자와 결과가 어긋난다).
  useEffect(() => {
    const term = query.trim();
    if (!term) { setHits([]); setBusy(false); return; }
    setBusy(true);
    let alive = true;
    const t = setTimeout(() => {
      api.searchAll(term)
        .then((r) => { if (alive) { setHits(r.hits); setCursor(0); } })
        .catch(() => { if (alive) setHits([]); })
        .finally(() => { if (alive) setBusy(false); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  const go = useCallback((h: SearchHit) => {
    setOpen(false);
    navigate(KIND[h.kind].href(h));
  }, [navigate]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, hits.length - 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && hits[cursor]) {
      e.preventDefault();
      go(hits[cursor]);
    }
  };

  // 고른 줄이 화면 밖으로 나가지 않게
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const grouped = useMemo(() => {
    const seen: SearchKind[] = [];
    for (const h of hits) if (!seen.includes(h.kind)) seen.push(h.kind);
    return seen;
  }, [hits]);

  if (!open) return null;

  let row = -1;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-4 pt-[10vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div className="card w-full max-w-2xl overflow-hidden p-0 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4">
          {busy ? <Loader2 size={16} className="animate-spin text-fg-muted" />
                : <Search size={16} className="text-fg-muted" />}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="노트·논문·회의·단어·할 일·일정·대화에서 찾기…"
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-fg-muted"
            aria-label="전체 검색"
          />
          <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[11px] text-fg-muted sm:block">Esc</kbd>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {!query.trim() ? (
            <p className="px-4 py-6 text-center text-[13px] text-fg-muted">
              무엇을 찾을까요? 어느 화면에 넣었는지 몰라도 됩니다.
            </p>
          ) : hits.length === 0 && !busy ? (
            <p className="px-4 py-6 text-center text-[13px] text-fg-muted">
              “{query.trim()}” — 찾은 것이 없습니다.
            </p>
          ) : (
            grouped.map((kind) => (
              <div key={kind}>
                <div className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
                  {KIND[kind].label}
                </div>
                {hits.filter((h) => h.kind === kind).map((h) => {
                  row += 1;
                  const i = row;
                  const Icon = KIND[kind].icon;
                  return (
                    <button
                      key={`${h.kind}:${h.id}:${i}`}
                      data-i={i}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => go(h)}
                      className={`flex w-full items-start gap-3 px-4 py-2 text-left ${
                        i === cursor ? "bg-subtle" : ""}`}
                    >
                      <Icon size={15} className="mt-0.5 shrink-0 text-fg-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px]">{h.title || "(제목 없음)"}</span>
                        {h.snippet && (
                          <span className="block truncate text-[12px] text-fg-muted">{h.snippet}</span>
                        )}
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-[11px] text-fg-muted">
                        {h.when || h.where}
                      </span>
                      {i === cursor && <CornerDownLeft size={13} className="mt-1 shrink-0 text-fg-muted" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
