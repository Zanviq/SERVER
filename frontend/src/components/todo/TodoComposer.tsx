import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronDown, Clock, Folder, Loader2, Palette, Plus, X } from "lucide-react";
import { Dropdown, DropdownItem } from "../ui/Dropdown";
import { GCAL_COLORS, GCAL_COLOR_NAMES } from "../calendar/EventDialog";
import type { Todo, TodoCategory } from "../../lib/api";
import { isSubmitEnter } from "../../lib/keys";

export interface TodoDraft {
  title: string;
  description: string;
  /** YYYY-MM-DD 또는 "" */
  date: string;
  /** HH:MM 또는 "" */
  time: string;
  category_id: string;
  /** "" = 카테고리 색 따름 */
  color: string;
}

export const EMPTY_DRAFT: Omit<TodoDraft, "category_id"> = {
  title: "", description: "", date: "", time: "", color: "",
};

/** 초안 → 서버에 보낼 본문. 시각만 있고 날짜가 없는 일은 위에서 막는다. */
export function draftToBody(d: TodoDraft): Partial<Todo> {
  const due = d.date ? (d.time ? `${d.date}T${d.time}:00` : d.date) : "";
  return {
    title: d.title.trim(),
    description: d.description.trim(),
    category_id: d.category_id,
    color: d.color,
    due,
    all_day: !!d.date && !d.time,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

function dateLabel(date: string): string {
  if (!date) return "마감 날짜";
  const today = ymd(new Date());
  if (date === today) return "오늘";
  if (date === addDays(1)) return "내일";
  const d = new Date(`${date}T00:00:00`);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const base = `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAY[d.getDay()]})`;
  return sameYear ? base : `${d.getFullYear()}.${base}`;
}

function timeLabel(time: string): string {
  if (!time) return "마감 시각";
  const [h, m] = time.split(":").map(Number);
  const ampm = h < 12 ? "오전" : "오후";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${ampm} ${hh}:${pad(m)}` : `${ampm} ${hh}시`;
}

const QUICK_TIMES = ["09:00", "12:00", "14:00", "18:00", "21:00"];

interface Props {
  cats: TodoCategory[];
  /** 사이드바에서 고른 카테고리(null=전체). 초안의 기본 카테고리가 된다. */
  selectedCat: string | null;
  busy: boolean;
  onSubmit: (draft: TodoDraft) => Promise<boolean>;
}

/** 카테고리 트리를 들여쓰기 순서로 편다(드롭다운 목록용). */
function flattenCats(cats: TodoCategory[]): { cat: TodoCategory; depth: number }[] {
  const kids = new Map<string, TodoCategory[]>();
  for (const c of cats) {
    const k = kids.get(c.parent_id) ?? [];
    k.push(c);
    kids.set(c.parent_id, k);
  }
  const byId = new Set(cats.map((c) => c.id));
  const out: { cat: TodoCategory; depth: number }[] = [];
  const walk = (parent: string, depth: number, seen: Set<string>) => {
    for (const c of kids.get(parent) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ cat: c, depth });
      walk(c.id, depth + 1, seen);
    }
  };
  // 부모가 사라진 항목도 최상위로 올려 잃지 않는다
  const roots = cats.filter((c) => !c.parent_id || !byId.has(c.parent_id));
  const seen = new Set<string>();
  for (const r of roots) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ cat: r, depth: 0 });
    walk(r.id, 1, seen);
  }
  return out;
}

/**
 * 할 일 추가 입력칸.
 *
 * 맨 위에 마감 날짜·시각·카테고리·색상 버튼이 가로로 놓이고 각각 드롭다운으로
 * 고른다. 그 아래 제목, 그 아래 설명. 제목에서 Enter 로 추가된다.
 */
export function TodoComposer({ cats, selectedCat, busy, onSubmit }: Props) {
  const [draft, setDraft] = useState<TodoDraft>({ ...EMPTY_DRAFT, category_id: selectedCat ?? "" });
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // 사이드바에서 카테고리를 바꾸면 초안의 카테고리도 따라간다(아직 손대지 않았을 때)
  useEffect(() => {
    setDraft((d) => ({ ...d, category_id: selectedCat ?? "" }));
  }, [selectedCat]);

  const flat = useMemo(() => flattenCats(cats), [cats]);
  const set = (patch: Partial<TodoDraft>) => setDraft((d) => ({ ...d, ...patch }));

  // 설명은 내용에 맞춰 늘어난다(한 줄로 시작)
  useEffect(() => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft.description]);

  const canSubmit = !!draft.title.trim() && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    const ok = await onSubmit(draft);
    if (ok) {
      // 카테고리는 사이드바 선택을 따르므로 남기고, 나머지는 비운다
      setDraft((d) => ({ ...EMPTY_DRAFT, category_id: d.category_id }));
      titleRef.current?.focus();
    }
  };

  const catName = draft.category_id
    ? (cats.find((c) => c.id === draft.category_id)?.name ?? "카테고리")
    : "카테고리";
  const catColor = cats.find((c) => c.id === draft.category_id)?.color;
  const colorHex = draft.color ? GCAL_COLORS[draft.color] : catColor ? GCAL_COLORS[catColor] : undefined;

  const chip = (active: boolean) =>
    `inline-flex h-7 max-w-[11rem] items-center gap-1 rounded-full border px-2.5 text-[12px] transition-colors ${
      active
        ? "border-accent/40 bg-accent-muted text-accent-fg"
        : "border-line text-fg-muted hover:border-line-strong hover:text-fg"
    }`;

  return (
    <div className="mt-2 border-t border-line/50 pt-2">
      {/* 1행: 속성 버튼들 */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Dropdown
          className={chip(!!draft.date)}
          width={230}
          trigger={() => (
            <>
              <CalendarDays size={13} />
              <span className="truncate">{dateLabel(draft.date)}</span>
              {draft.date ? (
                <span
                  role="button"
                  aria-label="마감 날짜 지우기"
                  onClick={(e) => { e.stopPropagation(); set({ date: "", time: "" }); }}
                  className="-mr-1 grid h-4 w-4 place-items-center rounded-full hover:bg-accent/20"
                >
                  <X size={11} />
                </span>
              ) : <ChevronDown size={12} className="opacity-60" />}
            </>
          )}
        >
          {(close) => (
            <div>
              {[
                ["오늘", addDays(0)], ["내일", addDays(1)], ["모레", addDays(2)], ["다음 주", addDays(7)],
              ].map(([label, v]) => (
                <DropdownItem key={v} active={draft.date === v} onClick={() => { set({ date: v }); close(); }}>
                  <span className="flex-1">{label}</span>
                  <span className="text-[11px] text-fg-subtle">{dateLabel(v) === label ? v.slice(5) : dateLabel(v)}</span>
                </DropdownItem>
              ))}
              <div className="my-1 border-t border-line/60" />
              <label className="block px-2 py-1.5">
                <span className="mb-1 block text-[11px] text-fg-muted">날짜 직접 고르기</span>
                <input
                  type="date"
                  className="input h-8"
                  value={draft.date}
                  onChange={(e) => { set({ date: e.target.value }); if (e.target.value) close(); }}
                />
              </label>
              {draft.date && (
                <DropdownItem onClick={() => { set({ date: "", time: "" }); close(); }} className="text-fg-muted">
                  기한 없음
                </DropdownItem>
              )}
            </div>
          )}
        </Dropdown>

        <Dropdown
          className={chip(!!draft.time)}
          width={210}
          trigger={() => (
            <>
              <Clock size={13} />
              <span className="truncate">{timeLabel(draft.time)}</span>
              {draft.time ? (
                <span
                  role="button"
                  aria-label="마감 시각 지우기"
                  onClick={(e) => { e.stopPropagation(); set({ time: "" }); }}
                  className="-mr-1 grid h-4 w-4 place-items-center rounded-full hover:bg-accent/20"
                >
                  <X size={11} />
                </span>
              ) : <ChevronDown size={12} className="opacity-60" />}
            </>
          )}
        >
          {(close) => (
            <div>
              {!draft.date && (
                <p className="px-2 py-1 text-[11px] text-fg-subtle">날짜가 없으면 오늘로 잡힙니다</p>
              )}
              {QUICK_TIMES.map((t) => (
                <DropdownItem
                  key={t}
                  active={draft.time === t}
                  onClick={() => { set({ time: t, date: draft.date || addDays(0) }); close(); }}
                >
                  <span className="flex-1">{timeLabel(t)}</span>
                  <span className="text-[11px] text-fg-subtle">{t}</span>
                </DropdownItem>
              ))}
              <div className="my-1 border-t border-line/60" />
              <label className="block px-2 py-1.5">
                <span className="mb-1 block text-[11px] text-fg-muted">시각 직접 고르기</span>
                <input
                  type="time"
                  className="input h-8"
                  value={draft.time}
                  onChange={(e) => {
                    const v = e.target.value;
                    set({ time: v, date: v ? draft.date || addDays(0) : draft.date });
                  }}
                />
              </label>
              {draft.time && (
                <DropdownItem onClick={() => { set({ time: "" }); close(); }} className="text-fg-muted">
                  시각 없음(종일)
                </DropdownItem>
              )}
            </div>
          )}
        </Dropdown>

        <Dropdown
          className={chip(!!draft.category_id)}
          width={230}
          trigger={() => (
            <>
              <Folder size={13} />
              <span className="truncate">{catName}</span>
              <ChevronDown size={12} className="opacity-60" />
            </>
          )}
        >
          {(close) => (
            <div>
              <DropdownItem active={!draft.category_id} onClick={() => { set({ category_id: "" }); close(); }}>
                <span className="text-fg-muted">(미분류)</span>
              </DropdownItem>
              {flat.length === 0 && (
                <p className="px-2 py-1.5 text-[11px] text-fg-subtle">카테고리가 없습니다. 왼쪽에서 추가하세요.</p>
              )}
              {flat.map(({ cat, depth }) => (
                <DropdownItem
                  key={cat.id}
                  active={draft.category_id === cat.id}
                  onClick={() => { set({ category_id: cat.id }); close(); }}
                >
                  <span style={{ paddingLeft: depth * 12 }} className="flex min-w-0 items-center gap-1.5">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: GCAL_COLORS[cat.color] ?? GCAL_COLORS["2"] }} />
                    <span className="truncate">{cat.name}</span>
                  </span>
                </DropdownItem>
              ))}
            </div>
          )}
        </Dropdown>

        <Dropdown
          className={chip(!!draft.color)}
          width={200}
          trigger={() => (
            <>
              {colorHex ? (
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: colorHex }} />
              ) : (
                <Palette size={13} />
              )}
              <span className="truncate">{draft.color ? GCAL_COLOR_NAMES[draft.color] : "색상"}</span>
              <ChevronDown size={12} className="opacity-60" />
            </>
          )}
        >
          {(close) => (
            <div>
              <DropdownItem active={!draft.color} onClick={() => { set({ color: "" }); close(); }}>
                <span className="h-3 w-3 rounded-full border border-dashed border-line-strong" />
                자동(카테고리 색)
              </DropdownItem>
              <div className="my-1 border-t border-line/60" />
              <div className="grid grid-cols-6 gap-1 p-1">
                {Object.entries(GCAL_COLORS).map(([id, hex]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => { set({ color: id }); close(); }}
                    aria-label={GCAL_COLOR_NAMES[id]}
                    title={GCAL_COLOR_NAMES[id]}
                    aria-pressed={draft.color === id}
                    className={`grid h-7 w-7 place-items-center rounded-full border-2 ${
                      draft.color === id ? "border-fg" : "border-transparent hover:border-line-strong"
                    }`}
                  >
                    <span className="h-4 w-4 rounded-full" style={{ background: hex }} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </Dropdown>
      </div>

      {/* 2·3행: 제목, 설명 — 하나의 상자로 묶는다 */}
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-line bg-surface transition-colors focus-within:border-accent">
          <input
            ref={titleRef}
            className="h-9 w-full bg-transparent px-3 text-[13.5px] text-fg outline-none placeholder:text-fg-subtle"
            placeholder="할 일 이름 (Enter 로 추가)"
            aria-label="할 일 이름"
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            onKeyDown={(e) => {
              if (isSubmitEnter(e)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="mx-3 border-t border-line/50" />
          <textarea
            ref={descRef}
            className="w-full resize-none bg-transparent px-3 py-2 text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle"
            placeholder="설명 (선택)"
            aria-label="할 일 설명"
            rows={1}
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
            onKeyDown={(e) => {
              // 설명에서는 Ctrl/⌘+Enter 로 추가(Enter 는 줄바꿈)
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="btn-primary grid h-9 w-9 shrink-0 place-items-center rounded-md p-0 disabled:opacity-50"
          title="추가"
          aria-label="할 일 추가"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
        </button>
      </div>
    </div>
  );
}
