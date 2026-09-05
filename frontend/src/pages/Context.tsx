import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Bot, CalendarDays, ChevronDown, ChevronRight, GraduationCap, History, Languages,
  Loader2, MessageSquare, Search, Terminal, User, X, AudioLines,
} from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { ThreePane } from "../components/notes/ThreePane";
import { MarkdownView } from "../components/notes/LazyMarkdownView";
import { api, ChatMessage, ContextHit, ContextSession, ContextSpace } from "../lib/api";
import { toast } from "../store/toast";

/** 스킬 이름 → 사람이 읽는 이름. ChatPanel 과 같은 표를 쓰면 좋지만, 여기서는
 *  모르는 이름이 와도 그대로 보여 주는 편이 감사에 낫다(가리지 않는다). */
const KIND_ICON: Record<string, typeof Bot> = {
  assistant: Bot,
  calendar: CalendarDays,
  english: Languages,
  paper: GraduationCap,
  meeting: AudioLines,
};

function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `${p(d.getHours())}:${p(d.getMinutes())}`
    : `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 지난 대화를 들여다보는 화면.
 *
 * 왼쪽은 화면별 폴더 → 그 안의 세션, 오른쪽은 그 세션의 대화다. 스킬 호출은
 * 접혀 있고 펼치면 **인자와 결과 원문**이 나온다 — 이 화면의 목적은 감사다.
 * "AI 가 내 단어장에 뭘 넣었지"를 사용자가 직접 확인할 수 있어야 한다.
 */
export function Context() {
  const [params, setParams] = useSearchParams();
  const space = params.get("space") ?? "";
  const session = params.get("s") ?? "";

  const [spaces, setSpaces] = useState<ContextSpace[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [sessions, setSessions] = useState<Record<string, ContextSession[]>>({});
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ContextHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const select = useCallback((sp: string, se: string) => {
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      if (sp) n.set("space", sp); else n.delete("space");
      if (se) n.set("s", se); else n.delete("s");
      return n;
    }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    api.contextSpaces()
      .then((r) => setSpaces(r.spaces))
      .catch((e) => { toast.error(e instanceof Error ? e.message : "컨텍스트를 못 받았습니다"); setSpaces([]); });
  }, []);

  const loadSessions = useCallback(async (sp: string) => {
    try {
      const r = await api.contextSessions(sp);
      setSessions((m) => ({ ...m, [sp]: r.sessions }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "세션을 못 받았습니다");
    }
  }, []);

  const toggle = (sp: string) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(sp)) n.delete(sp);
      else { n.add(sp); if (!sessions[sp]) void loadSessions(sp); }
      return n;
    });
  };

  // 주소로 바로 들어온 경우에도 그 폴더는 펼쳐 둔다
  useEffect(() => {
    if (space && !open.has(space)) {
      setOpen((s) => new Set(s).add(space));
      if (!sessions[space]) void loadSessions(space);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space]);

  useEffect(() => {
    if (!space) { setMessages(null); return; }
    let alive = true;
    setLoadingMsgs(true);
    api.contextMessages(space, session)
      .then((r) => { if (alive) setMessages(r.messages); })
      .catch((e) => { if (alive) toast.error(e instanceof Error ? e.message : "대화를 못 받았습니다"); })
      .finally(() => { if (alive) setLoadingMsgs(false); });
    return () => { alive = false; };
  }, [space, session]);

  const runSearch = async () => {
    const query = q.trim();
    if (!query) { setHits(null); return; }
    setSearching(true);
    try {
      setHits((await api.contextSearch(query)).hits);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "검색 실패");
    } finally {
      setSearching(false);
    }
  };

  const current = spaces?.find((s) => s.space === space) ?? null;
  const currentSession = useMemo(
    () => (sessions[space] ?? []).find((s) => s.id === session) ?? null,
    [sessions, space, session],
  );
  const toolCount = useMemo(
    () => (messages ?? []).reduce((n, m) => n + (m.meta?.tools?.length ?? 0), 0),
    [messages],
  );

  return (
    <Shell
      title="컨텍스트"
      actions={
        <span className="badge" title="AI 가 늘 보는 것은 최근 하루치입니다. 그보다 옛날은 AI 가 스킬로 직접 꺼냅니다.">
          최근 1일 자동 · 그 이전은 AI가 검색
        </span>
      }
    >
      <ThreePane storageKey="context.panes.v1" showDetail={!!space} defaultWidth={300} fixedLabel="세션 목록">
        {/* 왼쪽: 화면별 폴더 → 세션 */}
        <div className="card flex h-view-11 flex-col overflow-hidden lg:h-auto">
          <div className="border-b border-line p-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
                placeholder="지난 대화 검색…"
                aria-label="지난 대화 검색"
                className="input h-8 pl-8 pr-7 text-[12.5px]"
              />
              {q && (
                <button onClick={() => { setQ(""); setHits(null); }} aria-label="검색 지우기"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg">
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          <ul className="flex-1 overflow-auto p-1">
            {searching && (
              <li className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-fg-muted" /></li>
            )}
            {hits !== null && !searching && (
              <>
                <li className="px-2 py-1 text-[11px] text-fg-subtle">검색 결과 {hits.length}건</li>
                {hits.map((h) => (
                  <li key={`${h.space}:${h.id}`}>
                    <button type="button" onClick={() => select(h.space, h.session)}
                      className="w-full rounded-md px-2 py-1.5 text-left hover:bg-hovered">
                      <span className="flex items-center gap-1.5 text-[11.5px] text-fg-muted">
                        {h.label} · {fmtTime(h.ts)} · {h.role === "user" ? "나" : "AI"}
                      </span>
                      <span className="mt-0.5 block text-[12.5px] text-fg2">{h.snippet}</span>
                    </button>
                  </li>
                ))}
                {hits.length === 0 && (
                  <li className="px-3 py-6 text-center text-[12.5px] text-fg-muted">찾은 대화가 없습니다.</li>
                )}
                <li className="my-1 border-t border-line" />
              </>
            )}

            {spaces === null ? (
              <li className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-fg-muted" /></li>
            ) : (
              spaces.map((sp) => {
                const Icon = KIND_ICON[sp.kind] ?? Terminal;
                const isOpen = open.has(sp.space);
                const rows = sessions[sp.space];
                return (
                  <li key={sp.space}>
                    <button type="button" onClick={() => toggle(sp.space)} aria-expanded={isOpen}
                      className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[12.5px] ${
                        sp.space === space ? "bg-accent-muted text-accent-fg" : "hover:bg-hovered"}`}>
                      {isOpen ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
                      <Icon size={13} className="shrink-0 text-fg-muted" />
                      <span className="min-w-0 flex-1 truncate font-medium">{sp.label}</span>
                      <span className="shrink-0 text-[11px] text-fg-subtle">{sp.sessions || ""}</span>
                    </button>
                    {isOpen && (
                      <ul className="mb-1">
                        {rows === undefined && (
                          <li className="py-2 pl-7 text-[11.5px] text-fg-subtle">불러오는 중…</li>
                        )}
                        {rows?.length === 0 && (
                          <li className="py-2 pl-7 text-[11.5px] text-fg-subtle">대화가 없습니다</li>
                        )}
                        {rows?.map((se) => (
                          <li key={se.id}>
                            <button type="button" onClick={() => select(sp.space, se.id)}
                              className={`w-full rounded-md py-1.5 pl-7 pr-2 text-left ${
                                sp.space === space && se.id === session ? "bg-accent-muted" : "hover:bg-hovered"}`}>
                              <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                                {fmtTime(se.started_at)}
                                <span className="opacity-70">· {se.messages}턴</span>
                                {se.tools > 0 && <span className="opacity-70">· 스킬 {se.tools}</span>}
                              </span>
                              <span className="mt-0.5 block truncate text-[12px] text-fg2">{se.preview}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })
            )}
          </ul>
        </div>

        {/* 오른쪽: 대화 원문 + 스킬 기록 */}
        <div className="card flex h-view-11 flex-col overflow-hidden lg:h-auto">
          {!space ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-[13px] text-fg-muted">
              <History size={28} className="text-fg-subtle" />
              <p>왼쪽에서 화면과 세션을 고르세요.</p>
              <p className="text-[12px] text-fg-subtle">
                AI 가 무엇을 근거로 답했고 어떤 스킬을 썼는지 그대로 볼 수 있습니다.
              </p>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <MessageSquare size={15} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{current?.label ?? space}</span>
                <span className="shrink-0 text-[11.5px] text-fg-muted">
                  {currentSession ? `${fmtTime(currentSession.started_at)} · ` : ""}
                  {messages?.length ?? 0}턴{toolCount > 0 ? ` · 스킬 ${toolCount}` : ""}
                </span>
                {session && (
                  <button type="button" onClick={() => select(space, "")}
                    className="btn btn-ghost h-7 px-2 text-[11.5px]" title="이 화면의 전체 대화 보기">
                    전체
                  </button>
                )}
              </header>
              <div className="flex-1 space-y-3 overflow-auto p-3">
                {loadingMsgs && (
                  <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-fg-muted" /></div>
                )}
                {!loadingMsgs && messages?.length === 0 && (
                  <p className="py-8 text-center text-[12.5px] text-fg-muted">이 세션에 남은 대화가 없습니다.</p>
                )}
                {messages?.map((m) => <Turn key={m.id} msg={m} />)}
              </div>
            </>
          )}
        </div>
      </ThreePane>
    </Shell>
  );
}

