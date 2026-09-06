import {
  Children, PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useRef, useState,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * 좌우로 나뉜 작업 화면의 공용 레이아웃(문서·논문·회의·영어 학습·캘린더).
 *
 * 데스크톱(lg↑)에서는 분할선을 끌어 폭을 바꾸고, **최소 폭보다 더 끌면 그 칸이
 * 접힌다.** 접힌 자리에는 아주 얇은 세로 버튼만 남고, 그것을 누르면 다시 펼쳐진다.
 * 폭·비율·접힘은 storageKey 로 localStorage 에 남는다.
 *
 * 접을 때 **언마운트하지 않고 감추기만 한다** — 목록의 검색어나 편집 중인 내용이
 * 날아가면 안 된다.
 *
 * 자식은 2개(고정칸 + 본문) 또는 3개(고정칸 + 본문 + 곁칸)를 순서대로 준다.
 */
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 좁은 화면에서 칸 두 개를 단추로 바꿔 보는 틀.
 *
 *  **감추기만 한다** — 되돌아왔을 때 스크롤 위치, 입력 중인 글, 흐르는 답이
 *  그대로 있어야 한다(데스크톱에서 칸을 접을 때와 같은 규칙).
 *
 *  전환 단추가 차지하는 만큼 안쪽 칸을 줄인다. 그냥 위에 얹으면 자식이 들고 있는
 *  `h-view-11` 이 그대로라 화면이 단추 높이만큼 밀려 아래 끝이 탭바에 가린다
 *  (실측 38px). 자식이 스스로 정한 높이는 여기서 무시하고 남은 자리를 채운다. */
function MobileSwitch({
  items, onPick,
}: {
  items: { key: string; label: string; node: ReactNode; on: boolean }[];
  onPick: (key: string) => void;
}) {
  return (
    <div className="flex h-view-11 flex-col gap-2">
      <div className="flex shrink-0 rounded-md border border-line bg-subtle p-0.5"
        role="tablist" aria-label="보기 전환">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={it.on}
            onClick={() => onPick(it.key)}
            className={`h-8 flex-1 rounded text-[12.5px] font-medium transition-colors ${
              it.on ? "bg-surface text-fg shadow-sm" : "text-fg-muted"}`}
          >
            {it.label}
          </button>
        ))}
      </div>
      {items.map((it) => (
        <div key={it.key} className={`min-h-0 flex-1 [&>*]:!h-full ${it.on ? "" : "hidden"}`}>
          {it.node}
        </div>
      ))}
    </div>
  );
}

/** 고정칸이 가질 수 있는 폭 */
const MIN_FIXED = 180;
const MAX_FIXED = 560;
/** 이보다 좁아지도록 끌면 접는다(최소 폭보다 더 끈 것으로 본다) */
const COLLAPSE_AT = 120;
/** 곁칸이 이보다 좁아지면 접는다 */
const SIDE_COLLAPSE_AT = 160;

type Saved = {
  treeW?: number;
  editorFrac?: number;
  fixedClosed?: boolean;
  sideClosed?: boolean;
};

function load(key: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch {
    return {};
  }
}

interface Props {
  children: ReactNode;
  storageKey: string;
  /** 모바일에서 목록 대신 본문을 보여줄지. 좁은 화면은 한 번에 하나만 띄운다. */
  showDetail?: boolean;
  /** 폭이 고정된 첫 자식을 어느 쪽에 둘지. 영어 학습·캘린더는 오른쪽이다. */
  side?: "left" | "right";
  /** 고정칸의 처음 폭 */
  defaultWidth?: number;
  /**
   * 모바일 배치.
   * - switch: 목록 ↔ 본문을 showDetail 로 고르고, 본문과 곁칸은 단추로 바꾼다.
   * - toggle: 본문 ↔ 고정칸을 단추로 바꾼다(캘린더처럼 고정칸이 곧 작업 공간인 화면).
   * - stack: 세로로 쌓아 전부 보여 준다.
   */
  mobile?: "switch" | "stack" | "toggle";
  /**
   * 이 값이 바뀌면 좁은 화면에서 곁칸(switch) 또는 고정칸(toggle)으로 넘어간다.
   *
   * 넓은 화면에서는 두 칸이 나란히 있어서 "AI 에 넣기"를 누르면 그 결과가 바로
   * 눈에 들어온다. 좁은 화면에서는 그 칸이 숨어 있어, 논문에서 영역을 오려도
   * 화면에는 아무 일도 안 일어난 것처럼 보였다. 결과가 생긴 쪽으로 데려간다.
   */
  mobileFocusKey?: string;
  /** 접힌 띠 버튼에 뭐라고 쓸지 — 화면마다 그 칸의 이름이 다르다("논문 목록", "단어장"…) */
  fixedLabel?: string;
  sideLabel?: string;
  /** 모바일 전환 단추에 쓸 본문 칸의 이름("PDF", "본문"…) */
  centerLabel?: string;
}

