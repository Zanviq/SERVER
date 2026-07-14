import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, FilePlus, Save, Trash2, History, Loader2, Search, X, RotateCcw,
  ScrollText, AlertTriangle, Sparkles, FolderOpen, Folder, FolderPlus, ArrowUpDown,
  ChevronRight, ChevronDown, Home, Plus, Pencil, MoreHorizontal, FolderInput,
} from "lucide-react";
import { MarkdownView } from "./MarkdownView";
import { ThreePane } from "./ThreePane";
import { Modal } from "../ui/Modal";
import {
  api, ApiError, AidocMeta, AidocDetail, AidocVersion, AidocAuditLog,
  AidocSearchHit, AidocConflict,
} from "../../lib/api";
import { toast } from "../../store/toast";

const INBOX = "__inbox__"; // 프로젝트 미지정(inbox) 필터 값

interface FTree { name: string; path: string; children: FTree[]; docs: AidocMeta[]; }

function fmt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("ko-KR", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/** AI 문서(aidoc) 작업 공간 — 노트 페이지에서 문서 API 경유로 열람·편집.
 *  버전 표시, 낙관적 잠금(409) 충돌 처리, 이력/복원, 휴지통, 감사 로그. */
export function AidocWorkspace({ openDocId }: { openDocId?: string }) {
  const [docs, setDocs] = useState<AidocMeta[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<string>(""); // "" 전체
  const [showTrash, setShowTrash] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<AidocSearchHit[] | null>(null);
  const searchTimer = useRef<number | null>(null);
  const [folder, setFolder] = useState<string>(""); // 선택 하위폴더("" 전체)
  const [folders, setFolders] = useState<string[]>([]);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newProjOpen, setNewProjOpen] = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const [manageOpen, setManageOpen] = useState(false); // 이름변경/삭제
  const [renameProjName, setRenameProjName] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);
  const [scrollSync, setScrollSync] = useState(true); // 편집↔미리보기 스크롤 동기화(기본 켜짐)

  // 편집 ↔ 미리보기 스크롤 비율 동기화 (피드백 루프 방지 플래그)
  const syncScroll = (from: HTMLElement | null, to: HTMLElement | null) => {
    if (!scrollSync || syncingScroll.current || !from || !to) return;
    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    if (fromMax <= 1) return;
    syncingScroll.current = true;
    to.scrollTop = (from.scrollTop / fromMax) * toMax;
    requestAnimationFrame(() => { syncingScroll.current = false; });
  };

  const [current, setCurrent] = useState<AidocDetail | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<number | null>(null); // 최신 버전(충돌 시)

  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newProject, setNewProject] = useState<string>(""); // "" = inbox
  const [delId, setDelId] = useState<string | null>(null);
  // 행 컨텍스트 메뉴: 이름 변경 / 이동
  const [renameFor, setRenameFor] = useState<AidocMeta | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [moveFor, setMoveFor] = useState<AidocMeta | null>(null);
  const [moveProject, setMoveProject] = useState<string>(""); // "" = inbox
  const [moveFolder, setMoveFolder] = useState<string>(""); // "" = 루트
  const [moveFolders, setMoveFolders] = useState<string[]>([]);

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

  // 폴더: 특정 프로젝트/inbox 선택 시 하위 폴더 목록 로드
  const folderEnabled = projectFilter !== "";
  const activeProject = projectFilter === INBOX ? "" : projectFilter; // "" = inbox
  const folderBase = projectFilter === INBOX ? "inbox/"
    : projectFilter ? `projects/${projectFilter}/` : "";
  const loadFolders = useCallback(() => {
    if (projectFilter === "") { setFolders([]); return; }
    api.aidocFolders(activeProject || undefined).then(setFolders).catch(() => setFolders([]));
  }, [projectFilter, activeProject]);
  useEffect(() => {
    setFolder("");
    loadFolders();
  }, [loadFolders]);

  // 이동 대상: 선택 문서 열릴 때 그 프로젝트로 초기화
  useEffect(() => {
    if (moveFor) setMoveProject(moveFor.project || "");
  }, [moveFor]);
  // 이동 대상: 프로젝트가 바뀌면 그 프로젝트의 폴더 목록 로드
  useEffect(() => {
    if (!moveFor) return;
    setMoveFolder("");
    api.aidocFolders(moveProject || undefined).then(setMoveFolders).catch(() => setMoveFolders([]));
  }, [moveFor, moveProject]);

  const docFolder = (d: { storage_path?: string }): string => {
    const sp = d.storage_path || "";
    if (!folderBase || !sp.startsWith(folderBase)) return "";
    const rest = sp.slice(folderBase.length);
    const i = rest.lastIndexOf("/");
    return i >= 0 ? rest.slice(0, i) : "";
  };

  const toggleFolder = (path: string) => {
    setFolder(path); // 새 문서/폴더 생성 위치 = 현재 폴더
    setExpanded((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });
  };

  // 드래그로 폴더에 넣기: 문서를 folderBase 기준 folderPath로 이동(move_document)
  const [dragOver, setDragOver] = useState<string | null>(null);
  const moveToFolder = async (docId: string, folderPath: string) => {
    const base = folderBase.replace(/\/$/, ""); // "projects/{p}" 또는 "inbox"
    if (!base) return;
    const target_folder = folderPath ? `${base}/${folderPath}` : base;
    try {
      await api.aidocMove(docId, { target_folder });
      toast.ok("이동했습니다");
      await reload();
      if (current?.id === docId) open(docId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "이동 실패");
    }
  };

  // 폴더/문서를 중첩 트리로 구성(빈 폴더는 folders 목록으로)
  const tree = useMemo(() => {
    const root: FTree = { name: "", path: "", children: [], docs: [] };
    const byPath = new Map<string, FTree>([["", root]]);
    const ensure = (path: string): FTree => {
      if (byPath.has(path)) return byPath.get(path)!;
      const parts = path.split("/");
      const parent = ensure(parts.slice(0, -1).join("/"));
      const node: FTree = { name: parts[parts.length - 1], path, children: [], docs: [] };
      parent.children.push(node); byPath.set(path, node); return node;
    };
    folders.forEach((f) => ensure(f));
    docs.forEach((d) => ensure(docFolder(d)).docs.push(d));
    const sort = (n: FTree) => {
      n.children.sort((a, b) => a.name.localeCompare(b.name));
      n.docs.sort((a, b) => a.title.localeCompare(b.title));
      n.children.forEach(sort);
    };
    sort(root);
    return root;
  }, [folders, docs, folderBase]);

  const renderTree = (node: FTree, depth: number): JSX.Element[] => {
    const rows: JSX.Element[] = [];
    for (const child of node.children) {
      const isOpen = expanded.has(child.path);
      rows.push(
        <li key={"f:" + child.path}>
          <button onClick={() => toggleFolder(child.path)}
            onDragOver={(e) => { e.preventDefault(); setDragOver(child.path); }}
            onDragLeave={() => setDragOver((p) => (p === child.path ? null : p))}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain");
              setDragOver(null);
              if (id) moveToFolder(id, child.path);
            }}
            className={`flex w-full items-center gap-1 rounded-md py-1.5 pr-1 text-left text-[13px] ${
              dragOver === child.path ? "ring-1 ring-accent bg-accent-muted"
              : folder === child.path ? "bg-accent-muted" : "hover:bg-hovered"
            }`}
            style={{ paddingLeft: depth * 12 + 4 }}>
            {isOpen ? <ChevronDown size={13} className="shrink-0 text-fg-muted" />
              : <ChevronRight size={13} className="shrink-0 text-fg-muted" />}
            <Folder size={14} className="shrink-0 text-warning" />
            <span className="truncate font-medium">{child.name}</span>
          </button>
        </li>,
      );
      if (isOpen) rows.push(...renderTree(child, depth + 1));
    }
    for (const d of node.docs) {
      rows.push(
        <li key={"d:" + d.id}
          draggable
          onDragStart={(e) => { e.dataTransfer.setData("text/plain", d.id); e.dataTransfer.effectAllowed = "move"; }}>
          <div className={`group flex items-center gap-2 rounded-md pr-1 ${current?.id === d.id ? "bg-accent-muted" : "hover:bg-hovered"}`}
            style={{ paddingLeft: depth * 12 + 22 }}>
            <button onClick={() => open(d.id)} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left">
              <Bot size={13} className="shrink-0 text-accent" />
              <span className="truncate text-[13px]">{d.title}</span>
              <span className="shrink-0 text-[10.5px] text-fg-muted">v{d.version}</span>
            </button>
            <RowMenu
              onRename={() => { setRenameFor(d); setRenameTitle(d.title); }}
              onMove={() => setMoveFor(d)}
              onTrash={() => setDelId(d.id)}
            />
          </div>
        </li>,
      );
    }
    return rows;
  };

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

  // 그래프 등에서 특정 문서로 진입(?aidoc=<id>)
  useEffect(() => {
    if (openDocId) open(openDocId);
  }, [openDocId, open]);

  // 미리보기의 [[제목]] 클릭 → 같은 제목 문서로 이동(일반 노트와 동일 동작)
  const openByTitle = useCallback((title: string) => {
    const t = title.trim().toLowerCase();
    const hit = docs.find((d) => d.title.trim().toLowerCase() === t);
    if (hit) open(hit.id);
    else toast.error(`"${title}" 문서를 찾을 수 없습니다`);
  }, [docs, open]);

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
    // 현재 필터 프로젝트와 새 문서 프로젝트가 같을 때만 선택 폴더에 생성
    const useFolder = folder && newProject === (projectFilter === INBOX ? "" : projectFilter);
    try {
      const d = await api.aidocCreate({
        title, content: `# ${title}\n\n`, project: newProject || null,
        folder: useFolder ? folder : undefined,
      });
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

  const reloadProjects = () => api.aidocProjects().then(setProjects).catch(() => {});

  const addProject = async () => {
    const name = newProjName.trim();
    if (!name) return;
    setNewProjOpen(false);
    setNewProjName("");
    try {
      const r = await api.aidocAddProject(name);
      await reloadProjects();
      setProjectFilter(r.name);
      toast.ok("프로젝트 생성됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "프로젝트 생성 실패");
    }
  };

  const renameProject = async () => {
    const name = renameProjName.trim();
    if (!name || name === projectFilter) { setManageOpen(false); return; }
    setManageOpen(false);
    try {
      const r = await api.aidocRenameProject(projectFilter, name);
      await reloadProjects();
      setProjectFilter(r.name);
      reload();
      toast.ok("이름 변경됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "이름 변경 실패");
    }
  };

  const deleteProject = async () => {
    setManageOpen(false);
    try {
      const r = await api.aidocDeleteProject(projectFilter);
      await reloadProjects();
      setProjectFilter("");
      reload();
      toast.ok(`프로젝트 삭제됨 (문서 ${r.trashed}개 휴지통으로)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "삭제 실패");
    }
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderOpen(false);
    setNewFolderName("");
    const path = folder ? `${folder}/${name}` : name; // 현재 폴더 하위에 생성
    try {
      await api.aidocCreateFolder({ project: activeProject || null, path });
      loadFolders();
      setFolder(path);
      toast.ok("폴더 생성됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "폴더 생성 실패");
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
  const showTree = folderEnabled && !showTrash && hits === null; // 특정 프로젝트/inbox + 비검색 = 트리
  const projName = (p: string | null) => p ?? "미분류";
  const aiEdited = useMemo(
    () => !!current?.updated_by && /codex|claude|gpt|ai|gemini/i.test(current.updated_by),
    [current],
  );

  const doRename = async () => {
    if (!renameFor || !renameTitle.trim()) return;
    try {
      await api.aidocUpdate(renameFor.id, { expected_version: renameFor.version, title: renameTitle.trim() });
      toast.ok("이름을 변경했습니다");
      const id = renameFor.id;
      setRenameFor(null);
      await reload();
      if (current?.id === id) open(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "이름 변경 실패(먼저 최신 상태로 새로고침하세요)");
    }
  };

  const doMove = async () => {
    if (!moveFor) return;
    const base = moveProject ? `projects/${moveProject}` : "inbox";
    const target_folder = moveFolder ? `${base}/${moveFolder}` : base;
    try {
      await api.aidocMove(moveFor.id, { target_folder });
      toast.ok("이동했습니다");
      const id = moveFor.id;
      setMoveFor(null);
      await reload();
      if (current?.id === id) open(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "이동 실패");
    }
  };

  return (
    <>
      <ThreePane storageKey="aidoc.panes.v1">
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
          {projectFilter && projectFilter !== INBOX && (
            <button onClick={() => { setRenameProjName(projectFilter); setManageOpen(true); }}
              title="프로젝트 이름 변경/삭제" aria-label="프로젝트 관리"
              className="shrink-0 rounded-md border border-line p-1.5 text-fg-muted hover:text-accent">
              <Pencil size={13} />
            </button>
          )}
          <button onClick={() => { setNewProjName(""); setNewProjOpen(true); }}
            title="새 프로젝트" aria-label="새 프로젝트"
            className="shrink-0 rounded-md border border-line p-1.5 text-fg-muted hover:text-accent">
            <Plus size={13} />
          </button>
          <button
            onClick={() => setShowTrash((v) => !v)}
            title="휴지통 보기"
            className={`shrink-0 rounded-md border p-1.5 transition-colors ${showTrash ? "border-danger/40 bg-danger/10 text-danger" : "border-line text-fg-muted hover:text-fg"}`}
          >
            <Trash2 size={13} />
          </button>
        </div>

        {/* 현재 위치 + 새 폴더 (특정 프로젝트/inbox 선택 시) — 새 폴더/문서는 이 위치에 생성 */}
        {folderEnabled && !showTrash && (
          <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5 text-[11.5px] text-fg-muted">
            <button onClick={() => setFolder("")}
              onDragOver={(e) => { e.preventDefault(); setDragOver("\0root"); }}
              onDragLeave={() => setDragOver((p) => (p === "\0root" ? null : p))}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain");
                setDragOver(null);
                if (id) moveToFolder(id, "");
              }}
              className={`flex min-w-0 flex-1 items-center gap-1 rounded text-left hover:text-accent ${
                dragOver === "\0root" ? "ring-1 ring-accent" : ""
              }`}
              title="루트로 (여기로 드래그하면 프로젝트 루트로 이동)">
              <Home size={12} className="shrink-0" />
              <span className="truncate">위치: {folder || "루트"}</span>
            </button>
            <button
              onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }}
              title="새 폴더" aria-label="새 폴더"
              className="shrink-0 rounded-md border border-line p-1.5 text-fg-muted hover:text-accent"
            >
              <FolderPlus size={13} />
            </button>
          </div>
        )}

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
          {showTree ? (
            docs.length === 0 && folders.length === 0 ? (
              <li className="px-2 py-6 text-center text-[12px] text-fg-muted">문서가 없습니다</li>
            ) : (
              renderTree(tree, 0)
            )
          ) : listItems.length === 0 ? (
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
                    <RowMenu
                      onRename={() => { setRenameFor(d); setRenameTitle(d.title); }}
                      onMove={() => setMoveFor(d)}
                      onTrash={() => setDelId(d.id)}
                    />
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
          <textarea ref={taRef} value={content} onChange={(e) => onEdit(e.target.value)} onKeyDown={onKeyDown}
            onScroll={() => syncScroll(taRef.current, previewRef.current)}
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
          <button
            onClick={() => setScrollSync((v) => !v)}
            title="편집·미리보기 스크롤 동기화"
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
              scrollSync ? "border-accent/40 bg-accent-muted text-accent-fg" : "border-line text-fg-muted hover:text-fg"
            }`}
          >
            <ArrowUpDown size={11} /> 스크롤 동기화 {scrollSync ? "켜짐" : "꺼짐"}
          </button>
        </div>
        <div ref={previewRef} onScroll={() => syncScroll(previewRef.current, taRef.current)}
          className="flex-1 overflow-auto p-4">
          {current ? <MarkdownView content={content} onWikiClick={openByTitle} />
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
      </ThreePane>

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
          {folder && newProject === (projectFilter === INBOX ? "" : projectFilter) && (
            <p className="text-[11.5px] text-fg-muted">폴더: <b className="text-fg2">{folder}</b> 에 생성됩니다</p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setNewOpen(false)} className="btn btn-ghost">취소</button>
            <button onClick={createDoc} className="btn btn-primary">만들기</button>
          </div>
        </div>
      </Modal>

      {/* 새 폴더 */}
      <Modal open={newFolderOpen} onClose={() => setNewFolderOpen(false)}
             title={`새 폴더${folder ? ` · ${folder}` : ""}`} width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={newFolderName} placeholder="폴더 이름"
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") setNewFolderOpen(false); }} />
          <p className="text-[11.5px] text-fg-muted">
            {(projectFilter === INBOX ? "미분류(inbox)" : projectFilter)} 하위{folder ? ` · ${folder}` : ""}에 만듭니다.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setNewFolderOpen(false)} className="btn btn-ghost">취소</button>
            <button onClick={createFolder} className="btn btn-primary">만들기</button>
          </div>
        </div>
      </Modal>

      {/* 새 프로젝트 */}
      <Modal open={newProjOpen} onClose={() => setNewProjOpen(false)} title="새 프로젝트" width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={newProjName} placeholder="프로젝트 이름(영문/숫자/한글)"
            onChange={(e) => setNewProjName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addProject(); if (e.key === "Escape") setNewProjOpen(false); }} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setNewProjOpen(false)} className="btn btn-ghost">취소</button>
            <button onClick={addProject} className="btn btn-primary">만들기</button>
          </div>
        </div>
      </Modal>

      {/* 프로젝트 이름 변경 / 삭제 */}
      <Modal open={manageOpen} onClose={() => setManageOpen(false)} title={`프로젝트 · ${projectFilter}`} width="max-w-sm">
        <div className="space-y-4">
          <label className="block">
            <span className="label">이름 변경</span>
            <input className="input mt-1" value={renameProjName}
              onChange={(e) => setRenameProjName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") renameProject(); }} />
          </label>
          <p className="text-[11.5px] text-fg-muted">
            문서·폴더·메모리가 함께 이동합니다. 특정 프로젝트로 스코프된 토큰이 있다면 그 이름은 수동으로 바꿔야 합니다.
          </p>
          <div className="flex items-center justify-between gap-2">
            <button onClick={deleteProject} className="btn btn-danger">
              <Trash2 size={14} /> 프로젝트 삭제
            </button>
            <div className="flex gap-2">
              <button onClick={() => setManageOpen(false)} className="btn btn-ghost">취소</button>
              <button onClick={renameProject} className="btn btn-primary">이름 변경</button>
            </div>
          </div>
          <p className="text-[11px] text-fg-subtle">삭제 시 이 프로젝트의 모든 문서가 휴지통으로 이동합니다(영구삭제 아님).</p>
        </div>
      </Modal>

      {/* 이름 변경 */}
      <Modal open={!!renameFor} onClose={() => setRenameFor(null)} title="이름 변경" width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={renameTitle} placeholder="새 제목"
            onChange={(e) => setRenameTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doRename(); if (e.key === "Escape") setRenameFor(null); }} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setRenameFor(null)} className="btn btn-ghost">취소</button>
            <button onClick={doRename} className="btn btn-primary">변경</button>
          </div>
        </div>
      </Modal>

      {/* 이동 */}
      <Modal open={!!moveFor} onClose={() => setMoveFor(null)} title="문서 이동" width="max-w-sm">
        <div className="space-y-3">
          <label className="block">
            <span className="label">프로젝트</span>
            <select value={moveProject} onChange={(e) => setMoveProject(e.target.value)}
              className="input mt-1 cursor-pointer">
              <option value="">미분류(inbox)</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="label">폴더</span>
            <select value={moveFolder} onChange={(e) => setMoveFolder(e.target.value)}
              className="input mt-1 cursor-pointer">
              <option value="">(루트)</option>
              {moveFolders.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <p className="text-[11px] text-fg-subtle">문서 ID는 유지됩니다(MCP 접근에 영향 없음). 경로만 바뀝니다.</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setMoveFor(null)} className="btn btn-ghost">취소</button>
            <button onClick={doMove} className="btn btn-primary"><FolderInput size={14} /> 이동</button>
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
    </>
  );
}

/** 문서 행의 "..." 컨텍스트 메뉴(이름 변경 / 이동 / 휴지통). 외부 클릭·ESC로 닫힘. */
function RowMenu({ onRename, onMove, onTrash }: {
  onRename: () => void; onMove: () => void; onTrash: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} title="더보기" aria-label="더보기"
        className={`rounded p-1 text-fg-muted hover:text-fg ${open ? "block" : "hidden group-hover:block"}`}>
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 w-32 overflow-hidden rounded-md border border-line bg-surface py-1 shadow-lg">
          <MenuItem icon={Pencil} label="이름 변경" onClick={() => { setOpen(false); onRename(); }} />
          <MenuItem icon={FolderInput} label="이동" onClick={() => { setOpen(false); onMove(); }} />
          <MenuItem icon={Trash2} label="휴지통으로" danger onClick={() => { setOpen(false); onTrash(); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: {
  icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-hovered ${danger ? "text-danger" : "text-fg2"}`}>
      <Icon size={13} className="shrink-0" /> {label}
    </button>
  );
}
