import { ReactNode, RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, ChevronUp, Link2, X } from "lucide-react";
import type { LinkItem } from "../../lib/api";
import { applyPick, linkQueryAt } from "../../lib/links";
import { continueList } from "../../lib/mdInput";
import type { LinkQuery } from "../../lib/links";
import { linkIcon } from "./LinkChip";
import { cachedLinkPage, fetchLinkPage, linkMoreNote } from "./linkFetch";
import type { LinkPage } from "./linkFetch";
import { useMediaQuery } from "../../lib/useMediaQuery";

/** 접어 둔 채로 두었으면 다음에도 접힌 채로 뜬다(가리는 게 싫은 사람은 계속 싫다). */
const COLLAPSE_KEY = "links.suggest.collapsed";

type Field = HTMLTextAreaElement | HTMLInputElement;

interface Pos {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxH: number;
}

/** 리액트가 모르게 값을 바꾸면 onChange 가 안 불린다. 원래 setter 로 넣고 input 을 쏜다. */
function setNativeValue(el: Field, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
}

export interface InputOptions {
  /** 이 칸에서 줄을 바꾸는 키. 채팅처럼 Enter 가 '보내기'인 칸은 "shift+enter". */
  newline?: "enter" | "shift+enter";
}

/**
 * 여러 줄 입력칸의 마크다운 쓰기 도움 — 모든 입력칸이 이 하나를 쓴다.
 *
 *  1) `[` 를 치면 **입력칸 위로** 링크 후보를 띄운다(접기·닫기, 접은 상태는 기억).
 *  2) 목록·인용 줄에서 줄을 바꾸면 표시를 잇는다(lib/mdInput, 문서 편집기와 같은 규칙).
 *
 * 입력칸에 이벤트를 직접 건다(부르는 쪽은 `{panel}` 만 그리면 된다). 그래서
 * 입력칸이 제 onKeyDown 으로 Enter 를 '보내기'에 쓰고 있어도, 후보가 열려 있을
 * 때의 Enter 는 여기서 먼저 받아 멈춘다 — 리액트의 onKeyDown 은 문서 뿌리에서
 * 돌므로 입력칸에 직접 건 것이 먼저다. Esc 도 같아서 대화상자가 함께 닫히지 않는다.
 * 예전 이름은 useLinkSuggest 였다(목록 잇기를 맡으며 이름을 하는 일에 맞췄다).
 */

