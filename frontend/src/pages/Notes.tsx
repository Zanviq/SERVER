import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  NotebookPen, Plus, Trash2, Save, Link2, Users, User, Loader2, FileText,
} from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { MarkdownView } from "../components/notes/MarkdownView";
import { Modal } from "../components/ui/Modal";
import { api, NoteSummary, NoteDetail, Scope } from "../lib/api";
import { toast } from "../store/toast";
import { useSettings } from "../store/settings";

export function Notes() {
  const prefs = useSettings((st) => st.settings?.notes);
  const [scope, setScope] = useState<Scope>((prefs?.default_scope as Scope) || "me");
  const [list, setList] = useState<NoteSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [delOpen, setDelOpen] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [suggest, setSuggest] = useState<string[] | null>(null);
  const [params, setParams] = useSearchParams();

  const autosaveMs = prefs?.autosave_ms ?? 900;

  const reloadList = useCallback(async () => {
    try {
      setList(await api.noteList(scope));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "목록 실패");
    }
  }, [scope]);

  useEffect(() => {
    reloadList();
    setCurrent(null);
    setContent("");
    setDetail(null);
  }, [reloadList]);

  const openNote = useCallback(
    async (path: string) => {
      try {
        const d = await api.noteGet(scope, path);
        setCurrent(d.path);
        setContent(d.content);
        setDetail(d);
        setDirty(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "노트 열기 실패");
      }
    },
    [scope],
  );

  const save = useCallback(
    async (path: string, text: string) => {
      setSaving(true);
      try {
        await api.noteSave(scope, path, text);
        setDirty(false);
        const d = await api.noteGet(scope, path);
        setDetail(d);
        reloadList();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "저장 실패");
      } finally {
        setSaving(false);
      }
    },
    [scope, reloadList],
  );

  const onEdit = (text: string) => {
    setContent(text);
    setDirty(true);
    if (!current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => save(current, text), autosaveMs);

    const ta = taRef.current;
    if (ta) {
      const pos = ta.selectionStart;
      const before = text.slice(0, pos);
      const m = before.match(/\[\[([^\[\]\n]*)$/);
      if (m) {
        const qstr = m[1].toLowerCase();
        setSuggest(list.map((n) => n.title).filter((t) => t.toLowerCase().includes(qstr)).slice(0, 6));
      } else setSuggest(null);
    }
  };

  const insertLink = (title: string) => {
    const ta = taRef.current;
    if (!ta || !current) return;
    const pos = ta.selectionStart;
    const before = content.slice(0, pos).replace(/\[\[[^\[\]\n]*$/, `[[${title}]]`);
    setSuggest(null);
    onEdit(before + content.slice(pos));
    setTimeout(() => ta.focus(), 0);
  };

  const createNote = async () => {
    const name = newName.trim();
    if (!name) return;
    setNewOpen(false);
    setNewName("");
    await save(name, `# ${name}\n\n`);
    await reloadList();
    openNote(`${name}.md`);
  };

  const delNote = async () => {
    if (!current) return;
    setDelOpen(false);
    try {
      await api.noteDelete(scope, current);
      setCurrent(null);
      setContent("");
      setDetail(null);
      reloadList();
      toast.ok("노트 삭제됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "삭제 실패");
    }
  };

  const openByTitle = useCallback(
    (title: string) => {
      const found = list.find((n) => n.title.toLowerCase() === title.toLowerCase());
      if (found) openNote(found.path);
      else save(title, `# ${title}\n\n`).then(() => reloadList().then(() => openNote(`${title}.md`)));
    },
    [list, openNote, save, reloadList],
  );

  // 그래프 등에서 ?open=제목 으로 진입 시 해당 노트 열기
  useEffect(() => {
    const open = params.get("open");
    if (open && list.length) {
      openByTitle(open);
      params.delete("open");
      setParams(params, { replace: true });
    }
  }, [params, list, openByTitle, setParams]);

  const crumbs = (
    <div className="inline-flex rounded-md border border-line bg-subtle p-0.5">
      <button onClick={() => setScope("common")}
        className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium ${scope === "common" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"}`}>
        <Users size={14} /> 공통
      </button>
      <button onClick={() => setScope("me")}
        className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-[13px] font-medium ${scope === "me" ? "bg-surface text-accent shadow-sm" : "text-fg-muted hover:text-fg"}`}>
        <User size={14} /> 내 노트
      </button>
    </div>
  );

  return (
    <Shell title="노트" actions={crumbs}>
      <div className="grid grid-cols-1 gap-4 lg:h-[calc(100vh-9rem)] lg:grid-cols-[220px_1fr_1fr]">
        {/* 목록 */}
        <div className="card flex max-h-56 flex-col overflow-hidden lg:max-h-none">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="label">노트 {list.length}</span>
            <button onClick={() => setNewOpen(true)} className="btn btn-ghost h-7 px-2" title="새 노트" aria-label="새 노트">
              <Plus size={15} />
            </button>
          </div>
          <ul className="flex-1 overflow-auto p-1">
            {list.map((n) => (
              <li key={n.path}>
                <button onClick={() => openNote(n.path)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] ${current === n.path ? "bg-accent-muted text-accent-fg" : "hover:bg-hovered"}`}>
                  <FileText size={14} className="shrink-0 text-fg-muted" />
                  <span className="truncate">{n.title}</span>
                </button>
              </li>
            ))}
            {list.length === 0 && (
              <li className="px-2 py-6 text-center text-[12px] text-fg-muted">노트가 없습니다</li>
            )}
          </ul>
        </div>

        {/* 에디터 */}
        <div className="card relative flex min-h-[40vh] flex-col overflow-hidden lg:min-h-0">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="flex items-center gap-1.5 truncate text-[13px] font-medium">
              <NotebookPen size={14} className="shrink-0 text-accent" />
              {current ? current.replace(/\.md$/, "") : "노트를 선택하세요"}
            </span>
            <div className="flex items-center gap-1">
              {saving ? <Loader2 size={13} className="animate-spin text-fg-muted" />
                : dirty ? <Save size={13} className="text-warning" />
                : current ? <span className="label text-positive">저장됨</span> : null}
              {current && (
                <button onClick={() => setDelOpen(true)} className="btn btn-ghost h-7 px-2 hover:text-danger" aria-label="노트 삭제">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>
          {current ? (
            <textarea ref={taRef} value={content} onChange={(e) => onEdit(e.target.value)}
              placeholder="마크다운으로 작성… [[ 으로 다른 노트 링크"
              className="flex-1 resize-none bg-transparent p-4 font-mono text-[13.5px] leading-relaxed outline-none placeholder:text-fg-subtle" />
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-[13px] text-fg-muted">
              왼쪽에서 노트를 선택하거나 새로 만드세요
            </div>
          )}
          {suggest && suggest.length > 0 && (
            <div className="absolute bottom-4 left-4 z-10 w-56 overflow-hidden rounded-md border border-line bg-surface shadow-lg">
              {suggest.map((t) => (
                <button key={t} onClick={() => insertLink(t)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-hovered">
                  <Link2 size={13} className="text-accent" /> {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 프리뷰 + 백링크 */}
        <div className="card flex min-h-[30vh] flex-col overflow-hidden lg:min-h-0">
          <div className="border-b border-line px-3 py-2"><span className="label">미리보기</span></div>
          <div className="flex-1 overflow-auto p-4">
            {current ? <MarkdownView content={content} onWikiClick={openByTitle} />
              : <p className="text-[13px] text-fg-muted">선택된 노트 없음</p>}
          </div>
          {detail && detail.backlinks.length > 0 && (
            <div className="border-t border-line p-3">
              <span className="label flex items-center gap-1.5"><Link2 size={12} /> 백링크 {detail.backlinks.length}</span>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.backlinks.map((b) => (
                  <button key={b} onClick={() => openByTitle(b)} className="badge badge-accent hover:bg-accent-soft">{b}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 새 노트 모달 */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="새 노트" width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={newName} placeholder="노트 제목"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createNote(); if (e.key === "Escape") setNewOpen(false); }} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setNewOpen(false)} className="btn btn-ghost">취소</button>
            <button onClick={createNote} className="btn btn-primary">만들기</button>
          </div>
        </div>
      </Modal>

      {/* 삭제 확인 */}
      <Modal open={delOpen} onClose={() => setDelOpen(false)} title="노트 삭제" width="max-w-sm">
        <div className="space-y-4">
          <p className="text-[13.5px] text-fg2">
            <span className="font-mono text-danger">{current?.replace(/\.md$/, "")}</span> 노트를 삭제할까요? 되돌릴 수 없습니다.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDelOpen(false)} className="btn btn-ghost">취소</button>
            <button onClick={delNote} className="btn btn-danger"><Trash2 size={14} /> 삭제</button>
          </div>
        </div>
      </Modal>
    </Shell>
  );
}
