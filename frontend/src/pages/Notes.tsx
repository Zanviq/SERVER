import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  NotebookPen, FolderPlus, FilePlus, Trash2, Save, Link2, Loader2,
  FileText, Search, X, Folder, ChevronRight, ChevronDown, ChevronLeft, Home, FolderInput, Eye, Pencil, Upload, Download,
} from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { MarkdownView } from "../components/notes/LazyMarkdownView";
import { DocViewer } from "../components/notes/DocViewer";
import { ThreePane } from "../components/notes/ThreePane";
import { RowMenu } from "../components/notes/RowMenu";
import { LiveEditor } from "../components/notes/LazyLiveEditor";
import { NOTE_PATH_MIME } from "../components/notes/dragTypes";
import { Modal } from "../components/ui/Modal";
import { api, NoteSummary, NoteDetail, NoteSearchHit } from "../lib/api";
import { embedMarkdownFor, makeResolver } from "../lib/embeds";
import { toast } from "../store/toast";
import { useSettings } from "../store/settings";

interface TreeNode {
  name: string;
  path: string; // 폴더 상대경로
  children: TreeNode[];
  notes: NoteSummary[];
}

/** 드래그 강조용 "루트" 표식. 루트의 실제 경로는 빈 문자열이라 그대로 쓰면
 *  "강조 없음"(null)과 구분이 안 되므로, 폴더 경로가 될 수 없는 값을 쓴다. */
const ROOT_DROP = "/";

/** 목록에 보여줄 파일명 — 확장자를 포함한다.
 *  NoteSummary.title은 확장자를 뗀 값(= 위키링크 [[제목]]의 키)이라 표시용으로는 안 맞다. */
const fileName = (path: string) => path.split("/").pop() ?? path;

/** 문서가 들어 있는 폴더 경로(루트면 빈 문자열). */
const parentDir = (path: string) => {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
};

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
    // 화면에 보이는 값(확장자 포함 파일명) 기준으로 정렬해야 순서가 납득된다
    node.notes.sort((a, b) => fileName(a.path).localeCompare(fileName(b.path)));
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

