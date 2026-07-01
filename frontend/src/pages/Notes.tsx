import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  NotebookPen, FolderPlus, FilePlus, Trash2, Save, Link2, Users, User, Loader2,
  FileText, Search, X, Folder, ChevronRight, ChevronDown, Home,
} from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { MarkdownView } from "../components/notes/MarkdownView";
import { Modal } from "../components/ui/Modal";
import { api, NoteSummary, NoteDetail, NoteSearchHit, Scope } from "../lib/api";
import { toast } from "../store/toast";
import { useSettings } from "../store/settings";

interface TreeNode {
  name: string;
  path: string; // 폴더 상대경로
  children: TreeNode[];
  notes: NoteSummary[];
}

function buildTree(folders: string[], notes: NoteSummary[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], notes: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);

  const ensure = (path: string): TreeNode => {
    if (byPath.has(path)) return byPath.get(path)!;
    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");
    const parent = ensure(parentPath);
    const node: TreeNode = { name, path, children: [], notes: [] };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };

  folders.forEach((f) => ensure(f));
  notes.forEach((n) => {
    const slash = n.path.lastIndexOf("/");
    const parentPath = slash >= 0 ? n.path.slice(0, slash) : "";
    ensure(parentPath).notes.push(n);
  });

  const sortNode = (node: TreeNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.notes.sort((a, b) => a.title.localeCompare(b.title));
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

export function Notes() {
  const prefs = useSettings((st) => st.settings?.notes);
  const [scope, setScope] = useState<Scope>((prefs?.default_scope as Scope) || "me");
  const [folders, setFolders] = useState<string[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [curFolder, setCurFolder] = useState(""); // 새 노트/폴더가 생성될 위치
  const [current, setCurrent] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [delOpen, setDelOpen] = useState(false);
  const [delFolder, setDelFolder] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [suggest, setSuggest] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NoteSearchHit[] | null>(null);
  const searchTimer = useRef<number | null>(null);
  const [params, setParams] = useSearchParams();

  const autosaveMs = prefs?.autosave_ms ?? 900;
  const tree = useMemo(() => buildTree(folders, notes), [folders, notes]);

  const reloadTree = useCallback(async () => {
    try {
      const t = await api.noteTree(scope);
      setFolders(t.folders);
      setNotes(t.notes);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "목록 실패");
    }
  }, [scope]);

  useEffect(() => {
    reloadTree();
    setCurrent(null);
    setContent("");
    setDetail(null);
    setCurFolder("");
  }, [reloadTree]);

  const openNote = useCallback(
    async (path: string) => {
      try {
        const d = await api.noteGet(scope, path);
        setCurrent(d.path);
        setContent(d.content);
        setDetail(d);
        setDirty(false);
        // 열린 노트의 상위 폴더를 현재 폴더로
        const slash = d.path.lastIndexOf("/");
        setCurFolder(slash >= 0 ? d.path.slice(0, slash) : "");
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
        reloadTree();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "저장 실패");
      } finally {
        setSaving(false);
      }
    },
    [scope, reloadTree],
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
        setSuggest(notes.map((n) => n.title).filter((t) => t.toLowerCase().includes(qstr)).slice(0, 6));
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

  const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

  const createNote = async () => {
    const name = newName.trim();
    if (!name) return;
    setNewNoteOpen(false);
    setNewName("");
    const path = joinPath(curFolder, name);
    await save(path, `# ${name}\n\n`);
    await reloadTree();
    if (curFolder) setExpanded((s) => new Set(s).add(curFolder));
    openNote(`${path}.md`);
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    setNewFolderOpen(false);
    setNewName("");
    const path = joinPath(curFolder, name);
    try {
      await api.noteFolderCreate(scope, path);
      await reloadTree();
      setExpanded((s) => new Set(s).add(path));
      setCurFolder(path);
      toast.ok("폴더 생성됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "폴더 생성 실패");
    }
  };

  const delNote = async () => {
    if (!current) return;
    setDelOpen(false);
    try {
      await api.noteDelete(scope, current);
      setCurrent(null);
      setContent("");
      setDetail(null);
      reloadTree();
      toast.ok("휴지통으로 이동됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "삭제 실패");
    }
  };

  const doDelFolder = async () => {
    if (!delFolder) return;
    const target = delFolder;
    setDelFolder(null);
    try {
      await api.noteFolderDelete(scope, target);
      if (curFolder === target || curFolder.startsWith(target + "/")) setCurFolder("");
      reloadTree();
      toast.ok("폴더를 휴지통으로 이동했습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "폴더 삭제 실패");
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
        setHits(await api.noteSearch(scope, v.trim()));
      } catch {
        setHits([]);
      }
    }, 300);
  };

  const openByTitle = useCallback(
    (title: string) => {
      const found = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
      if (found) openNote(found.path);
      else save(title, `# ${title}\n\n`).then(() => reloadTree().then(() => openNote(`${title}.md`)));
    },
    [notes, openNote, save, reloadTree],
  );

  useEffect(() => {
    const open = params.get("open");
    if (open && notes.length) {
      openByTitle(open);
      params.delete("open");
      setParams(params, { replace: true });
    }
  }, [params, notes, openByTitle, setParams]);

  const toggleFolder = (path: string) => {
    setCurFolder(path);
    setExpanded((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });
  };

  // 재귀 폴더 렌더
  const renderNode = (node: TreeNode, depth: number): JSX.Element[] => {
    const rows: JSX.Element[] = [];
    for (const child of node.children) {
      const isOpen = expanded.has(child.path);
      const isCur = curFolder === child.path;
      rows.push(
        <li key={"f:" + child.path}>
          <div
            className={`group flex items-center gap-1 rounded-md pr-1 text-[13px] ${isCur ? "bg-accent-muted" : "hover:bg-hovered"}`}
            style={{ paddingLeft: depth * 12 + 4 }}
          >
            <button onClick={() => toggleFolder(child.path)}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left">
              {isOpen ? <ChevronDown size={13} className="shrink-0 text-fg-muted" />
                : <ChevronRight size={13} className="shrink-0 text-fg-muted" />}
              <Folder size={14} className="shrink-0 text-warning" />
              <span className="truncate font-medium">{child.name}</span>
            </button>
            <button onClick={() => setDelFolder(child.path)}
              className="hidden shrink-0 rounded p-1 text-fg-muted hover:text-danger group-hover:block"
              title="폴더 삭제" aria-label="폴더 삭제">
              <Trash2 size={12} />
            </button>
          </div>
        </li>,
      );
      if (isOpen) rows.push(...renderNode(child, depth + 1));
    }
    for (const n of node.notes) {
      rows.push(
        <li key={"n:" + n.path}>
          <button onClick={() => openNote(n.path)}
            className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[13px] ${current === n.path ? "bg-accent-muted text-accent-fg" : "hover:bg-hovered"}`}
            style={{ paddingLeft: depth * 12 + 22 }}>
            <FileText size={14} className="shrink-0 text-fg-muted" />
            <span className="truncate">{n.title}</span>
          </button>
        </li>,
      );
    }
    return rows;
  };

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
      <div className="grid grid-cols-1 gap-4 lg:h-[calc(100vh-9rem)] lg:grid-cols-[240px_1fr_1fr]">
        {/* 트리 */}
        <div className="card flex max-h-80 flex-col overflow-hidden lg:max-h-none">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="label">노트 {notes.length}</span>
            <div className="flex items-center gap-0.5">
              <button onClick={() => { setNewName(""); setNewFolderOpen(true); }}
                className="btn btn-ghost h-7 px-2" title="새 폴더" aria-label="새 폴더">
                <FolderPlus size={15} />
              </button>
              <button onClick={() => { setNewName(""); setNewNoteOpen(true); }}
                className="btn btn-ghost h-7 px-2" title="새 노트" aria-label="새 노트">
                <FilePlus size={15} />
              </button>
            </div>
          </div>

          {/* 현재 위치 */}
          <button onClick={() => setCurFolder("")}
            className="flex items-center gap-1 border-b border-line px-3 py-1.5 text-left text-[11.5px] text-fg-muted hover:text-accent"
            title="루트로">
            <Home size={12} className="shrink-0" />
            <span className="truncate">위치: {curFolder || "루트"}</span>
          </button>

          <div className="border-b border-line p-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <input value={query} onChange={(e) => onSearch(e.target.value)}
                placeholder="내용 검색…" aria-label="노트 검색"
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
            {hits !== null ? (
              hits.length === 0 ? (
                <li className="px-2 py-6 text-center text-[12px] text-fg-muted">검색 결과 없음</li>
              ) : (
                hits.map((h) => (
                  <li key={h.path}>
                    <button onClick={() => openNote(h.path)}
                      className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left ${current === h.path ? "bg-accent-muted" : "hover:bg-hovered"}`}>
                      <span className="flex items-center gap-2 text-[13px] font-medium">
                        <FileText size={13} className="shrink-0 text-accent" />
                        <span className="truncate">{h.title}</span>
                      </span>
                      <span className="truncate pl-5 text-[11.5px] text-fg-muted">{h.snippet}</span>
                    </button>
                  </li>
                ))
              )
            ) : notes.length === 0 && folders.length === 0 ? (
              <li className="px-2 py-6 text-center text-[12px] text-fg-muted">노트가 없습니다</li>
            ) : (
              renderNode(tree, 0)
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
      <Modal open={newNoteOpen} onClose={() => setNewNoteOpen(false)} title={`새 노트${curFolder ? ` · ${curFolder}` : ""}`} width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={newName} placeholder="노트 제목"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createNote(); if (e.key === "Escape") setNewNoteOpen(false); }} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setNewNoteOpen(false)} className="btn btn-ghost">취소</button>
            <button onClick={createNote} className="btn btn-primary">만들기</button>
          </div>
        </div>
      </Modal>

      {/* 새 폴더 모달 */}
      <Modal open={newFolderOpen} onClose={() => setNewFolderOpen(false)} title={`새 폴더${curFolder ? ` · ${curFolder}` : ""}`} width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={newName} placeholder="폴더 이름"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") setNewFolderOpen(false); }} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setNewFolderOpen(false)} className="btn btn-ghost">취소</button>
            <button onClick={createFolder} className="btn btn-primary">만들기</button>
          </div>
        </div>
      </Modal>

      {/* 노트 삭제 확인 */}
      <Modal open={delOpen} onClose={() => setDelOpen(false)} title="노트 삭제" width="max-w-sm">
        <div className="space-y-4">
          <p className="text-[13.5px] text-fg2">
            <span className="font-mono text-danger">{current?.replace(/\.md$/, "")}</span> 노트를 휴지통으로 옮길까요? 휴지통에서 복원할 수 있습니다.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDelOpen(false)} className="btn btn-ghost">취소</button>
            <button onClick={delNote} className="btn btn-danger"><Trash2 size={14} /> 휴지통으로</button>
          </div>
        </div>
      </Modal>

      {/* 폴더 삭제 확인 */}
      <Modal open={!!delFolder} onClose={() => setDelFolder(null)} title="폴더 삭제" width="max-w-sm">
        <div className="space-y-4">
          <p className="text-[13.5px] text-fg2">
            <span className="font-mono text-danger">{delFolder}</span> 폴더를 하위 노트와 함께 휴지통으로 옮길까요?
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDelFolder(null)} className="btn btn-ghost">취소</button>
            <button onClick={doDelFolder} className="btn btn-danger"><Trash2 size={14} /> 휴지통으로</button>
          </div>
        </div>
      </Modal>
    </Shell>
  );
}
