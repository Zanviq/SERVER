import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, FilePlus, Save, Trash2, History, Loader2, Search, X, RotateCcw,
  ScrollText, AlertTriangle, Sparkles, FolderOpen,
} from "lucide-react";
import { MarkdownView } from "./MarkdownView";
import { Modal } from "../ui/Modal";
import {
  api, ApiError, AidocMeta, AidocDetail, AidocVersion, AidocAuditLog,
  AidocSearchHit, AidocConflict,
} from "../../lib/api";
import { toast } from "../../store/toast";

const INBOX = "__inbox__"; // 프로젝트 미지정(inbox) 필터 값

function fmt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("ko-KR", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/** AI 문서(aidoc) 작업 공간 — 노트 페이지에서 문서 API 경유로 열람·편집.
 *  버전 표시, 낙관적 잠금(409) 충돌 처리, 이력/복원, 휴지통, 감사 로그. */
export function AidocWorkspace() {
  const [docs, setDocs] = useState<AidocMeta[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<string>(""); // "" 전체
  const [showTrash, setShowTrash] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<AidocSearchHit[] | null>(null);
  const searchTimer = useRef<number | null>(null);

  const [current, setCurrent] = useState<AidocDetail | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<number | null>(null); // 최신 버전(충돌 시)

  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newProject, setNewProject] = useState<string>(""); // "" = inbox
  const [delId, setDelId] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<AidocVersion[] | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [audit, setAudit] = useState<AidocAuditLog[] | null>(null);

  const reload = useCallback(async () => {
    try {
      const opts: { project?: string; include_trashed?: boolean } = { include_trashed: showTrash };
      if (projectFilter && projectFilter !== INBOX) opts.project = projectFilter;
      let list = await api.aidocList(opts);
      if (showTrash) list = list.filter((d) => d.trashed);
      if (projectFilter === INBOX) list = list.filter((d) => d.project === null);
      setDocs(list);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "문서 목록 실패");
    }
  }, [projectFilter, showTrash]);

  useEffect(() => {
    api.aidocProjects().then(setProjects).catch(() => setProjects([]));
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const open = useCallback(async (id: string) => {
    try {
      const d = await api.aidocGet(id);
      setCurrent(d);
      setContent(d.content);
      setDirty(false);
      setConflict(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "문서 열기 실패");
    }
  }, []);

  const save = useCallback(async () => {
    if (!current) return;
    setSaving(true);
    try {
      const updated = await api.aidocUpdate(current.id, {
        expected_version: current.version,
        content,
        change_summary: "웹 편집",
      });
      setCurrent(updated);
      setContent(updated.content);
      setDirty(false);
      setConflict(null);
      reload();
      toast.ok(`저장됨 · v${updated.version}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const c = e.detail as AidocConflict;
        setConflict(c.current_version);
        toast.error(`다른 곳에서 v${c.current_version}으로 수정됨 — 충돌을 해결하세요`);
      } else {
        toast.error(e instanceof Error ? e.message : "저장 실패");
      }
    } finally {
      setSaving(false);
    }
  }, [current, content, reload]);

  // 충돌 해결: 최신본 불러오기(내 변경 버림)
  const loadLatest = useCallback(async () => {
    if (!current) return;
    const d = await api.aidocGet(current.id);
    setCurrent(d);
    setContent(d.content);
    setDirty(false);
    setConflict(null);
    toast.ok(`최신본 v${d.version} 불러옴`);
  }, [current]);

  // 충돌 해결: 최신 버전 위에 강제 저장(내 내용 유지)
  const forceSave = useCallback(async () => {
    if (!current || conflict === null) return;
    setSaving(true);
    try {
      const updated = await api.aidocUpdate(current.id, {
        expected_version: conflict,
        content,
        change_summary: "웹 편집(강제)",
      });
      setCurrent(updated);
      setContent(updated.content);
      setDirty(false);
      setConflict(null);
      reload();
      toast.ok(`저장됨 · v${updated.version}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }, [current, conflict, content, reload]);

  const onEdit = (v: string) => {
    setContent(v);
    setDirty(true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (conflict === null) save();
    }
  };

  const createDoc = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setNewOpen(false);
    setNewTitle("");
    try {
      const d = await api.aidocCreate({ title, content: `# ${title}\n\n`, project: newProject || null });
      await reload();
      setCurrent(d);
      setContent(d.content);
      setDirty(false);
      setConflict(null);
      toast.ok("문서 생성됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "생성 실패");
    }
  };

  const doTrash = async () => {
    if (!delId) return;
    const id = delId;
    setDelId(null);
    try {
      await api.aidocTrash(id);
      if (current?.id === id) {
        setCurrent(null);
        setContent("");
      }
      reload();
      toast.ok("휴지통으로 이동됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "삭제 실패");
    }
  };

  const restoreDoc = async (id: string) => {
    try {
      await api.aidocRestore(id, null);
      reload();
      toast.ok("복원됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "복원 실패");
    }
  };

  const openHistory = async () => {
    if (!current) return;
    setHistoryOpen(true);
    setHistory(null);
    try {
      setHistory(await api.aidocHistory(current.id));
    } catch (e) {
      setHistory([]);
      toast.error(e instanceof Error ? e.message : "이력 실패");
    }
  };

  const restoreVersion = async (version: number) => {
    if (!current) return;
    try {
      await api.aidocRestore(current.id, version);
      setHistoryOpen(false);
      await open(current.id);
      reload();
      toast.ok(`v${version} 내용으로 복원(새 버전 생성)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "복원 실패");
    }
  };

  const openAudit = async () => {
    setAuditOpen(true);
    setAudit(null);
    try {
      setAudit(await api.aidocAudit());
    } catch (e) {
      setAudit([]);
      toast.error(e instanceof Error ? e.message : "감사 로그 실패");
    }
  };

  const onSearch = (v: string) => {
    setQuery(v);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    if (!v.trim()) {
      setHits(null);
      return;
    }
    searchTimer.current = window.setTimeout(async () => {
      try {
        setHits(await api.aidocSearch(v.trim()));
      } catch {
        setHits([]);
      }
    }, 300);
  };

  const listItems = hits !== null ? hits : docs;
  const projName = (p: string | null) => p ?? "미분류";
  const aiEdited = useMemo(
    () => !!current?.updated_by && /codex|claude|gpt|ai|gemini/i.test(current.updated_by),
    [current],
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:h-[calc(100vh-9rem)] lg:grid-cols-[260px_1fr_1fr]">
      {/* 목록 */}
      <div className="card flex max-h-96 flex-col overflow-hidden lg:max-h-none">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="label flex items-center gap-1.5"><Sparkles size={13} className="text-accent" /> AI 문서 {docs.length}</span>
          <div className="flex items-center gap-0.5">
            <button onClick={openAudit} className="btn btn-ghost h-7 px-2" title="감사 로그" aria-label="감사 로그">
              <ScrollText size={15} />
            </button>
            <button onClick={() => { setNewTitle(""); setNewProject(projectFilter && projectFilter !== INBOX ? projectFilter : ""); setNewOpen(true); }}
              className="btn btn-ghost h-7 px-2" title="새 문서" aria-label="새 문서">
              <FilePlus size={15} />
            </button>
          </div>
        </div>

        {/* 프로젝트 필터 + 휴지통 */}
        <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
          <FolderOpen size={13} className="shrink-0 text-fg-muted" />
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="h-7 flex-1 cursor-pointer appearance-none rounded-md border border-line bg-subtle px-2 text-[12px] outline-none hover:border-line-strong focus:border-accent"
          >
            <option value="">전체 프로젝트</option>
            <option value={INBOX}>미분류(inbox)</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button
            onClick={() => setShowTrash((v) => !v)}
            title="휴지통 보기"
            className={`shrink-0 rounded-md border p-1.5 transition-colors ${showTrash ? "border-danger/40 bg-danger/10 text-danger" : "border-line text-fg-muted hover:text-fg"}`}
          >
            <Trash2 size={13} />
          </button>
        </div>

        <div className="border-b border-line p-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input value={query} onChange={(e) => onSearch(e.target.value)}
              placeholder="문서 검색…" aria-label="문서 검색"
              className="input h-8 pl-8 pr-7 text-[12.5px]" />
            {query && (
              <button onClick={() => onSearch("")} aria-label="검색 지우기"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg">
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        <ul className="flex-1 overflow-auto p-1">
          {listItems.length === 0 ? (
            <li className="px-2 py-6 text-center text-[12px] text-fg-muted">
              {showTrash ? "휴지통이 비었습니다" : "문서가 없습니다"}
            </li>
          ) : (
            listItems.map((d) => (
              <li key={d.id}>
                <div className={`group flex items-center gap-2 rounded-md pr-1 ${current?.id === d.id ? "bg-accent-muted" : "hover:bg-hovered"}`}>
                  <button onClick={() => (showTrash ? undefined : open(d.id))}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pl-2.5 text-left">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium">
                      <Bot size={13} className="shrink-0 text-accent" />
                      <span className="truncate">{d.title}</span>
                    </span>
                    <span className="flex items-center gap-1.5 pl-5 text-[11px] text-fg-muted">
                      <span className="truncate">{projName(d.project)}</span>
                      <span className="shrink-0">· v{d.version}</span>
                    </span>
                  </button>
                  {showTrash ? (
                    <button onClick={() => restoreDoc(d.id)} title="복원"
                      className="shrink-0 rounded p-1.5 text-fg-muted hover:text-positive">
                      <RotateCcw size={13} />
                    </button>
                  ) : (
                    <button onClick={() => setDelId(d.id)} title="휴지통으로"
                      className="hidden shrink-0 rounded p-1.5 text-fg-muted hover:text-danger group-hover:block">
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </li>
            ))
          )}
        </ul>
      </div>

      {/* 에디터 */}
      <div className="card relative flex min-h-[40vh] flex-col overflow-hidden lg:min-h-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium">
            <Bot size={14} className="shrink-0 text-accent" />
            <span className="truncate">{current ? current.title : "문서를 선택하세요"}</span>
            {current && <span className="badge shrink-0">v{current.version}</span>}
            {aiEdited && <span className="badge badge-accent shrink-0" title={`최근 수정: ${current?.updated_by}`}><Sparkles size={10} /> AI</span>}
          </span>
          <div className="flex items-center gap-1">
            {saving ? <Loader2 size={13} className="animate-spin text-fg-muted" />
              : dirty ? <span className="label text-warning">미저장</span>
              : current ? <span className="label text-positive">저장됨</span> : null}
            {current && (
              <>
                <button onClick={save} disabled={!dirty || conflict !== null} className="btn btn-ghost h-7 px-2 disabled:opacity-40" title="저장 (Ctrl+S)">
                  <Save size={14} />
                </button>
                <button onClick={openHistory} className="btn btn-ghost h-7 px-2" title="버전 이력">
                  <History size={14} />
                </button>
                <button onClick={() => setDelId(current.id)} className="btn btn-ghost h-7 px-2 hover:text-danger" title="휴지통으로">
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
        </div>

        {conflict !== null && (
          <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
            <AlertTriangle size={14} className="shrink-0 text-warning" />
            <span className="flex-1">문서가 다른 곳에서 <b>v{conflict}</b>으로 수정되었습니다.</span>
            <button onClick={loadLatest} className="btn btn-ghost h-6 px-2 text-[11.5px]">최신본 불러오기</button>
            <button onClick={forceSave} className="btn btn-danger h-6 px-2 text-[11.5px]">내 내용으로 덮어쓰기</button>
          </div>
        )}

        {current ? (
          <textarea value={content} onChange={(e) => onEdit(e.target.value)} onKeyDown={onKeyDown}
            placeholder="마크다운으로 작성…"
            className="flex-1 resize-none bg-transparent p-4 font-mono text-[13.5px] leading-relaxed outline-none placeholder:text-fg-subtle" />
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-[13px] text-fg-muted">
            왼쪽에서 문서를 선택하거나 새로 만드세요
          </div>
        )}
      </div>

      {/* 미리보기 + 메타 */}
      <div className="card flex min-h-[30vh] flex-col overflow-hidden lg:min-h-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="label">미리보기</span>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {current ? <MarkdownView content={content} onWikiClick={() => {}} />
            : <p className="text-[13px] text-fg-muted">선택된 문서 없음</p>}
        </div>
        {current && (
          <div className="space-y-1.5 border-t border-line p-3 text-[11.5px] text-fg-muted">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>프로젝트: <b className="text-fg2">{projName(current.project)}</b></span>
              <span>상태: {current.status}</span>
              <span>버전: v{current.version}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>생성: {current.created_by ?? "?"} · {fmt(current.created_at)}</span>
              <span>수정: {current.updated_by ?? "?"} · {fmt(current.updated_at)}</span>
            </div>
            {current.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {current.tags.map((t) => <span key={t} className="badge">{t}</span>)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 새 문서 */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="새 AI 문서" width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={newTitle} placeholder="문서 제목"
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createDoc(); if (e.key === "Escape") setNewOpen(false); }} />
          <label className="block">
            <span className="label">프로젝트</span>
            <select value={newProject} onChange={(e) => setNewProject(e.target.value)}
              className="input mt-1 cursor-pointer">
              <option value="">미분류(inbox)</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <button onClick={() => setNewOpen(false)} className="btn btn-ghost">취소</button>
            <button onClick={createDoc} className="btn btn-primary">만들기</button>
          </div>
        </div>
      </Modal>

      {/* 삭제 확인 */}
      <Modal open={!!delId} onClose={() => setDelId(null)} title="문서 삭제" width="max-w-sm">
        <div className="space-y-4">
          <p className="text-[13.5px] text-fg2">이 문서를 휴지통으로 옮길까요? 휴지통에서 복원할 수 있습니다.</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDelId(null)} className="btn btn-ghost">취소</button>
            <button onClick={doTrash} className="btn btn-danger"><Trash2 size={14} /> 휴지통으로</button>
          </div>
        </div>
      </Modal>

      {/* 버전 이력 */}
      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="버전 이력" width="max-w-lg">
        <div className="max-h-[60vh] overflow-auto">
          {history === null ? (
            <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-fg-muted" /></div>
          ) : history.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-fg-muted">이전 버전이 없습니다</p>
          ) : (
            <ul className="divide-y divide-line">
              {history.map((h) => (
                <li key={h.version} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <span className="text-[13px] font-medium">v{h.version}</span>
                    <span className="ml-2 text-[12px] text-fg-muted">{h.actor ?? "?"} · {fmt(h.created_at)}</span>
                    {h.change_summary && <p className="truncate text-[11.5px] text-fg-muted">{h.change_summary}</p>}
                  </div>
                  <button onClick={() => restoreVersion(h.version)} className="btn btn-ghost h-7 shrink-0 px-2 text-[12px]">
                    <RotateCcw size={13} /> 이 버전으로
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      {/* 감사 로그 */}
      <Modal open={auditOpen} onClose={() => setAuditOpen(false)} title="감사 로그" width="max-w-2xl">
        <div className="max-h-[60vh] overflow-auto">
          {audit === null ? (
            <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-fg-muted" /></div>
          ) : audit.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-fg-muted">기록이 없습니다</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="text-left text-fg-muted">
                <tr className="border-b border-line">
                  <th className="py-1.5 pr-2 font-medium">시각</th>
                  <th className="py-1.5 pr-2 font-medium">행위자</th>
                  <th className="py-1.5 pr-2 font-medium">동작</th>
                  <th className="py-1.5 pr-2 font-medium">프로젝트</th>
                  <th className="py-1.5 font-medium">버전</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id} className="border-b border-line/60">
                    <td className="py-1.5 pr-2 text-fg-muted">{fmt(a.timestamp)}</td>
                    <td className="py-1.5 pr-2">{a.actor ?? "?"}</td>
                    <td className="py-1.5 pr-2">{a.action}</td>
                    <td className="py-1.5 pr-2">{a.project ?? "-"}</td>
                    <td className="py-1.5">{a.from_version != null ? `${a.from_version}→${a.to_version}` : (a.to_version ?? "-")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Modal>
    </div>
  );
}
