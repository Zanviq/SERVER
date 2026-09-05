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
  showDetail = false,
  side = "left",
}: {
  children: ReactNode;
  storageKey: string;
  /** 모바일에서 목록 대신 문서를 보여줄지. 좁은 화면은 한 번에 하나만 띄운다. */
  showDetail?: boolean;
  /** 폭이 고정된 첫 자식(목록)을 어느 쪽에 둘지. 영어 학습은 단어장이 오른쪽이다. */
  side?: "left" | "right";
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
    // 포인터를 손잡이에 **붙잡아 둔다**. window 리스너만 쓰면 PDF 뷰어의
    // <iframe> 위에서 마우스를 떼는 순간 pointerup 이 부모 창에 오지 않아,
    // 분할선이 마우스를 계속 따라다니고 body 의 col-resize 커서와
    // user-select:none 도 영영 되돌아오지 않는다.
    const el = e.currentTarget as HTMLElement;
    const id = e.pointerId;
    const startX = e.clientX;
    try {
      el.setPointerCapture(id);
    } catch {
      /* 지원하지 않는 브라우저 — 아래 리스너만으로 동작한다 */
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === id) onMove(ev.clientX - startX);
    };
    // pointercancel 도 받아야 한다(터치 중단·시스템 제스처). 안 받으면 그때도
    // 정리 코드가 안 돌아 화면이 잠긴 것처럼 남는다.
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      try {
        el.releasePointerCapture(id);
      } catch {
        /* 이미 풀렸다 */
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // treeW/editorFrac는 pointerdown 렌더 시점(=드래그 시작값)으로 캡처되고,
  // 드래그 중 move 리스너는 그 시작값 + dx로 절대 위치를 계산한다.
  // 고정 패널이 오른쪽이면 손잡이를 왼쪽으로 끌수록 넓어진다.
  const treeDown = beginDrag((dx) => setTreeW(clamp(treeW + (side === "right" ? -dx : dx), 180, 560)));
  const splitDown = beginDrag((dx) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const remaining = wrap.clientWidth - treeW - 24; // 핸들 폭 여유
    if (remaining > 0) setEditorFrac(clamp(editorFrac + dx / remaining, 0.2, 0.8));
  });

  if (!desktop) {
    // 목록과 문서를 같이 쌓으면 문서를 볼 때마다 목록 320px를 지나쳐 스크롤해야 하고,
    // 문서를 읽는 동안에도 화면 위쪽을 목록이 계속 차지한다. 좁은 화면에서는
    // 한 번에 하나만 보여주고 전환한다(옵시디언 모바일과 같다).
    return (
      <div className="grid grid-cols-1 gap-4">
        {showDetail ? [center, right].filter(Boolean) : left}
      </div>
    );
  }

  // 자식이 2개면 트리 + 메인(단일 패널), 3개면 트리 + 에디터 + 미리보기.
  const twoPane = right == null;
  const fixed = (
    <div className="flex min-w-0 shrink-0 flex-col [&>*]:min-h-0 [&>*]:flex-1" style={{ width: treeW }}>
      {left}
    </div>
  );
  return (
    <div ref={wrapRef} className={`flex h-view-9 items-stretch ${side === "right" ? "flex-row-reverse" : ""}`}>
      {/* 각 래퍼를 flex-col로 만들고 자식 카드를 flex-1/min-h-0로 강제 → 카드가 패널 높이를 꽉 채움 */}
      {fixed}
      <Handle onPointerDown={treeDown} />
      {twoPane ? (
        <div className="flex min-w-0 flex-1 flex-col [&>*]:min-h-0 [&>*]:flex-1">
          {center}
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-col [&>*]:min-h-0 [&>*]:flex-1" style={{ flexGrow: editorFrac, flexBasis: 0 }}>
            {center}
          </div>
          <Handle onPointerDown={splitDown} />
          <div className="flex min-w-0 flex-col [&>*]:min-h-0 [&>*]:flex-1" style={{ flexGrow: 1 - editorFrac, flexBasis: 0 }}>
            {right}
          </div>
        </>
      )}
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
