import { useState } from "react";
import { Sparkles, Search, Loader2, CornerDownRight, FileSearch } from "lucide-react";
import { api, SearchHit } from "../../lib/api";

interface Props {
  onError: (msg: string) => void;
  onJump: (path: string) => void;
}

const SUGGESTIONS = ["작년 계약서 찾아줘", "회의록 정리한 메모", "파이썬 스크립트", "설정 파일"];

export function AIPanel({ onError, onJump }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setHits(null);
    try {
      const r = await api.search(q.trim());
      setHits(r.hits);
    } catch (e) {
      onError(e instanceof Error ? e.message : "검색 실패");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      className="panel animate-fade-up flex flex-col overflow-hidden"
      style={{ animationDelay: "180ms" }}
    >
      <header className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3 sm:px-5">
        <Sparkles size={15} className="shrink-0 text-phosphor" />
        <h2 className="font-display text-sm font-bold uppercase tracking-wider">
          AI File Search
        </h2>
        <span className="label-mono ml-auto">Gemini</span>
      </header>

      <div className="p-4 sm:p-5">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ash-500"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run(query)}
              placeholder="자연어로 파일 찾기…"
              className="w-full rounded-lg border border-white/[0.08] bg-carbon-900 py-2.5 pl-9 pr-3 font-sans text-sm text-ash-100 outline-none placeholder:text-ash-700 focus:border-phosphor/50"
            />
          </div>
          <button
            onClick={() => run(query)}
            disabled={loading || !query.trim()}
            className="btn btn-accent"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            검색
          </button>
        </div>

        {/* Suggestions */}
        {!hits && !loading && (
          <div className="mt-4 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setQuery(s);
                  run(s);
                }}
                className="rounded-full border border-white/[0.07] bg-carbon-700 px-3 py-1.5 font-mono text-[11px] text-ash-300 transition-colors hover:border-phosphor/40 hover:text-phosphor"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Results */}
        {hits && (
          <div className="mt-4 space-y-2">
            {hits.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-ash-500">
                <FileSearch size={26} />
                <span className="label-mono">일치하는 파일 없음</span>
              </div>
            ) : (
              hits.map((h, i) => (
                <button
                  key={h.path}
                  onClick={() => onJump(h.path)}
                  className="group flex w-full animate-fade-up items-start gap-3 rounded-lg border border-white/[0.06] bg-carbon-900/60 p-3 text-left transition-colors hover:border-phosphor/30 hover:bg-carbon-700"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <CornerDownRight size={15} className="mt-0.5 shrink-0 text-phosphor" />
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-ash-100 group-hover:text-phosphor">
                      {h.path}
                    </p>
                    {h.reason && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-ash-500">{h.reason}</p>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}
