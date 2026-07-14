import { Children, PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * 노트/AI문서 뷰의 3분할(트리 · 에디터 · 미리보기) 레이아웃.
 * 데스크톱(lg↑)에서는 좌측 트리 폭과 에디터:미리보기 비율을 드래그로 조절하고
 * localStorage에 저장한다. 모바일에서는 기존처럼 세로로 쌓는다.
 * 자식은 정확히 3개(트리, 에디터, 미리보기)를 순서대로 전달한다.
 */
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Saved = { treeW?: number; editorFrac?: number };
function load(key: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch {
    return {};
  }
}

export function ThreePane({
  children,
  storageKey,
}: {
  children: ReactNode;
  storageKey: string;
}) {
  const [left, center, right] = Children.toArray(children);
  const [treeW, setTreeW] = useState<number>(() => load(storageKey).treeW ?? 260);
  const [editorFrac, setEditorFrac] = useState<number>(() => load(storageKey).editorFrac ?? 0.5);
  const [desktop, setDesktop] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia("(min-width:1024px)").matches,
  );
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(min-width:1024px)");
    const on = () => setDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({ treeW, editorFrac }));
  }, [treeW, editorFrac, storageKey]);

  const beginDrag = useCallback((onMove: (dx: number) => void) => (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const move = (ev: PointerEvent) => onMove(ev.clientX - startX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // treeW/editorFrac는 pointerdown 렌더 시점(=드래그 시작값)으로 캡처되고,
  // 드래그 중 move 리스너는 그 시작값 + dx로 절대 위치를 계산한다.
  const treeDown = beginDrag((dx) => setTreeW(clamp(treeW + dx, 180, 560)));
  const splitDown = beginDrag((dx) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const remaining = wrap.clientWidth - treeW - 24; // 핸들 폭 여유
    if (remaining > 0) setEditorFrac(clamp(editorFrac + dx / remaining, 0.2, 0.8));
  });

  if (!desktop) {
    return <div className="grid grid-cols-1 gap-4">{children}</div>;
  }

  return (
    <div ref={wrapRef} className="flex h-[calc(100vh-9rem)] items-stretch">
      <div className="min-w-0 shrink-0" style={{ width: treeW }}>
        {left}
      </div>
      <Handle onPointerDown={treeDown} />
      <div className="min-w-0" style={{ flexGrow: editorFrac, flexBasis: 0 }}>
        {center}
      </div>
      <Handle onPointerDown={splitDown} />
      <div className="min-w-0" style={{ flexGrow: 1 - editorFrac, flexBasis: 0 }}>
        {right}
      </div>
    </div>
  );
}

function Handle({ onPointerDown }: { onPointerDown: (e: ReactPointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="group flex shrink-0 cursor-col-resize items-center justify-center px-1.5"
      role="separator"
      aria-orientation="vertical"
      title="드래그하여 크기 조절"
    >
      <div className="h-full w-px rounded bg-line transition-colors group-hover:bg-accent" />
    </div>
  );
}