export function Notes() {
  const prefs = useSettings((st) => st.settings?.notes);
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
  // 행 컨텍스트 메뉴: 이름 변경 / 이동 / 개별 삭제 + 드래그 이동
  const [renameFor, setRenameFor] = useState<NoteSummary | null>(null);
  const [renameName, setRenameName] = useState("");
  const [moveFor, setMoveFor] = useState<NoteSummary | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [delNotePath, setDelNotePath] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const [reading, setReading] = useState(false); // 편집(라이브 프리뷰) ↔ 읽기 뷰
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NoteSearchHit[] | null>(null);
  const searchTimer = useRef<number | null>(null);
  const [params, setParams] = useSearchParams();

  const autosaveMs = prefs?.autosave_ms ?? 900;
  const tree = useMemo(() => buildTree(folders, notes), [folders, notes]);

  const reloadTree = useCallback(async () => {
    try {
      const t = await api.noteTree();
      setFolders(t.folders);
      setNotes(t.notes);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "목록 실패");
    }
  }, []);

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
        const d = await api.noteGet(path);
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
    [],
  );

  /** 저장. quiet=true면 저장만 하고 재조회·트리 갱신을 건너뛴다.
   *
   *  자동저장(기본 900ms)마다 noteGet + noteTree를 부르면, 백엔드가 백링크를
   *  구하려고 마크다운 전체를 다시 읽고 파싱한다(저장으로 지문이 바뀌어 캐시가
   *  매번 무효화된다). 타이핑 중에 그걸 반복할 이유가 없다 — 문서 집합이 바뀌는
   *  동작(생성·삭제·이름변경)에서만 갱신한다. */
  const save = useCallback(
    async (path: string, text: string, quiet = false) => {
      setSaving(true);
      try {
        await api.noteSave(path, text);
        setDirty(false);
        if (!quiet) {
          const d = await api.noteGet(path);
          setDetail(d);
          reloadTree();
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "저장 실패");
      } finally {
        setSaving(false);
      }
    },
    [reloadTree],
  );

  // 라이브 에디터(CodeMirror)의 [[ 자동완성이 링크를 담당하므로 여기선 저장만.
  const onEdit = (text: string) => {
    setContent(text);
    setDirty(true);
    if (!current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => save(current, text, true), autosaveMs);
  };

  /** 모바일에서 목록으로 돌아가기. 대기 중인 자동저장을 먼저 흘려보낸다 —
   *  타이머(기본 900ms)가 뜨기 전에 나가면 마지막 입력이 사라진다. */
  const closeNote = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (current && dirty) save(current, content, true);
    }
    setCurrent(null);
    setDetail(null);
    setContent("");
  }, [current, dirty, content, save]);

  const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

  const createNote = async () => {
    const name = newName.trim();
    if (!name) return;
    setNewNoteOpen(false);
    setNewName("");
    const path = joinPath(curFolder, name);
    // 적은 이름 그대로 만든다. 확장자는 사용자가 정한다 — 예전엔 무조건 .md를 붙여서
    // 'todo.txt'처럼 확장자를 적지 않으면 뭘 만들든 마크다운이 됐다.
    // 마크다운일 때만 제목 줄을 넣는다(.txt/.py에 '# 이름'이 들어가면 곤란하다).
    const isMd = /\.(md|markdown)$/i.test(name);
    await save(path, isMd ? `# ${name.replace(/\.[^.]+$/, "")}\n\n` : "");
    await reloadTree();
    if (curFolder) setExpanded((s) => new Set(s).add(curFolder));
    openNote(path);
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    setNewFolderOpen(false);
    setNewName("");
    const path = joinPath(curFolder, name);
    try {
      await api.noteFolderCreate(path);
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
      await api.noteDelete(current);
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
      await api.noteFolderDelete(target);
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
        setHits(await api.noteSearch(v.trim()));
      } catch {
        setHits([]);
      }
    }, 300);
  };

  const openByTitle = useCallback(
    (title: string) => {
      const key = title.toLowerCase();
      const found =
        notes.find((n) => n.title.toLowerCase() === key) ??
        notes.find((n) => n.path.toLowerCase() === key) ??
        notes.find((n) => (n.path.split("/").pop() ?? "").toLowerCase() === key);
      if (found) {
        openNote(found.path);
        return;
      }
      // 확장자가 붙은 이름은 '이미 있는 파일'을 가리킨 것이다. 못 찾았다고 새로 만들면
      // 백엔드 save가 덮어쓰기라 todo.txt 같은 파일 내용이 '# todo.txt'로 날아간다.
      if (/\.[A-Za-z0-9]{1,8}$/.test(title)) {
        toast.error(`문서를 찾을 수 없습니다: ${title}`);
        return;
      }
      // 위키링크에는 확장자를 쓰지 않으므로 여기서 마크다운으로 정한다
      // (백엔드는 더 이상 확장자를 추측하지 않는다).
      save(`${title}.md`, `# ${title}\n\n`).then(() => reloadTree().then(() => openNote(`${title}.md`)));
    },
    [notes, openNote, save, reloadTree],
  );

  useEffect(() => {
    const open = params.get("open");
    const path = params.get("path");
    if (path) {
      // 정확한 상대경로로 열기(URL 진입·그래프 클릭 등) — openNote와 같은 동작이다
      openNote(path);
      params.delete("path");
      setParams(params, { replace: true });
    } else if (open && notes.length) {
      openByTitle(open);
      params.delete("open");
      setParams(params, { replace: true });
    }
  }, [params, notes, openByTitle, openNote, setParams]);

  const toggleFolder = (path: string) => {
    setCurFolder(path);
    setExpanded((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });
  };

  const doRenameNote = async () => {
    if (!renameFor || !renameName.trim()) return;
    try {
      const r = await api.noteRename(renameFor.path, renameName.trim());
      toast.ok("이름을 변경했습니다");
      const wasOpen = current === renameFor.path;
      setRenameFor(null);
      await reloadTree();
      if (wasOpen) openNote(r.path);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "이름 변경 실패");
    }
  };

  const doMoveNote = async (path: string, folder: string) => {
    try {
      const r = await api.noteMove(path, folder);
      toast.ok("이동했습니다");
      const wasOpen = current === path;
      setMoveFor(null);
      await reloadTree();
      if (wasOpen) openNote(r.path);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "이동 실패");
    }
  };

  const doDeleteNotePath = async () => {
    if (!delNotePath) return;
    const path = delNotePath;
    try {
      await api.noteDelete(path);
      if (current === path) { setCurrent(null); setDetail(null); setContent(""); }
      setDelNotePath(null);
      await reloadTree();
      toast.ok("휴지통으로 옮겼습니다");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "삭제 실패");
    }
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
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(child.path); }}
            onDragLeave={() => setDragOver((p) => (p === child.path ? null : p))}
            onDrop={(e) => {
              // 폴더가 이겨야 한다 — 막지 않으면 바깥(루트) 드롭존까지 함께 처리된다
              e.preventDefault();
              e.stopPropagation();
              const path = e.dataTransfer.getData("text/plain");
              setDragOver(null);
              if (path) doMoveNote(path, child.path);
            }}
            className={`group flex items-center gap-1 rounded-md pr-1 text-[13px] ${
              dragOver === child.path ? "ring-1 ring-accent bg-accent-muted"
              : isCur ? "bg-accent-muted" : "hover:bg-hovered"
            }`}
            style={{ paddingLeft: depth * 12 + 4 }}
          >
            <button onClick={() => toggleFolder(child.path)}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left">
              {isOpen ? <ChevronDown size={13} className="shrink-0 text-fg-muted" />
                : <ChevronRight size={13} className="shrink-0 text-fg-muted" />}
              <Folder size={14} className="shrink-0 text-warning" />
              <span className="truncate font-medium">{child.name}</span>
            </button>
            {/* 터치 기기엔 hover가 없어 group-hover로만 띄우면 모바일에서
                폴더 다운로드·삭제를 영영 못 누른다. 좁은 화면은 항상 표시. */}
            <a href={api.noteArchiveUrl(child.path)} download
              onClick={(e) => e.stopPropagation()}
              className="block shrink-0 rounded p-1 text-fg-muted hover:text-accent sm:hidden sm:group-hover:block"
              title="폴더를 zip으로 내려받기" aria-label="폴더 다운로드">
              <Download size={12} />
            </a>
            <button onClick={() => setDelFolder(child.path)}
              className="block shrink-0 rounded p-1 text-fg-muted hover:text-danger sm:hidden sm:group-hover:block"
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
        <li key={"n:" + n.path}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", n.path);
            // 에디터는 이 전용 타입으로만 '트리에서 온 드래그'를 가려낸다.
            // text/plain은 브라우저의 온갖 드래그가 다 쓰므로 판별에 못 쓴다.
            e.dataTransfer.setData(NOTE_PATH_MIME, n.path);
            e.dataTransfer.effectAllowed = "copyMove";
          }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(parentDir(n.path) || ROOT_DROP); }}
          onDrop={(e) => {
            // 문서 위에 떨어뜨리면 그 문서가 있는 폴더로 (옵시디언과 같다).
            // 막지 않으면 바깥 루트 드롭존이 함께 처리해 엉뚱한 곳으로 간다.
            e.preventDefault();
            e.stopPropagation();
            const path = e.dataTransfer.getData("text/plain");
            setDragOver(null);
            if (path && path !== n.path) doMoveNote(path, parentDir(n.path));
          }}>
          <div className={`group flex items-center gap-1 rounded-md pr-1 text-[13px] ${current === n.path ? "bg-accent-muted text-accent-fg" : "hover:bg-hovered"}`}
            style={{ paddingLeft: depth * 12 + 22 }}>
            <button onClick={() => openNote(n.path)}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left">
              <FileText size={14} className="shrink-0 text-fg-muted" />
              <span className="truncate">{fileName(n.path)}</span>
            </button>
            <RowMenu
              onRename={() => { setRenameFor(n); setRenameName(fileName(n.path)); }}
              onMove={() => { setMoveFor(n); setMoveTarget(""); }}
              onTrash={() => setDelNotePath(n.path)}
            />
          </div>
        </li>,
      );
    }
    return rows;
  };

  // 현재 열린 문서의 메타(종류에 따라 편집기/뷰어를 고른다)
  const currentMeta = current ? notes.find((n) => n.path === current) : undefined;
  const isEditable = !currentMeta || currentMeta.editable;

  const doUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    try {
      for (const f of Array.from(files)) await api.noteUpload(curFolder, f);
      toast.ok(`${files.length}개 업로드됨`);
      await reloadTree();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "업로드 실패");
    }
  };

  /** `![[사진.png]]` 같은 임베드를 실제 파일로 이어 준다. 편집기와 읽기 뷰가
   *  같은 해석기를 써야 한쪽에서만 이미지가 보이는 일이 없다. */
  const resolveEmbed = useMemo(
    () => makeResolver(notes, current, (p) => api.noteRawUrl(p)),
    [notes, current],
  );

  /** 편집기에 파일을 떨어뜨렸을 때 — 현재 폴더에 올리고 삽입할 문자열을 돌려준다. */
  const onDropFiles = useCallback(
    async (files: File[]): Promise<string[]> => {
      const out: string[] = [];
      try {
        for (const f of files) {
          const saved = await api.noteUpload(curFolder, f);
          out.push(embedMarkdownFor(saved.path, notes)); // 서버가 정한 최종 경로 기준
        }
        if (out.length) {
          toast.ok(`${out.length}개 첨부됨`);
          await reloadTree();
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "업로드 실패");
      }
      return out;
    },
    [curFolder, reloadTree, notes],
  );

  /** 트리에서 편집기로 끌어다 놓은 항목 → 삽입할 마크다운. */
  const onDropPath = useCallback((p: string) => embedMarkdownFor(p, notes), [notes]);

  const actions = (
    <div className="flex items-center gap-2">
      <a href={api.noteArchiveUrl(curFolder)} download className="btn btn-ghost h-8"
        title={curFolder ? `'${curFolder}' 폴더를 zip으로` : "전체 문서를 zip으로"}>
        <Download size={14} /> {curFolder ? "폴더 받기" : "전체 받기"}
      </a>
      <label className="btn btn-secondary h-8 cursor-pointer" title="현재 폴더에 파일 올리기">
        <Upload size={14} /> 업로드
        <input type="file" multiple className="hidden"
          onChange={(e) => { doUpload(e.target.files); e.currentTarget.value = ""; }} />
      </label>
    </div>
  );

  return (
    <Shell title="문서" actions={actions}>
      <ThreePane storageKey="notes.panes.v1" showDetail={!!current}>
        {/* 트리 */}
        {/* 모바일은 목록/문서를 번갈아 보여주므로 화면 높이를 다 쓴다.
            (max-h-80이면 목록만 띄운 화면에서 아래 절반이 빈다) */}
        <div className="card flex h-view-11 flex-col overflow-hidden lg:h-auto lg:max-h-none">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="label">문서 {notes.length}</span>
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

          {/* 현재 위치 (여기로 드래그하면 루트로 이동) */}
          <button onClick={() => setCurFolder("")}
            onDragOver={(e) => { e.preventDefault(); setDragOver(ROOT_DROP); }}
            onDragLeave={() => setDragOver((p) => (p === ROOT_DROP ? null : p))}
            onDrop={(e) => {
              e.preventDefault();
              const path = e.dataTransfer.getData("text/plain");
              setDragOver(null);
              if (path) doMoveNote(path, "");
            }}
            className={`flex items-center gap-1 border-b border-line px-3 py-1.5 text-left text-[11.5px] text-fg-muted hover:text-accent ${
              dragOver === ROOT_DROP ? "bg-accent-muted ring-1 ring-accent" : ""
            }`}
            title="루트로 (여기로 드래그하면 루트로 이동)">
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

          {/* 목록 전체가 루트 드롭 영역이다. 폴더·문서 행은 stopPropagation으로
              자기 드롭을 먼저 처리하므로, 빈 곳에 떨어뜨려야만 루트로 나온다.
              (전에는 상단의 얇은 "위치:" 줄 하나뿐이라 폴더 밖으로 빼기가 거의 불가능했다) */}
          <ul
            className={`flex-1 overflow-auto p-1 ${dragOver === ROOT_DROP ? "bg-accent-muted/40 ring-1 ring-inset ring-accent" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(ROOT_DROP); }}
            onDragLeave={(e) => {
              // 자식 사이를 오갈 때 깜빡이지 않도록, 목록 밖으로 나갈 때만 해제
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragOver((p) => (p === ROOT_DROP ? null : p));
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const path = e.dataTransfer.getData("text/plain");
              setDragOver(null);
              if (path && path.includes("/")) doMoveNote(path, "");  // 이미 루트면 무시
            }}
          >
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
                        <span className="truncate">{fileName(h.path)}</span>
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

        {/* 메인: 라이브 편집(입력=마크다운 뷰) ↔ 읽기 뷰(표·SVG 완전 렌더) 통합 */}
        {/* 높이를 확정해야 편집기가 **내부에서** 스크롤한다. 예전엔 min-h만 있어
            카드가 문서 길이만큼 자랐고(5600px), 그러면 absolute인 첨부 버튼과
            헤더(뒤로가기·읽기전환·삭제)가 문서 맨 끝/맨 앞에만 있어 못 쓴다. */}
        <div className="card relative flex h-view-11 flex-col overflow-hidden lg:h-auto lg:min-h-0">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium">
              {/* 모바일은 목록과 문서를 번갈아 보여주므로 돌아갈 길이 필요하다 */}
              <button
                onClick={closeNote}
                aria-label="문서 목록으로"
                className="-ml-1 shrink-0 rounded p-1 text-fg-muted hover:bg-hovered hover:text-fg lg:hidden"
              >
                <ChevronLeft size={16} />
              </button>
              <NotebookPen size={14} className="hidden shrink-0 text-accent lg:block" />
              <span className="truncate">
                {/* 확장자를 떼지 않는다 — 무엇을 열고 있는지가 확장자로 갈린다 */}
                {current ?? "문서를 선택하세요"}
              </span>
            </span>
            <div className="flex items-center gap-1">
              {saving ? <Loader2 size={13} className="animate-spin text-fg-muted" />
                : dirty ? <Save size={13} className="text-warning" />
                : current && isEditable ? <span className="label text-positive">저장됨</span> : null}
              {current && isEditable && (
                <button
                  onClick={() => {
                    const next = !reading;
                    setReading(next);
                    // 읽기 모드에서는 백링크가 최신이어야 한다(자동저장은 갱신을 건너뛴다)
                    if (next && current) api.noteGet(current).then(setDetail).catch(() => {});
                  }}
                  title="편집 / 읽기 전환"
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    reading ? "border-accent/40 bg-accent-muted text-accent-fg" : "border-line text-fg-muted hover:text-fg"
                  }`}>
                  {reading ? <><Eye size={11} /> 읽기</> : <><Pencil size={11} /> 편집</>}
                </button>
              )}
              {current && isEditable && (
                <a href={api.noteRawUrl(current, true)} download
                  className="btn btn-ghost h-7 px-2" title="이 문서 내려받기" aria-label="문서 다운로드">
                  <Download size={14} />
                </a>
              )}
              {current && (
                <button onClick={() => setDelOpen(true)} className="btn btn-ghost h-7 px-2 hover:text-danger" aria-label="문서 삭제">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>
          {!current ? (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-[13px] text-fg-muted">
              {/* 모바일에서는 목록이 왼쪽이 아니라 위에 쌓인다 */}
              <span className="sm:hidden">위 목록에서 문서를 선택하거나 새로 만드세요</span>
              <span className="hidden sm:inline">왼쪽에서 문서를 선택하거나 새로 만드세요</span>
            </div>
          ) : !isEditable ? (
            // 이미지·PDF·미디어 — 편집 대상이 아니므로 전용 뷰어로
            <div className="flex-1 overflow-hidden">
              <DocViewer path={current} kind={currentMeta!.kind} size={currentMeta!.size} />
            </div>
          ) : reading ? (
            <div className="flex-1 overflow-auto p-4">
              <MarkdownView content={content} onWikiClick={openByTitle} resolveEmbed={resolveEmbed} />
            </div>
          ) : (
            <LiveEditor
              value={content}
              onChange={onEdit}
              onSave={() => { if (current) save(current, content); }}
              titles={notes.map((n) => n.title)}
              docKey={current}
              resolveEmbed={resolveEmbed}
              onDropFiles={onDropFiles}
              onDropPath={onDropPath}
            />
          )}
          {/* current도 본다 — 닫은 뒤 늦게 도착한 save 응답이 detail을 다시 채울 수 있다 */}
          {current && detail && detail.backlinks.length > 0 && (
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
      </ThreePane>

      {/* 이름 변경 */}
      <Modal open={!!renameFor} onClose={() => setRenameFor(null)} title="이름 변경" width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={renameName} placeholder="새 이름"
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doRenameNote(); if (e.key === "Escape") setRenameFor(null); }} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setRenameFor(null)} className="btn btn-ghost">취소</button>
            <button onClick={doRenameNote} className="btn btn-primary">변경</button>
          </div>
        </div>
      </Modal>

      {/* 이동 */}
      <Modal open={!!moveFor} onClose={() => setMoveFor(null)} title="노트 이동" width="max-w-sm">
        <div className="space-y-3">
          <label className="block">
            <span className="label">대상 폴더</span>
            <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)}
              className="input mt-1 cursor-pointer">
              <option value="">(루트)</option>
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <button onClick={() => setMoveFor(null)} className="btn btn-ghost">취소</button>
            <button onClick={() => moveFor && doMoveNote(moveFor.path, moveTarget)} className="btn btn-primary">
              <FolderInput size={14} /> 이동
            </button>
          </div>
        </div>
      </Modal>

      {/* 개별 노트 삭제 확인 */}
      <Modal open={!!delNotePath} onClose={() => setDelNotePath(null)} title="노트 삭제" width="max-w-sm">
        <div className="space-y-4">
          <p className="text-[13.5px] text-fg2">이 노트를 휴지통으로 옮길까요? 휴지통에서 복원할 수 있습니다.</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDelNotePath(null)} className="btn btn-ghost">취소</button>
            <button onClick={doDeleteNotePath} className="btn btn-danger"><Trash2 size={14} /> 휴지통으로</button>
          </div>
        </div>
      </Modal>

      {/* 새 노트 모달 */}
      <Modal open={newNoteOpen} onClose={() => setNewNoteOpen(false)} title={`새 노트${curFolder ? ` · ${curFolder}` : ""}`} width="max-w-sm">
        <div className="space-y-3">
          <input autoFocus className="input" value={newName} placeholder="예: 회의록.md, todo.txt, script.py"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createNote(); if (e.key === "Escape") setNewNoteOpen(false); }} />
          <p className="text-[12px] text-fg-muted">
            확장자까지 적어 주세요. 안 적으면 확장자 없는 파일로 만들어집니다.
          </p>
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