export function useMarkdownInput(ref: RefObject<Field>, opts: InputOptions = {}): ReactNode {
  const [q, setQ] = useState<LinkQuery | null>(null);
  const [items, setItems] = useState<LinkItem[]>([]);
  // 상한에 걸려 안 보인 후보 수("N개 더" 한 줄로 알린다)
  const [more, setMore] = useState(0);
  // 휴대폰에는 ↑↓·Enter·Esc 가 없다 — 할 수 없는 조작을 안내하지 않는다(14차)
  const touch = useMediaQuery("(pointer: coarse)");
  /** items 가 어느 글자에 대한 답인가. 새로 묻는 동안에는 옛 목록을 그대로 보여
   *  주지만(깜빡이지 않게) 키보드로는 고르지 않는다 — 옛 답을 넣게 된다. */
  const [itemsFor, setItemsFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 후보가 오기 전에 Enter 를 눌렀다 — 오면 첫 후보를 넣는다(빠르게 치는 사람) */
  const pendingPick = useRef(false);
  const [active, setActive] = useState(0);
  const [collapsed, setCollapsedState] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [pos, setPos] = useState<Pos | null>(null);
  /** Esc·닫기로 치운 `[` 의 자리. 그 괄호 안에서는 다시 띄우지 않는다. */
  const dismissed = useRef<number | null>(null);
  const seq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
  };

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 320), vw - 16);
    const left = Math.min(Math.max(8, r.left), vw - width - 8);
    const roomAbove = r.top - 8;
    const roomBelow = vh - r.bottom - 8;
    // 위가 기본이다(입력칸 위로). 위에 자리가 모자랄 때만 아래로 편다.
    if (roomAbove >= 160 || roomAbove >= roomBelow) {
      setPos({ left, width, bottom: vh - r.top + 6, maxH: Math.min(300, roomAbove - 6) });
    } else {
      setPos({ left, width, top: r.bottom + 6, maxH: Math.min(300, roomBelow - 6) });
    }
  }, [ref]);

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el || document.activeElement !== el) {
      setQ(null);
      return;
    }
    const caret = el.selectionStart ?? 0;
    const hit = caret === el.selectionEnd ? linkQueryAt(el.value, caret) : null;
    if (!hit) dismissed.current = null; // 괄호를 벗어났다 — 다음 `[` 에서는 다시 뜬다
    if (!hit || dismissed.current === hit.start) {
      setQ(null);
      return;
    }
    setQ((prev) =>
      prev && prev.start === hit.start && prev.end === hit.end && prev.query === hit.query ? prev : hit);
    place();
  }, [ref, place]);

  const dismiss = useCallback(() => {
    setQ((cur) => {
      if (cur) dismissed.current = cur.start;
      return null;
    });
  }, []);

  const pick = useCallback((it: LinkItem, cur: LinkQuery) => {
    const el = ref.current;
    if (!el) return;
    const next = applyPick(el.value, cur, it.path, it.folder);
    setNativeValue(el, next.text);
    el.focus();
    el.setSelectionRange(next.caret, next.caret);
    // 커서를 먼저 옮긴 뒤에 알린다 — 그래야 onChange·sync 가 새 자리를 본다
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (!it.folder) setQ(null);
  }, [ref]);

  // 이벤트 처리기는 매번 새 값을 봐야 한다. 입력칸에는 한 번만 걸고 이 ref 로 부른다.
  const newline = opts.newline ?? "enter";
  const live = useRef({ q, items, itemsFor, active, collapsed, sync, pick, dismiss, newline });
  live.current = { q, items, itemsFor, active, collapsed, sync, pick, dismiss, newline };

  const el = ref.current;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // **한 박자 늦게** 본다. 이 처리기는 입력칸에 직접 걸려 리액트의 onChange 보다
    // 먼저 돈다. 여기서 바로 상태를 바꾸면 리액트가 그 사이(마이크로태스크)에 다시
    // 그리면서 제어되는 입력칸을 **아직 안 바뀐 값으로 되돌린다** — 방금 친 `[` 가
    // 사라졌다(실측). onChange 가 끝난 뒤에 보면 그런 일이 없다.
    const onInput = () => window.setTimeout(() => live.current.sync(), 0);
    const onBlur = () => setQ(null);
    /** 링크 후보가 이 키를 먹었는가(먹었으면 true — 뒤의 처리는 하지 않는다) */
    const linkKeys = (e: KeyboardEvent): boolean => {
      const s = live.current;
      if (!s.q) return false;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
        return true;
      };
      if (e.key === "Escape") {
        s.dismiss();
        return stop();
      }
      if (s.collapsed) return false;
      const pickKey = (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)
                      || (e.key === "Tab" && !e.shiftKey);
      if (s.itemsFor !== s.q.query) {
        // 아직 이 글자에 대한 답이 없다. 여기서 Enter 를 흘려보내면 채팅에서는
        // 치다 만 `[note/서` 가 그대로 **보내진다**. 붙잡아 뒀다가 답이 오면 넣는다.
        if (!pickKey) return false;
        pendingPick.current = true;
        return stop();
      }
      const n = s.items.length;
      if (n === 0) return false;
      if (e.key === "ArrowDown") {
        setActive((a) => (a + 1) % n);
        return stop();
      }
      if (e.key === "ArrowUp") {
        setActive((a) => (a - 1 + n) % n);
        return stop();
      }
      if (pickKey) {
        s.pick(s.items[Math.min(s.active, n - 1)], s.q);
        return stop();
      }
      return false;
    };

    /** 목록·인용 줄에서 줄을 바꾸면 표시를 잇는다(문서 편집기와 같은 규칙) */
    const listKeys = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey) return;
      // 이 칸에서 '줄바꿈'인 키에서만 — 채팅은 Enter 가 보내기라 Shift+Enter 다
      if (live.current.newline === "shift+enter" ? !e.shiftKey : e.shiftKey) return;
      const el = ref.current;
      if (!el || el.readOnly || el.disabled || el.selectionStart !== el.selectionEnd) return;
      const next = continueList(el.value, el.selectionStart ?? 0);
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      setNativeValue(el, next.text);
      el.setSelectionRange(next.caret, next.caret);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const onKey = (ev: Event) => {
      const e = ev as KeyboardEvent;
      // 한글 조합 중의 Enter 는 글자를 끝내는 것이다 — 가로채면 마지막 글자가 사라진다
      if (e.isComposing || e.keyCode === 229) return;
      if (linkKeys(e)) return;
      listKeys(e);
    };
    node.addEventListener("keydown", onKey);
    node.addEventListener("input", onInput);
    node.addEventListener("click", onInput);
    node.addEventListener("keyup", onInput);
    node.addEventListener("compositionend", onInput);
    node.addEventListener("blur", onBlur);
    return () => {
      node.removeEventListener("keydown", onKey);
      node.removeEventListener("input", onInput);
      node.removeEventListener("click", onInput);
      node.removeEventListener("keyup", onInput);
      node.removeEventListener("compositionend", onInput);
      node.removeEventListener("blur", onBlur);
    };
    // 입력칸 요소가 바뀌었을 때만 다시 건다(처리기는 live 로 늘 새 값을 본다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, ref]);

  // 후보 받아 오기 — 타자마다 묻지 않게 잠깐 기다리고, 늦게 온 옛 답은 버린다
  const query = q?.query;
  useEffect(() => {
    if (query === undefined) {
      pendingPick.current = false; // 닫혔다 — 붙잡아 둔 Enter 도 버린다
      return;
    }
    const my = ++seq.current;
    const receive = ({ items: got, more: rest }: LinkPage) => {
      setItems(got);
      setMore(rest);
      setItemsFor(query);
      setActive(0);
      if (!pendingPick.current) return;
      pendingPick.current = false;
      const cur = live.current.q;
      if (got.length && cur && cur.query === query) pick(got[0], cur);
    };
    const hit = cachedLinkPage(query);
    if (hit) {
      receive(hit);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = window.setTimeout(() => {
      fetchLinkPage(query)
        .then((got) => {
          if (my === seq.current) receive(got);
        })
        .catch(() => {
          if (my === seq.current) receive({ items: [], more: 0 });
        })
        .finally(() => {
          if (my === seq.current) setLoading(false);
        });
    }, 120);
    return () => window.clearTimeout(t);
  }, [query]);

  // 열려 있는 동안 화면이 움직이면 따라간다
  const open = q !== null;
  useEffect(() => {
    if (!open) return;
    const on = () => place();
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
    };
  }, [open, place]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!q || !pos) return null;
  const style: React.CSSProperties = {
    position: "fixed", left: pos.left, width: pos.width, zIndex: 60,
    ...(pos.bottom !== undefined ? { bottom: pos.bottom } : { top: pos.top }),
  };

  return createPortal(
    <div
      style={style}
      // 눌러도 입력칸의 포커스를 뺏지 않는다(뺏기면 blur 로 후보가 닫힌다)
      onMouseDown={(e) => e.preventDefault()}
      className={`flex ${pos.bottom !== undefined ? "flex-col justify-end" : "flex-col"}`}
    >
      {collapsed ? (
        <div className="inline-flex w-fit items-center gap-0.5 rounded-full border border-line bg-surface py-0.5 pl-2.5 pr-1 text-[11.5px] text-fg-muted shadow-md">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="inline-flex items-center gap-1 hover:text-fg"
            title="링크 후보 펼치기"
          >
            <Link2 size={12} />
            링크 후보 {loading && items.length === 0 ? "…" : `${items.length}개`}
            <ChevronUp size={12} />
            펼치기
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="링크 후보 닫기"
            className="grid h-5 w-5 place-items-center rounded-full hover:bg-hovered hover:text-fg"
          >
            <X size={11} />
          </button>
        </div>
      ) : (
        <div className="card flex flex-col overflow-hidden shadow-lg" style={{ maxHeight: pos.maxH }}>
          <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5 text-[11.5px] text-fg-muted">
            <Link2 size={12} className="shrink-0" />
            <span className="min-w-0 truncate">
              링크 <span className="font-mono text-fg">[{q.query}</span>
            </span>
            <span className="ml-auto" />
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              title="후보를 접는다(다음에도 접힌 채로 뜬다)"
              className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-hovered hover:text-fg"
            >
              <ChevronDown size={12} />
              접기
            </button>
            <button
              type="button"
              onClick={dismiss}
              aria-label="링크 후보 닫기"
              title="닫기 (Esc)"
              className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-hovered hover:text-fg"
            >
              <X size={12} />
            </button>
          </div>
          <ul ref={listRef} role="listbox" aria-label="링크 후보" className="min-h-0 flex-1 overflow-y-auto py-1">
            {items.map((it, i) => {
              const Icon = linkIcon(it.kind, it.folder);
              return (
                <li key={it.path} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(it, q)}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] ${
                      i === active ? "bg-hovered" : ""}`}
                  >
                    <Icon size={14} className={`shrink-0 ${it.folder ? "text-accent" : "text-fg-muted"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate font-medium text-fg">{it.label}</span>
                        {it.detail && <span className="shrink-0 truncate text-[11px] text-fg-subtle">{it.detail}</span>}
                      </span>
                      {it.path !== it.label && (
                        <span className="block truncate font-mono text-[10.5px] text-fg-subtle">{it.path}</span>
                      )}
                    </span>
                    {it.folder && <ChevronRight size={13} className="shrink-0 text-fg-subtle" />}
                  </button>
                </li>
              );
            })}
            {items.length === 0 && (
              <li className="px-3 py-2 text-[12px] text-fg-subtle">
                {loading ? "찾는 중…" : "맞는 항목이 없습니다 — 경로를 더 치거나 Esc"}
              </li>
            )}
          </ul>
          {/* 목록 밖(늘 보이는 자리)에 둔다 — 목록 끝에 두면 끝까지 내려야 보인다 */}
          {more > 0 && items.length > 0 && (
            <div data-link-more className="shrink-0 border-t border-line px-2.5 py-1 text-[11px] text-fg-muted">
              {linkMoreNote(more)}
            </div>
          )}
          <div className="shrink-0 border-t border-line px-2.5 py-1 text-[10.5px] text-fg-subtle">
            {touch ? "눌러서 넣기 · 폴더는 안으로 들어감 · ✕ 로 닫기"
              : "↑↓ 고르기 · Enter/Tab 넣기 · 폴더는 안으로 들어감 · Esc 닫기"}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
