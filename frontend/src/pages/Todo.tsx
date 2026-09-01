import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Circle,
  CheckCircle2,
  Plus,
  Trash2,
  FolderPlus,
  Loader2,
  Pencil,
  X,
} from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { GCAL_COLORS, GCAL_COLOR_NAMES } from "../components/calendar/EventDialog";
import { api, Todo as TodoItem, TodoCategory, TodoCounts } from "../lib/api";
import { toast } from "../store/toast";
import { useMediaQuery } from "../lib/useMediaQuery";

/** 미분류를 담는 가짜 카테고리 id. 실제 저장값은 ""이다. */
const UNCATEGORIZED = "";

/** 마감 문자열 → 사람이 읽는 형태. 값이 없으면 빈 문자열. */
function dueLabel(due: string, allDay: boolean): string {
  if (!due) return "";
  const day = due.slice(0, 10);
  if (allDay || due.length <= 10) return day;
  return `${day} ${due.slice(11, 16)}`;
}

/** 오늘 기준 상대 표현 — 타임라인에서 "언제까지"가 한눈에 보이도록. */
function dueTone(due: string): { label: string; cls: string } {
  if (!due) return { label: "기한 없음", cls: "text-fg-subtle" };
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const d = new Date(`${due.slice(0, 10)}T00:00:00`).getTime();
  const days = Math.round((d - t0) / 86400000);
  if (days < 0) return { label: `${-days}일 지남`, cls: "text-danger" };
  if (days === 0) return { label: "오늘", cls: "text-accent-fg font-semibold" };
  if (days === 1) return { label: "내일", cls: "text-warning" };
  if (days <= 7) return { label: `${days}일 뒤`, cls: "text-fg-muted" };
  return { label: `${days}일 뒤`, cls: "text-fg-subtle" };
}

function colorOf(t: TodoItem, cats: TodoCategory[]): string {
  if (t.color) return t.color;
  const c = cats.find((x) => x.id === t.category_id);
  return c?.color || "2";
}

interface TreeNode {
  cat: TodoCategory;
  children: TreeNode[];
}