export function ThreePane({
  children,
  storageKey,
  showDetail = false,
  side = "left",
  defaultWidth = 260,
  mobile = "switch",
  fixedLabel = "목록",
  sideLabel = "곁 패널",
  centerLabel = "본문",
  mobileFocusKey = "",
}: Props) {
  const [left, center, right] = Children.toArray(children);
  //: 모바일에서 본문과 곁칸 중 무엇을 보고 있는가. 문서를 새로 열면 본문부터 본다.
  const [mobileTab, setMobileTab] = useState<"center" | "side">("center");
  //: toggle 배치에서 고정칸(패널)을 보고 있는가. 처음에는 본문(달력)부터 본다.
  const [fixedOpen, setFixedOpen] = useState(false);
  const focusRef = useRef(mobileFocusKey);
  useEffect(() => {
    const prev = focusRef.current;
    focusRef.current = mobileFocusKey;
    // 빈 값에서 처음 생기는 것은 "이 기능이 켜졌다"는 뜻이지 사용자가 무언가를
    // 고른 것이 아니다. 그때도 넘어가면 기록 보기를 켜자마자 달력이 사라진다.
    if (!mobileFocusKey || !prev || mobileFocusKey === prev) return;
    setFixedOpen(true);   // toggle 배치
    setMobileTab("side"); // switch 배치
  }, [mobileFocusKey]);
  const saved = useRef(load(storageKey)).current;
  const [treeW, setTreeW] = useState<number>(() => saved.treeW ?? defaultWidth);
  const [editorFrac, setEditorFrac] = useState<number>(() => saved.editorFrac ?? 0.5);
  const [fixedClosed, setFixedClosed] = useState<boolean>(() => !!saved.fixedClosed);
  const [sideClosed, setSideClosed] = useState<boolean>(() => !!saved.sideClosed);
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
    localStorage.setItem(storageKey, JSON.stringify({ treeW, editorFrac, fixedClosed, sideClosed }));
  }, [treeW, editorFrac, fixedClosed, sideClosed, storageKey]);

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

  // treeW/editorFrac 는 pointerdown 렌더 시점(=드래그 시작값)으로 캡처되고,
  // 드래그 중 move 리스너는 그 시작값 + dx 로 절대 위치를 계산한다.
  // 고정칸이 오른쪽이면 손잡이를 왼쪽으로 끌수록 넓어진다.
  const fixedDown = beginDrag((dx) => {
    const w = treeW + (side === "right" ? -dx : dx);
    // 최소 폭보다 더 끌면 접는다 — 끌던 손을 그대로 밀면 사라지는 감각.
    if (w < COLLAPSE_AT) {
      setFixedClosed(true);
      return;
    }
    setFixedClosed(false);
    setTreeW(clamp(w, MIN_FIXED, MAX_FIXED));
  });

  const splitDown = beginDrag((dx) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const remaining = wrap.clientWidth - (fixedClosed ? 0 : treeW) - 24; // 핸들 폭 여유
    if (remaining <= 0) return;
    const frac = editorFrac + dx / remaining;
    if ((1 - frac) * remaining < SIDE_COLLAPSE_AT) {
      setSideClosed(true);
      return;
    }
    setSideClosed(false);
    setEditorFrac(clamp(frac, 0.2, 0.85));
  });

  if (!desktop) {
    // 목록과 본문을 같이 쌓으면 본문을 볼 때마다 목록을 지나쳐 스크롤해야 하고,
    // 읽는 동안에도 화면 위쪽을 목록이 계속 차지한다. 좁은 화면에서는 한 번에
    // 하나만 보여주고 전환한다(옵시디언 모바일과 같다). 캘린더처럼 둘을 함께
    // 봐야 하는 화면만 stack 으로 쌓는다.
    if (mobile === "stack") {
      return <div className="grid grid-cols-1 gap-4">{[center, right, left].filter(Boolean)}</div>;
    }
    if (mobile === "toggle") {
      // 달력과 패널을 쌓으면 각각이 한 화면이라, 날짜를 누른 뒤 답을 보려면
      // 화면 하나를 통째로 내려가야 했다. 단추로 바꿔 본다.
      return (
        <MobileSwitch
          items={[
            { key: "center", label: centerLabel, node: center, on: !fixedOpen },
            { key: "fixed", label: fixedLabel, node: left, on: fixedOpen },
          ]}
          onPick={(k) => setFixedOpen(k === "fixed")}
        />
      );
    }
    if (!showDetail) return <div className="grid grid-cols-1 gap-4">{left}</div>;
    // 본문과 곁칸(AI·미리보기)도 쌓지 않는다. 쌓으면 논문을 보다 질문하려면 화면
    // 하나를 통째로 내려가야 하고, 답을 읽고 본문으로 돌아오려면 또 올라와야 했다
    // (실측: 668px + 668px). 위의 작은 전환 단추로 바꿔 가며 본다.
    if (!right) return <div className="grid grid-cols-1 gap-4">{center}</div>;
    return (
      <MobileSwitch
        items={[
          { key: "center", label: centerLabel, node: center, on: mobileTab === "center" },
          { key: "side", label: sideLabel, node: right, on: mobileTab === "side" },
        ]}
        onPick={(k) => setMobileTab(k as "center" | "side")}
      />
    );
  }

  const twoPane = right == null;
  const openFixed = () => setFixedClosed(false);
  const openSide = () => setSideClosed(false);

  return (
    <div ref={wrapRef} className={`flex h-view-9 items-stretch ${side === "right" ? "flex-row-reverse" : ""}`}>
      {/* 각 래퍼를 flex-col 로 만들고 자식 카드를 flex-1/min-h-0 로 강제 → 카드가 패널 높이를 꽉 채움 */}
      <div className={`flex min-w-0 shrink-0 flex-col [&>*]:min-h-0 [&>*]:flex-1 ${fixedClosed ? "hidden" : ""}`}
        style={fixedClosed ? undefined : { width: treeW }}>
        {left}
      </div>
      {fixedClosed
        ? <Strip toward={side === "right" ? "left" : "right"} onClick={openFixed} label={`${fixedLabel} 펼치기`} />
        : <Handle onPointerDown={fixedDown} />}

      {twoPane ? (
        <div className="flex min-w-0 flex-1 flex-col [&>*]:min-h-0 [&>*]:flex-1">
          {center}
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-col [&>*]:min-h-0 [&>*]:flex-1"
            style={sideClosed ? { flexGrow: 1, flexBasis: 0 } : { flexGrow: editorFrac, flexBasis: 0 }}>
            {center}
          </div>
          {sideClosed
            ? <Strip toward="left" onClick={openSide} label={`${sideLabel} 펼치기`} />
            : <Handle onPointerDown={splitDown} />}
          <div className={`flex min-w-0 flex-col [&>*]:min-h-0 [&>*]:flex-1 ${sideClosed ? "hidden" : ""}`}
            style={sideClosed ? undefined : { flexGrow: 1 - editorFrac, flexBasis: 0 }}>
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
      title="드래그하여 크기 조절 · 끝까지 끌면 접힘"
    >
      <div className="h-full w-px rounded bg-line transition-colors group-hover:bg-accent" />
    </div>
  );
}

/** 접힌 자리에 남는 아주 얇은 세로 버튼. 누르면 그 칸이 돌아온다. */
function Strip({ toward, onClick, label }: {
  toward: "left" | "right";
  onClick: () => void;
  label: string;
}) {
  const Icon = toward === "right" ? ChevronRight : ChevronLeft;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="group mx-1 flex w-2.5 shrink-0 items-center justify-center rounded-full border border-line bg-surface transition-colors hover:w-3.5 hover:border-accent hover:bg-accent-muted"
    >
      <Icon size={11} className="text-fg-subtle transition-colors group-hover:text-accent" />
    </button>
  );
}