/** 대화 한 턴. 사용자는 오른쪽 말풍선, AI 는 왼쪽 카드(대화 화면과 같은 규칙). */
function Turn({ msg }: { msg: ChatMessage }) {
  const tools = msg.meta?.tools ?? [];
  if (msg.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        {(msg.meta?.selections?.length || msg.meta?.attachments?.length) ? (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-1">
            {msg.meta?.selections?.map((s, i) => (
              <span key={`s${i}`} title={s.text}
                className="max-w-[240px] truncate rounded-full border border-line bg-subtle px-2 py-0.5 text-[11px] text-fg-muted">
                {s.page ? `${s.page}쪽 · ` : ""}{s.text}
              </span>
            ))}
            {msg.meta?.attachments?.map((a, i) => (
              <span key={`a${i}`} className="rounded-full border border-line bg-subtle px-2 py-0.5 text-[11px] text-fg-muted">
                {a.label || "영역 이미지"}
              </span>
            ))}
          </div>
        ) : null}
        <div className="max-w-[80%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-accent px-3.5 py-2 text-[13px] text-accent-contrast">
          {msg.text}
        </div>
        <span className="text-[10.5px] text-fg-subtle">{fmtTime(msg.ts)}</span>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-muted text-accent">
        <Bot size={13} />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {tools.map((t, i) => <ToolRow key={i} tool={t} />)}
        {msg.text && (
          <div className="card px-3.5 py-2">
            <MarkdownView content={msg.text} onWikiClick={() => {}} />
          </div>
        )}
        <span className="text-[10.5px] text-fg-subtle">{fmtTime(msg.ts)}</span>
      </div>
    </div>
  );
}