/** 평평한 카테고리 배열 → 트리. 부모가 사라진 항목은 최상위로 올려 화면에서 잃지 않는다. */
function buildTree(cats: TodoCategory[]): TreeNode[] {
  const byId = new Map(cats.map((c) => [c.id, { cat: c, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const c of cats) {
    const node = byId.get(c.id)!;
    const parent = c.parent_id ? byId.get(c.parent_id) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function Todo() {
  const [cats, setCats] = useState<TodoCategory[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [counts, setCounts] = useState<TodoCounts>({});
  const [selectedCat, setSelectedCat] = useState<string | null>(null); // null = 전체
  const [selectedTodo, setSelectedTodo] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const isNarrow = useMediaQuery("(max-width: 1023px)");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [c, t, n] = await Promise.all([
        api.todoCategories(),
        api.todoList(),
        api.todoCounts(),
      ]);
      setCats(c);
      setTodos(t);
      setCounts(n);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "할 일 로드 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const tree = useMemo(() => buildTree(cats), [cats]);

  /** 카테고리별 누계(자기 + 하위). 클릭하면 하위까지 보여주므로 배지도 그래야 한다 —
   *  직접 소속만 세면 "0/1"인데 열어 보니 3개가 나오는 어긋남이 생긴다. */
  const rollup = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const c of cats) {
      const k = kids.get(c.parent_id) ?? [];
      k.push(c.id);
      kids.set(c.parent_id, k);
    }
    const memo = new Map<string, { total: number; done: number }>();
    const walk = (id: string, seen: Set<string>): { total: number; done: number } => {
      const cached = memo.get(id);
      if (cached) return cached;
      if (seen.has(id)) return { total: 0, done: 0 }; // 손상된 데이터의 순환 방지
      seen.add(id);
      const self = counts[id] ?? { total: 0, done: 0 };
      let total = self.total;
      let done = self.done;
      for (const k of kids.get(id) ?? []) {
        const sub = walk(k, seen);
        total += sub.total;
        done += sub.done;
      }
      const out = { total, done };
      memo.set(id, out);
      return out;
    };
    const res: Record<string, { total: number; done: number }> = {};
    for (const c of cats) res[c.id] = walk(c.id, new Set());
    return res;
  }, [cats, counts]);

  /** 이 카테고리와 그 자손에 속한 할 일(트리를 클릭하면 하위까지 보여야 자연스럽다). */
  const descendantIds = useCallback(
    (cid: string): Set<string> => {
      const out = new Set<string>([cid]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const c of cats) {
          if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) {
            out.add(c.id);
            grew = true;
          }
        }
      }
      return out;
    },
    [cats],
  );

  const visible = useMemo(() => {
    if (selectedCat === null) return todos;
    const ids = descendantIds(selectedCat);
    return todos.filter((t) => ids.has(t.category_id || UNCATEGORIZED));
  }, [todos, selectedCat, descendantIds]);

  const detail = useMemo(
    () => todos.find((t) => t.id === selectedTodo) ?? null,
    [todos, selectedTodo],
  );

  // ── 조작 ──────────────────────────────────────────────────────────
  const guard = async (fn: () => Promise<unknown>, okMsg?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast.ok(okMsg);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  };

  const addTodo = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    guard(() =>
      api.todoCreate({
        title,
        category_id: selectedCat ?? UNCATEGORIZED,
      }),
    );
  };

  const addCategory = () => {
    const name = window.prompt(
      selectedCat ? "새 하위 카테고리 이름" : "새 카테고리 이름",
    );
    if (!name?.trim()) return;
    guard(
      () => api.todoCategoryCreate({ name: name.trim(), parent_id: selectedCat ?? "" }),
      "카테고리 추가됨",
    );
  };

  const toggleDone = (t: TodoItem) =>
    guard(() => api.todoUpdate(t.id, { done: !t.done }));

  const removeTodo = (t: TodoItem) =>
    guard(async () => {
      await api.todoDelete(t.id);
      setSelectedTodo(null);
    }, "휴지통으로 옮겼습니다");

  const patchDetail = (body: Partial<TodoItem>) => {
    if (!detail) return;
    guard(() => api.todoUpdate(detail.id, body));
  };

  const removeCategory = (c: TodoCategory) => {
    if (!window.confirm(`'${c.name}' 카테고리를 지울까요?\n안의 할 일은 지워지지 않고 위로 올라갑니다.`))
      return;
    guard(async () => {
      await api.todoCategoryDelete(c.id);
      if (selectedCat === c.id) setSelectedCat(null);
    }, "카테고리 삭제됨");
  };

  const renameCategory = (c: TodoCategory) => {
    const name = window.prompt("카테고리 이름", c.name);
    if (!name?.trim() || name.trim() === c.name) return;
    guard(() => api.todoCategoryUpdate(c.id, { name: name.trim() }));
  };

  // ── 왼쪽: 카테고리 트리 ───────────────────────────────────────────
  const CatRow = ({ node, depth }: { node: TreeNode; depth: number }) => {
    const { cat } = node;
    const n = rollup[cat.id] ?? { total: 0, done: 0 };
    const hasKids = node.children.length > 0;
    const isOpen = open.has(cat.id);
    const active = selectedCat === cat.id;
    return (
      <div>
        <div
          className={`group flex items-center gap-1 rounded-md pr-1 text-sm ${
            active ? "bg-accent-muted text-accent-fg" : "hover:bg-hovered"
          }`}
          style={{ paddingLeft: 4 + depth * 12 }}
        >
          <button
            type="button"
            aria-label={hasKids ? (isOpen ? "접기" : "펼치기") : undefined}
            onClick={() =>
              setOpen((prev) => {
                const next = new Set(prev);
                next.has(cat.id) ? next.delete(cat.id) : next.add(cat.id);
                return next;
              })
            }
            className={`grid h-5 w-5 shrink-0 place-items-center text-fg-subtle ${
              hasKids ? "" : "invisible"
            }`}
          >
            <ChevronRight size={13} className={isOpen ? "rotate-90 transition-transform" : "transition-transform"} />
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedCat(cat.id);
              setSelectedTodo(null);
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: GCAL_COLORS[cat.color] ?? GCAL_COLORS["2"] }}
            />
            <span className="truncate">{cat.name}</span>
            <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">
              {n.total - n.done}/{n.total}
            </span>
          </button>
          <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={() => renameCategory(cat)}
              title="이름 바꾸기"
              className="grid h-6 w-6 place-items-center text-fg-subtle hover:text-fg"
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              onClick={() => removeCategory(cat)}
              title="카테고리 삭제"
              className="grid h-6 w-6 place-items-center text-fg-subtle hover:text-danger"
            >
              <X size={13} />
            </button>
          </span>
        </div>
        {hasKids && isOpen && (
          <div>
            {node.children.map((k) => (
              <CatRow key={k.cat.id} node={k} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  };

  const uncategorized = counts[UNCATEGORIZED] ?? { total: 0, done: 0 };
  const allTotal = todos.length;
  const allDone = todos.filter((t) => t.done).length;

  const leftPane = (
    <div className="card flex min-h-0 flex-col p-3 lg:h-view-9 lg:w-[280px] lg:shrink-0">
      <div className="mb-2 flex items-center justify-between border-b border-line/50 pb-2">
        <span className="text-sm font-semibold">카테고리</span>
        <button
          type="button"
          onClick={addCategory}
          title={selectedCat ? "선택한 카테고리 아래에 추가" : "카테고리 추가"}
          className="grid h-7 w-7 place-items-center rounded-md text-fg-muted hover:bg-hovered hover:text-fg"
        >
          <FolderPlus size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <button
          type="button"
          onClick={() => {
            setSelectedCat(null);
            setSelectedTodo(null);
          }}
          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm ${
            selectedCat === null ? "bg-accent-muted text-accent-fg" : "hover:bg-hovered"
          }`}
        >
          전체
          <span className="ml-auto text-[11px] text-fg-subtle">
            {allTotal - allDone}/{allTotal}
          </span>
        </button>
        {tree.map((n) => (
          <CatRow key={n.cat.id} node={n} depth={0} />
        ))}
        {uncategorized.total > 0 && (
          <button
            type="button"
            onClick={() => {
              setSelectedCat(UNCATEGORIZED);
              setSelectedTodo(null);
            }}
            className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm ${
              selectedCat === UNCATEGORIZED ? "bg-accent-muted text-accent-fg" : "hover:bg-hovered"
            }`}
            style={{ paddingLeft: 4 + 20 }}
          >
            <span className="truncate text-fg-muted">미분류</span>
            <span className="ml-auto text-[11px] text-fg-subtle">
              {uncategorized.total - uncategorized.done}/{uncategorized.total}
            </span>
          </button>
        )}
      </div>
    </div>
  );

  // ── 오른쪽: 타임라인 또는 상세 ────────────────────────────────────
  const timeline = (
    <div className="min-h-0 flex-1 overflow-auto pr-1">
      {visible.length === 0 ? (
        <p className="px-1 py-6 text-sm text-fg-subtle">할 일이 없습니다. 아래에서 추가하세요.</p>
      ) : (
        <ol className="relative ml-2 border-l border-line pl-4">
          {visible.map((t) => {
            const tone = dueTone(t.due);
            const hex = GCAL_COLORS[colorOf(t, cats)] ?? GCAL_COLORS["2"];
            return (
              <li key={t.id} className="relative py-1.5">
                <span
                  className="absolute -left-[21px] top-3 h-2.5 w-2.5 rounded-full ring-2 ring-surface"
                  style={{ background: t.done ? "rgb(var(--fg-subtle))" : hex }}
                />
                <div
                  className={`group flex items-start gap-2 rounded-md px-2 py-1.5 ${
                    selectedTodo === t.id ? "bg-accent-muted" : "hover:bg-hovered"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleDone(t)}
                    title={t.done ? "미완료로" : "완료"}
                    className="mt-0.5 shrink-0 text-fg-subtle hover:text-accent"
                  >
                    {t.done ? (
                      <CheckCircle2 size={16} className="text-accent" />
                    ) : (
                      <Circle size={16} />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedTodo(t.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div
                      className={`truncate text-sm ${
                        t.done ? "text-fg-subtle line-through" : "text-fg"
                      }`}
                    >
                      {t.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                      <span className={t.done ? "text-fg-subtle" : tone.cls}>
                        {t.due ? `${dueLabel(t.due, t.all_day)} · ${tone.label}` : tone.label}
                      </span>
                    </div>
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );

  const detailPane = detail && (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mb-3 flex items-start gap-2">
        <button
          type="button"
          onClick={() => toggleDone(detail)}
          className="mt-1 shrink-0 text-fg-subtle hover:text-accent"
          title={detail.done ? "미완료로" : "완료"}
        >
          {detail.done ? <CheckCircle2 size={20} className="text-accent" /> : <Circle size={20} />}
        </button>
        <input
          className="input flex-1 text-base font-semibold"
          defaultValue={detail.title}
          key={`title-${detail.id}`}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== detail.title) patchDetail({ title: v });
          }}
        />
        <button
          type="button"
          onClick={() => removeTodo(detail)}
          title="삭제(휴지통으로)"
          className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-hovered hover:text-danger"
        >
          <Trash2 size={15} />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">마감 날짜</span>
          <input
            type="date"
            className="input"
            key={`date-${detail.id}`}
            defaultValue={detail.due ? detail.due.slice(0, 10) : ""}
            onChange={(e) => {
              const day = e.target.value;
              if (!day) return patchDetail({ due: "", all_day: false });
              // 시각이 이미 있으면 유지한다 — 날짜만 고쳤는데 시간이 날아가면 안 된다
              const time = detail.due.length > 10 ? detail.due.slice(10) : "";
              patchDetail({ due: `${day}${time}`, all_day: !time });
            }}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">마감 시각</span>
          <input
            type="time"
            className="input"
            key={`time-${detail.id}`}
            defaultValue={detail.due.length > 10 ? detail.due.slice(11, 16) : ""}
            disabled={!detail.due}
            onChange={(e) => {
              if (!detail.due) return;
              const day = detail.due.slice(0, 10);
              const v = e.target.value;
              patchDetail(v ? { due: `${day}T${v}:00`, all_day: false } : { due: day, all_day: true });
            }}
          />
        </label>
      </div>

      <div className="mt-3">
        <span className="mb-1 block text-xs text-fg-muted">카테고리</span>
        <select
          className="input"
          key={`cat-${detail.id}`}
          defaultValue={detail.category_id}
          onChange={(e) => patchDetail({ category_id: e.target.value })}
        >
          <option value="">(미분류)</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3">
        <span className="mb-1 block text-xs text-fg-muted">색상</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => patchDetail({ color: "" })}
            title="카테고리 색 따르기"
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              detail.color === "" ? "border-accent bg-accent-muted text-accent-fg" : "border-line text-fg-muted"
            }`}
          >
            자동
          </button>
          {Object.entries(GCAL_COLORS).map(([id, hex]) => (
            <button
              key={id}
              type="button"
              onClick={() => patchDetail({ color: id })}
              aria-label={GCAL_COLOR_NAMES[id]}
              title={GCAL_COLOR_NAMES[id]}
              className={`h-5 w-5 rounded-full border-2 ${
                detail.color === id ? "border-fg" : "border-transparent"
              }`}
              style={{ background: hex }}
            />
          ))}
        </div>
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-fg-muted">설명</span>
        <textarea
          className="input h-auto py-2"
          rows={5}
          key={`desc-${detail.id}`}
          defaultValue={detail.description}
          onBlur={(e) => {
            if (e.target.value !== detail.description) patchDetail({ description: e.target.value });
          }}
        />
      </label>
    </div>
  );

  const rightPane = (
    <div className="card flex min-h-0 flex-1 flex-col p-4 lg:h-view-9">
      <div className="mb-2 flex items-center gap-2 border-b border-line/50 pb-2">
        {detail ? (
          <>
            <button
              type="button"
              onClick={() => setSelectedTodo(null)}
              className="text-sm text-fg-muted hover:text-fg"
            >
              ← 목록
            </button>
            <span className="text-sm font-semibold">할 일 상세</span>
          </>
        ) : (
          <span className="text-sm font-semibold">
            {selectedCat === null
              ? "전체"
              : selectedCat === UNCATEGORIZED
                ? "미분류"
                : cats.find((c) => c.id === selectedCat)?.name}
            <span className="ml-2 text-[11px] font-normal text-fg-subtle">{visible.length}개</span>
          </span>
        )}
        {loading && <Loader2 size={13} className="ml-auto animate-spin text-fg-muted" />}
      </div>

      {detail ? detailPane : timeline}

      {!detail && (
        <div className="mt-2 flex items-center gap-2 border-t border-line/50 pt-2">
          <input
            className="input flex-1"
            placeholder="할 일 추가 후 Enter"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addTodo();
            }}
          />
          <button
            type="button"
            onClick={addTodo}
            disabled={busy || !draft.trim()}
            className="btn-primary grid h-9 w-9 place-items-center p-0 disabled:opacity-50"
            title="추가"
          >
            <Plus size={16} />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <Shell
      title="할 일"
      actions={<span className="badge">내부 저장</span>}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
        {/* 좁은 화면에서는 카테고리를 접어 두지 않고 위에 얹는다 — 캘린더와 같은 방식 */}
        <div className={isNarrow ? "max-h-[32vh]" : ""}>{leftPane}</div>
        <div className="flex min-h-0 flex-1 flex-col h-[60vh] lg:h-auto">{rightPane}</div>
      </div>
    </Shell>
  );
}