/** 스킬 한 줄. 접혀 있고 펼치면 인자·결과 원문이 나온다. */
function ToolRow({ tool }: {
  tool: { name: string; ok: boolean; message: string; args?: string; result?: string };
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(tool.args || tool.result);
  return (
    <div className={`rounded-md border text-[11.5px] ${tool.ok ? "border-line" : "border-danger/40"}`}>
      <button type="button" onClick={() => hasDetail && setOpen((v) => !v)} aria-expanded={open}
        className={`flex w-full items-center gap-1.5 px-2 py-1 text-left ${hasDetail ? "hover:bg-hovered" : "cursor-default"}`}>
        {hasDetail
          ? (open ? <ChevronDown size={11} className="shrink-0 text-fg-subtle" /> : <ChevronRight size={11} className="shrink-0 text-fg-subtle" />)
          : <span className="w-[11px] shrink-0" />}
        <span className={`shrink-0 font-mono ${tool.ok ? "text-accent-fg" : "text-danger"}`}>{tool.name}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{tool.message}</span>
        {!tool.ok && <span className="shrink-0 text-[10.5px] text-danger">실패</span>}
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-line px-2 py-1.5">
          {tool.args && <Raw label="인자" text={tool.args} />}
          {tool.result && <Raw label="결과" text={tool.result} />}
        </div>
      )}
    </div>
  );
}

function Raw({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-fg-subtle">{label}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-subtle p-2 font-mono text-[11px] leading-relaxed text-fg2">
        {text}
      </pre>
    </div>
  );
}

/** 사이드바가 쓰는 아이콘(이 화면을 가리키는 것) */
export const ContextIcon = User;
