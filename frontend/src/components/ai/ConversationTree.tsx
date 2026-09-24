import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, GitBranch, Link2, Loader2, LocateFixed, Minus, Plus,
  Scale, Search, Tag, Unlink, Wand2, X,
} from "lucide-react";
import {
  DOT_R, FixedSpots, NODE_H, NODE_W, Placed, TreeMessage, Turn,
  buildTurns, clampY, findTurns, hiddenCount, layout,
} from "../../lib/chatTree";

export interface TreeLink {
  from_id: string;
  to_id: string;
}

interface Props {
  messages: TreeMessage[];
  head: string;
  links: TreeLink[];
  /** 이 차례로 옮겨 간다(그 가지의 끝까지 따라간다) */
  onGo: (turnId: string) => void;
  /** 이 질문을 고쳐서 새 가지로 다시 묻는다 */
  onEdit: (userMsgId: string, text: string) => void;
  /** 기억 연결을 걸거나 푼다 */
  onLink: (fromId: string, toId: string, on: boolean) => void;
  /** 고른 가지들을 견주어 달라고 한다 */
  onCompare: (turnIds: string[]) => void;
  /** 갈라지는 가지에 AI 가 이름을 붙인다 */
  onName: () => Promise<void>;
  onClose: () => void;
  /** 손으로 옮겨 둔 노드 자리(서버에 남는다) */
  positions?: FixedSpots;
  /** 노드를 옮겼다 — null 이면 그 자리를 지운다(다시 자동 배치) */
  onMove?: (patch: Record<string, [number, number] | null>) => void;
  /** 옆에 세워 둔 지도는 닫을 것이 아니다(닫으면 빈 칸만 남는다) */
  closable?: boolean;
  busy?: boolean;
}

const PAD = 40;
//: 처음 맞출 때 이보다 작게 줄이지 않는다 — 더 줄이면 노드 밑의 글을 읽을 수 없다.
const MIN_FIT = 0.62;
//: 끌 때 자리는 이 눈금에 맞춘다. 격자와 같은 결이라 손으로 놓아도 줄이 맞는다.
const SNAP = 12;
//: 이만큼 움직이기 전에는 '누른 것'으로 본다(끌기와 클릭을 가른다)
const DEAD_ZONE = 4;

/** 격자 한 칸. 많이 줄였을 때는 성글게 — 안 그러면 선이 뭉쳐 회색 판이 된다. */
function gridCell(k: number): number {
  return k >= 0.9 ? 24 : k >= 0.45 ? 48 : 96;
}

/**
 * 대화 지도 — 나무 전체를 보고, 가지를 갈아타고, 잇고, 견주고, **자리를 손으로 옮긴다.**
 *
 * 레퍼런스(Conversation-Tree)에서 가져온 것: 끌어 옮기기(부모 위·자식 아래로 가둔다),
 * 답이 오기 전에 노드가 먼저 서는 것, 화면 변환을 리액트 상태 밖에서 다루는 것.
 * 가져오지 않은 것: 물리 시뮬레이션(노드가 떨리고 열 때마다 그림이 달라졌다)과
 * D3 가 DOM 을 직접 만지는 방식(리액트가 그린 노드가 남거나 사라졌다).
 *
 * **움직임이 끊기지 않게 하는 규칙:** 화면을 밀거나 확대할 때는 `view` 만 바뀐다.
 * 노드·선은 `useMemo` 로 묶어 두어 그때 다시 그리지 않는다. 끌기는 rAF 로 한 프레임에
 * 한 번만 반영한다.
 */
export function ConversationTree({
  messages, head, links, onGo, onEdit, onLink, onCompare, onName, onClose,
  positions = {}, onMove, closable = true, busy,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // **0 으로 시작한다.** 그럴듯한 기본값을 두면 첫 렌더에서 그 값으로 맞춤이
  // 끝나 버리고(firstFit 은 한 번뿐이다), 실제 칸 크기를 잰 뒤에는 다시 맞추지
  // 않는다 — 나무가 칸 구석에 치우쳐 붙어 있었다(실측).
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ x: PAD, y: PAD, k: 1 });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [linking, setLinking] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [compareMode, setCompareMode] = useState(false);
  const [naming, setNaming] = useState(false);
  /** 지금 끌고 있는 노드의 자리(놓을 때까지는 여기서만 산다) */
  const [dragSpot, setDragSpot] = useState<{ id: string; x: number; y: number } | null>(null);
  //: 같은 값을 ref 로도 들고 있는다. 손을 뗄 때 **상태 갱신 함수 안에서** 부모에게
  //: 알리면 리액트가 "그리는 중에 다른 컴포넌트를 바꾼다"고 경고한다(실측).
  const dragNow = useRef<{ id: string; x: number; y: number } | null>(null);

  const spots = useMemo(
    () => (dragSpot ? { ...positions, [dragSpot.id]: [dragSpot.x, dragSpot.y] as [number, number] }
      : positions),
    [positions, dragSpot]);

  const roots = useMemo(() => buildTurns(messages, head), [messages, head]);
  const { nodes, edges, width, height } = useMemo(
    () => layout(roots, collapsed, spots), [roots, collapsed, spots],
  );
  const hits = useMemo(() => findTurns(roots, messages, q), [roots, messages, q]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const msgById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const turnById = useMemo(() => {
    const out = new Map<string, Turn>();
    const walk = (t: Turn) => { out.set(t.id, t); t.children.forEach(walk); };
    roots.forEach(walk);
    return out;
  }, [roots]);
  /** 부모·자식을 빨리 찾기 위한 짝지음(끌 때 위아래 한계를 잡는다) */
  const kin = useMemo(() => {
    const parent = new Map<string, string>();
    for (const e of edges) parent.set(e.to.id, e.from.id);
    const kids = new Map<string, string[]>();
    for (const e of edges) kids.set(e.from.id, [...(kids.get(e.from.id) ?? []), e.to.id]);
    return { parent, kids };
  }, [edges]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /** 지금 보고 있는 차례가 가운데 오도록. 처음 열 때와 단추를 누를 때. */
  const recenter = useCallback(() => {
    const cur = [...nodes].reverse().find((n) => n.onPath);
    if (!cur) return;
    setView((v) => ({
      ...v,
      x: box.w / 2 - (cur.x + NODE_W / 2) * v.k,
      y: box.h / 2 - (cur.y + DOT_R) * v.k,
    }));
  }, [nodes, box.w, box.h]);

  const firstFit = useRef(true);
  useEffect(() => {
    // 칸을 아직 재지 못했으면(box 0) 기다린다 — 재고 나서 딱 한 번 맞춘다
    if (!firstFit.current || nodes.length === 0 || box.w < 10 || box.h < 10) return;
    firstFit.current = false;
    // 나무 전체가 들어오면 그렇게 맞추고, **너무 작아질 것 같으면 줄이지 않는다.**
    // 옆에 세운 좁은 칸에서 전체를 우겨 넣으면 글자가 읽을 수 없을 만큼 작아진다
    // (실측: 380px 칸에 가지 넷이면 0.3배). 그때는 크기를 지키고 지금 자리를 비춘다.
    const k = Math.max(MIN_FIT, Math.min(1,
      (box.w - PAD * 2) / Math.max(1, width), (box.h - PAD * 2) / Math.max(1, height)));
    const cur = [...nodes].reverse().find((n) => n.onPath);
    const left = Math.min(0, ...nodes.map((n) => n.x));
    const top = Math.min(0, ...nodes.map((n) => n.y));
    const fitsW = width * k <= box.w - PAD;
    const fitsH = height * k <= box.h - PAD;
    setView({
      k,
      x: fitsW || !cur ? (box.w - width * k) / 2 - left * k : box.w / 2 - (cur.x + NODE_W / 2) * k,
      // 세로는 **위에 붙인다.** 가운데로 맞추면 짧은 대화가 칸 한복판에 떠서
      // 위쪽이 허전하고, 이어지는 차례가 어디로 자랄지도 보이지 않는다.
      y: fitsH || !cur ? PAD - top * k : box.h / 2 - (cur.y + DOT_R) * k,
    });
  }, [nodes, box.w, box.h, width, height]);

  // ── 화면 밀기·확대 ────────────────────────────────────────────────
  //
  // 손잡이는 **svg 에만** 붙인다. 감싸는 div 에 붙였더니 그 위에 떠 있는 단추
  // 상자를 누를 때도 끌기가 시작됐고, 포인터를 가로채 단추의 click 이 아예
  // 오지 않았다 — "여기서 이어가기"를 눌러도 아무 일도 없었다(실측).
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const frame = useRef(0);
  /** 한 프레임에 한 번만 반영한다 — 포인터 이벤트마다 그리면 끌기가 끈적해진다. */
  const onFrame = (fn: () => void) => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; fn(); });
  };
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  // 끌기 처리기는 `bodyEl` 안에 묶여 있어 다시 만들어지지 않는다 — 화면 변환은
  // ref 로 읽어야 한다(상태로 읽으면 한 번 민 뒤부터 좌표가 어긋난다).
  const viewRef = useRef(view);
  viewRef.current = view;

  const graphAt = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (e.clientX - (r?.left ?? 0) - v.x) / v.k,
      y: (e.clientY - (r?.top ?? 0) - v.y) / v.k,
    };
  };

  // ── 노드 끌어 옮기기 ──────────────────────────────────────────────
  const grab = useRef<
    { id: string; ox: number; oy: number; lo?: number; hi: number[]; moved: boolean } | null>(null);

  const startNodeDrag = (e: React.PointerEvent, n: Placed) => {
    // 노드 위에서는 화면 밀기를 시작하지 않는다. **먼저 막아야 한다** — svg 가 포인터를
    // 붙잡으면 이어지는 click 의 대상이 svg 로 바뀌어, 고르는 중(비교·기억 연결)에
    // 노드를 눌러도 아무것도 골라지지 않았다(실측).
    e.stopPropagation();
    if (linking || compareMode) return;   // 고르는 중에는 끌지 않고 누르기만 받는다
    const at = graphAt(e);
    const parent = kin.parent.get(n.id);
    grab.current = {
      id: n.id, ox: at.x - n.x, oy: at.y - n.y, moved: false,
      lo: parent ? byId.get(parent)?.y : undefined,
      hi: (kin.kids.get(n.id) ?? []).map((k) => byId.get(k)?.y ?? Infinity),
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (grab.current) return;
    // 칸 밖으로 나가도 끌기가 이어지게 포인터를 붙잡는다(놓으면 저절로 풀린다)
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = grab.current;
    if (g) {
      const at = graphAt(e);
      const x = Math.round((at.x - g.ox) / SNAP) * SNAP;
      const y = clampY(Math.round((at.y - g.oy) / SNAP) * SNAP, g.lo, g.hi);
      const k = viewRef.current.k;
      const moved = g.moved
        || Math.abs(at.x - g.ox - (byId.get(g.id)?.x ?? 0)) * k > DEAD_ZONE
        || Math.abs(at.y - g.oy - (byId.get(g.id)?.y ?? 0)) * k > DEAD_ZONE;
      g.moved = moved;
      if (moved) {
        dragNow.current = { id: g.id, x, y };
        onFrame(() => setDragSpot(dragNow.current));
      }
      return;
    }
    const d = pan.current;
    if (!d) return;
    onFrame(() => setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) })));
  };

  const endDrag = () => {
    const g = grab.current;
    grab.current = null;
    pan.current = null;
    if (!g) return;
    const cur = dragNow.current;
    dragNow.current = null;
    setDragSpot(null);
    if (!g.moved) {
      const n = byId.get(g.id);
      if (n) clickNode(n);
      return;
    }
    if (cur && cur.id === g.id) onMove?.({ [g.id]: [cur.x, cur.y] });
  };

  const zoomBy = (f: number, cx = box.w / 2, cy = box.h / 2) => {
    setView((v) => {
      const k = Math.min(2.2, Math.max(0.25, v.k * f));
      // 가리키는 지점을 고정한 채 확대한다 — 아니면 보던 곳이 화면 밖으로 달아난다
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });
  };

  const go = (id: string) => { setPicked(null); onGo(id); };

  const toggleFold = (id: string) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const clickNode = (n: Placed) => {
    if (linking) {
      if (linking !== n.id) onLink(linking, n.id, true);
      setLinking(null);
      return;
    }
    if (compareMode) {
      setCompare((c) => c.includes(n.id) ? c.filter((x) => x !== n.id)
        : c.length >= 4 ? c : [...c, n.id]);
      return;
    }
    setPicked((p) => (p === n.id ? null : n.id));
  };

  const pickedNode = picked ? byId.get(picked) : null;
  const moved = Object.keys(positions).length > 0;

  /** 이름이 아직 없는 갈래 수 — 하나도 없으면 단추를 보여 줄 이유가 없다. */
  const unnamed = useMemo(() => {
    const byParent = new Map<string, number>();
    for (const m of messages) {
      if (m.role !== "user") continue;
      const k = m.parent ?? "";
      byParent.set(k, (byParent.get(k) ?? 0) + 1);
    }
    return messages.filter(
      (m) => m.role === "user" && (byParent.get(m.parent ?? "") ?? 0) > 1 && !m.branchName,
    ).length;
  }, [messages]);

  // 검색 결과로 건너뛰기
  const hitList = useMemo(() => nodes.filter((n) => hits.has(n.id)), [nodes, hits]);
  const [hitAt, setHitAt] = useState(0);
  useEffect(() => { setHitAt(0); }, [q]);
  const jumpTo = (n: Placed) => setView((v) => ({
    ...v,
    x: box.w / 2 - (n.x + NODE_W / 2) * v.k,
    y: box.h / 2 - (n.y + DOT_R) * v.k,
  }));

  //: 미니맵은 칸 폭의 3분의 1을 넘지 않는다 — 좁은 칸에서는 지도를 가린다
  const miniW = Math.min(120, Math.max(84, box.w / 3.5));
  const left = Math.min(0, ...nodes.map((n) => n.x));
  const top = Math.min(0, ...nodes.map((n) => n.y));
  const mini = miniW / Math.max(width + NODE_W, height + NODE_H, 1);
  const cell = gridCell(view.k);

  /**
   * 나무 본체. **화면을 밀거나 확대할 때는 다시 그리지 않는다**(view 가 여기 없다) —
   * 그 덕에 노드가 수십 개여도 밀기가 매끄럽다.
   */
  const bodyEl: ReactNode = useMemo(() => (
    <>
      {edges.map((e) => {
        // 위에서 아래로 흐르는 곡선. 동그라미 한가운데끼리 잇는다.
        const x1 = e.from.x + NODE_W / 2;
        const y1 = e.from.y + DOT_R;
        const x2 = e.to.x + NODE_W / 2;
        const y2 = e.to.y + DOT_R;
        const mid = (y1 + y2) / 2;
        const on = e.from.onPath && e.to.onPath;
        return (
          <path key={`${e.from.id}>${e.to.id}`}
            d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`}
            fill="none"
            stroke={on ? "rgb(var(--accent))" : "rgb(var(--line-strong))"}
            strokeWidth={on ? 1.6 : 1} opacity={on ? 0.9 : 0.6} />
        );
      })}
      {/* 기억 연결 — 나무의 선과 헷갈리지 않게 점선에 다른 색. 동그라미 테두리에
          닿게 그린다(가운데로 꽂으면 점 위에 선이 얹혀 지저분하다). */}
      {links.map((l, i) => {
        const a = byId.get(l.from_id);
        const b = byId.get(l.to_id);
        if (!a || !b) return null;
        const down = b.y >= a.y;
        const x1 = a.x + NODE_W / 2;
        const y1 = a.y + DOT_R + (down ? DOT_R + 3 : -DOT_R - 3);
        const x2 = b.x + NODE_W / 2;
        const y2 = b.y + DOT_R + (down ? -DOT_R - 3 : DOT_R + 3);
        const bow = Math.max(50, Math.abs(x2 - x1) * 0.5);
        return (
          <g key={`l${i}`}>
            <path d={`M${x1},${y1} Q${Math.min(x1, x2) - bow},${(y1 + y2) / 2} ${x2},${y2}`}
              fill="none" stroke="rgb(var(--warning))" strokeWidth={1.2}
              strokeDasharray="5 4" opacity={0.9} />
            <circle cx={x2} cy={y2} r={2.2} fill="rgb(var(--warning))" />
          </g>
        );
      })}
      {nodes.map((n) => {
        const t = turnById.get(n.id);
        const kids = t ? t.children.length : 0;
        const folded = collapsed.has(n.id);
        const inCompare = compare.indexOf(n.id);
        const isHit = hits.has(n.id);
        const isPicked = picked === n.id;
        const cx = NODE_W / 2;
        const ring = inCompare >= 0 ? "rgb(var(--positive))"
          : isHit ? "rgb(var(--warning))"
          : n.onPath ? "rgb(var(--accent))" : "rgb(var(--line-strong))";
        return (
          <g key={n.id} data-node transform={`translate(${n.x} ${n.y})`}
            className={linking || compareMode ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}
            onPointerDown={(e) => t && startNodeDrag(e, n)}
            // 고르는 중(기억 연결·비교)에는 끌지 않고 **누르는 것**만 받는다.
            // 끌기로 옮기면서 이 길이 빠져 비교 모드에서 아무것도 골라지지 않았다.
            onClick={(e) => {
              if (!t || !(linking || compareMode)) return;
              e.stopPropagation();
              clickNode(n);
            }}>
            {/* 지금 줄기는 **얇은 테**로 표시한다. 예전의 두꺼운 빛무리는 점을
                뭉개서 어느 것이 노드인지 알아보기 어려웠다. */}
            {(n.onPath || isPicked) && (
              <circle cx={cx} cy={DOT_R} r={DOT_R + 4.5} fill="none"
                stroke="rgb(var(--accent))" strokeWidth={1} opacity={isPicked ? 0.85 : 0.35} />
            )}
            {/* 누르기 쉬우라고 보이는 것보다 넓게 잡는다(손가락) */}
            <circle cx={cx} cy={DOT_R} r={DOT_R * 2.4} fill="transparent" />
            <circle cx={cx} cy={DOT_R} r={DOT_R}
              fill={n.onPath ? "rgb(var(--accent))" : "rgb(var(--bg-elevated))"}
              stroke={ring} strokeWidth={inCompare >= 0 || isHit ? 1.6 : 1.1} />
            {n.onPath && (
              <circle cx={cx} cy={DOT_R} r={DOT_R * 0.36} fill="rgb(var(--accent-contrast))" />
            )}
            {/* 답을 기다리는 중 — 도는 점선으로 알린다(작은 점은 눈에 안 띄었다) */}
            {n.pending && (
              <circle cx={cx} cy={DOT_R} r={DOT_R + 4.5} fill="none"
                stroke="rgb(var(--accent))" strokeWidth={1.2} strokeDasharray="3 5"
                className="tree-pending" style={{ transformOrigin: `${cx}px ${DOT_R}px` }} />
            )}
            {/* **글은 동그라미 밑에.** 상자 안에 넣으면 지도가 표처럼 보이고,
                가지가 갈라지는 모양이 눈에 안 들어온다. 격자·선 위에서도 읽히도록
                바탕색으로 한 번 두르고 그 위에 글자를 얹는다(paint-order). */}
            <text x={cx} y={DOT_R * 2 + 14} fontSize={10.5} textAnchor="middle"
              paintOrder="stroke" stroke="rgb(var(--bg))" strokeWidth={3.5}
              strokeLinejoin="round"
              fill={n.onPath ? "rgb(var(--fg))" : "rgb(var(--fg-muted))"}
              fontWeight={n.onPath ? 600 : 400}
              style={{ pointerEvents: "none" }}>
              {n.label}
            </text>
            {inCompare >= 0 && (
              <text x={cx - DOT_R - 9} y={DOT_R + 4} fontSize={11} fontWeight={700}
                fill="rgb(var(--positive))" style={{ pointerEvents: "none" }}>
                {String.fromCharCode(65 + inCompare)}
              </text>
            )}
            {/* 접기 단추는 **오른쪽 옆**에. 예전에는 비스듬히 아래에 있어서 글자와
                선 위에 겹쳐 앉았다. */}
            {kids > 0 && (
              <g className="cursor-pointer"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); toggleFold(n.id); }}>
                <circle cx={cx + DOT_R + 11} cy={DOT_R} r={6.5}
                  fill="rgb(var(--bg-elevated))" stroke="rgb(var(--line-strong))" strokeWidth={1} />
                <text x={cx + DOT_R + 11} y={DOT_R + 3} fontSize={8.5} textAnchor="middle"
                  fill="rgb(var(--fg-muted))" style={{ pointerEvents: "none" }}>
                  {folded ? `+${hiddenCount(t!)}` : "–"}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [nodes, edges, links, byId, turnById, collapsed, compare, hits, picked, linking, compareMode]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 머리줄에는 '무엇을 보고 있는가'와 찾기만 둔다. 다루는 단추는 아래 막대로
          내렸다 — 한 줄에 다 넣으면 좁은 칸에서 두 줄로 접히며 서로 밀렸다. */}
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        <GitBranch size={14} className="shrink-0 text-accent" />
        <span className="shrink-0 text-[12.5px] font-medium">대화 지도</span>
        <span className="shrink-0 text-[11px] text-fg-muted">{turnById.size}개 차례</span>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <div className="relative min-w-0">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="가지 찾기"
              className="input h-7 w-[7.5rem] pl-6 text-[12px] sm:w-40" />
          </div>
          {q.trim() && (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-fg-muted">
              {hitList.length === 0 ? "없음" : `${hitAt + 1}/${hitList.length}`}
              <button type="button" aria-label="이전 결과" disabled={hitList.length === 0}
                className="tap grid h-6 w-6 place-items-center rounded hover:bg-hovered disabled:opacity-40"
                onClick={() => {
                  const i = (hitAt - 1 + hitList.length) % hitList.length;
                  setHitAt(i); jumpTo(hitList[i]);
                }}><ChevronLeft size={13} /></button>
              <button type="button" aria-label="다음 결과" disabled={hitList.length === 0}
                className="tap grid h-6 w-6 place-items-center rounded hover:bg-hovered disabled:opacity-40"
                onClick={() => {
                  const i = (hitAt + 1) % hitList.length;
                  setHitAt(i); jumpTo(hitList[i]);
                }}><ChevronRight size={13} /></button>
            </span>
          )}
          {closable && (
            <button type="button" onClick={onClose} aria-label="지도 닫기"
              className="tap grid h-7 w-7 shrink-0 place-items-center rounded text-fg-muted hover:bg-hovered">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {(linking || compareMode) && (
        <div className="flex items-center gap-2 border-b border-line bg-accent-muted/40 px-3 py-1.5 text-[11.5px] text-accent-fg">
          {linking ? (
            <>
              <Link2 size={13} className="shrink-0" />
              기억을 끌어올 대상 차례를 고르세요.
              <button type="button" className="ml-auto shrink-0 underline"
                onClick={() => setLinking(null)}>그만두기</button>
            </>
          ) : (
            <>
              <Scale size={13} className="shrink-0" />
              견줄 가지를 2~4개 고르세요 ({compare.length}개).
              <button type="button" className="btn btn-primary ml-auto h-6 shrink-0 px-2 text-[11px]"
                disabled={compare.length < 2}
                onClick={() => { onCompare(compare); setCompareMode(false); setCompare([]); }}>
                견주기
              </button>
              <button type="button" className="shrink-0 underline"
                onClick={() => { setCompareMode(false); setCompare([]); }}>그만두기</button>
            </>
          )}
        </div>
      )}

      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden bg-bg">
        {nodes.length === 0 ? (
          <div className="grid h-full place-items-center text-[12.5px] text-fg-muted">
            아직 대화가 없습니다.
          </div>
        ) : (
          <svg width="100%" height="100%"
            className="block touch-none cursor-grab active:cursor-grabbing"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={endDrag} onPointerCancel={endDrag}
            onWheel={(e) => {
              const r = wrapRef.current?.getBoundingClientRect();
              zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12,
                e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
            }}>
            <defs>
              {/* 격자 — 노드를 어디에 놓았는지 눈으로 가늠하게 해 준다(끌 때 이 눈금에
                  맞춰 붙는다). 선 굵기는 확대해도 그대로 얇게(1/k). */}
              <pattern id="tree-grid" width={cell} height={cell} patternUnits="userSpaceOnUse">
                <path d={`M${cell} 0 L0 0 0 ${cell}`} fill="none"
                  stroke="rgb(var(--line))" strokeWidth={1 / view.k} opacity={0.55} />
              </pattern>
              <pattern id="tree-grid-major" width={cell * 5} height={cell * 5}
                patternUnits="userSpaceOnUse">
                <path d={`M${cell * 5} 0 L0 0 0 ${cell * 5}`} fill="none"
                  stroke="rgb(var(--line-strong))" strokeWidth={1 / view.k} opacity={0.5} />
              </pattern>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <rect x={-20000} y={-20000} width={40000} height={40000} fill="url(#tree-grid)" />
              <rect x={-20000} y={-20000} width={40000} height={40000} fill="url(#tree-grid-major)" />
              {bodyEl}
            </g>
          </svg>
        )}

        {/* 미니맵 — 나무가 커지면 지금 어디를 보고 있는지 알 수 없다. 노드 상자를
            열어 두었을 때는 감춘다(둘이 겹쳐 서로를 가렸다). */}
        {nodes.length > 6 && box.w > 260 && !pickedNode && (() => {
          const vx = Math.max(left, -view.x / view.k);
          const vy = Math.max(top, -view.y / view.k);
          const vw = Math.min(box.w / view.k, width + NODE_W - (vx - left));
          const vh = Math.min(box.h / view.k, height + NODE_H - (vy - top));
          const all = vx <= left && vy <= top
            && box.w / view.k >= width + NODE_W && box.h / view.k >= height + NODE_H;
          return (
            // 나무는 위에서 시작하므로 미니맵은 **아래 오른쪽**에 둔다(도구막대 위).
            <svg className="pointer-events-none absolute bottom-14 right-2 rounded-md border border-line bg-surface/85 backdrop-blur"
              width={miniW + 10} height={Math.min(96, (height + NODE_H) * mini + 10)}>
              <g transform={`translate(${5 - left * mini} ${5 - top * mini}) scale(${mini})`}>
                {nodes.map((n) => (
                  <circle key={n.id} cx={n.x + NODE_W / 2} cy={n.y + DOT_R} r={DOT_R * 1.8}
                    fill={n.onPath ? "rgb(var(--accent))" : "rgb(var(--line-strong))"} />
                ))}
                {!all && vw > 0 && vh > 0 && (
                  <rect x={vx} y={vy} width={vw} height={vh} rx={4}
                    fill="rgb(var(--accent))" fillOpacity={0.12}
                    stroke="rgb(var(--accent))" strokeWidth={1.5 / mini} opacity={0.9} />
                )}
              </g>
            </svg>
          );
        })()}

        {/* 고른 노드의 할 일 — **그 노드 옆에** 띄운다. 예전에는 늘 맨 위 가운데라
            어느 노드를 고른 것인지 선을 그어 봐야 알 수 있었다. */}
        {pickedNode && (() => {
          const w = Math.min(320, box.w - 16);
          const sx = view.x + (pickedNode.x + NODE_W / 2) * view.k;
          const sy = view.y + (pickedNode.y + DOT_R * 2) * view.k;
          const x = Math.min(Math.max(8, sx - w / 2), Math.max(8, box.w - w - 8));
          // 아래로 넘칠 것 같으면 노드 위로 올려 붙인다(도구막대와도 겹치지 않게)
          const below = sy + 132 < box.h - 52;
          return (
            <div style={{ left: x, top: below ? sy + 16 : undefined,
                          bottom: below ? undefined : Math.max(52, box.h - sy + 28), width: w }}
              className="absolute z-10 rounded-lg border border-line bg-surface p-2.5 shadow-lg">
              <div className="mb-1.5 flex items-start gap-2">
                <p className="line-clamp-2 min-w-0 flex-1 text-[12px] text-fg2">
                  {msgById.get(pickedNode.userId)?.text || pickedNode.label}
                </p>
                <button type="button" aria-label="닫기" onClick={() => setPicked(null)}
                  className="tap -mr-1 -mt-1 grid h-6 w-6 shrink-0 place-items-center rounded text-fg-muted hover:bg-hovered">
                  <X size={13} />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className="btn btn-primary h-7 px-2.5 text-[11.5px]"
                  disabled={busy} onClick={() => go(pickedNode.id)}>
                  {busy && <Loader2 size={12} className="animate-spin" />} 여기서 이어가기
                </button>
                <button type="button" className="btn btn-ghost h-7 px-2 text-[11.5px]"
                  onClick={() => {
                    onEdit(pickedNode.userId, msgById.get(pickedNode.userId)?.text ?? "");
                    setPicked(null);
                  }}>
                  질문 고쳐서 새 가지
                </button>
                {links.some((l) => l.from_id === pickedNode.id || l.to_id === pickedNode.id) ? (
                  <button type="button" className="btn btn-ghost h-7 px-2 text-[11.5px] text-warning"
                    onClick={() => {
                      const l = links.find((x) => x.from_id === pickedNode.id || x.to_id === pickedNode.id)!;
                      onLink(l.from_id, l.to_id, false);
                      setPicked(null);
                    }}>
                    <Unlink size={12} /> 기억 연결 풀기
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost h-7 px-2 text-[11.5px]"
                    onClick={() => { setLinking(pickedNode.id); setPicked(null); }}>
                    <Link2 size={12} /> 기억 연결
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {/* 아래 도구막대 — 지도를 다루는 단추는 전부 여기 모은다. 떠 있는 알약이라
            나무를 가리지 않고, 좁은 칸에서도 한 줄로 남는다. */}
        {nodes.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2.5 flex justify-center px-2">
            <div className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-line bg-surface/95 p-1 shadow-md backdrop-blur">
              <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="축소"
                className="tap grid h-7 w-7 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-hovered">
                <Minus size={14} />
              </button>
              <button type="button" onClick={() => setView((v) => ({ ...v, k: 1 }))}
                title="원래 크기로" aria-label="원래 크기로"
                className="tap h-7 shrink-0 rounded-full px-1.5 text-[11px] tabular-nums text-fg-muted hover:bg-hovered">
                {Math.round(view.k * 100)}%
              </button>
              <button type="button" onClick={() => zoomBy(1.2)} aria-label="확대"
                className="tap grid h-7 w-7 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-hovered">
                <Plus size={14} />
              </button>
              <span className="mx-0.5 h-4 w-px shrink-0 bg-line" />
              <button type="button" onClick={recenter} title="지금 보고 있는 차례로"
                aria-label="지금 자리로"
                className="tap grid h-7 w-7 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-hovered">
                <LocateFixed size={14} />
              </button>
              <button type="button" disabled={!moved}
                onClick={() => onMove?.(Object.fromEntries(Object.keys(positions).map((k) => [k, null])))}
                title="손으로 옮긴 자리를 풀고 나무 모양대로 정렬" aria-label="정렬"
                className="tap grid h-7 w-7 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-hovered disabled:opacity-35">
                <Wand2 size={14} />
              </button>
              <span className="mx-0.5 h-4 w-px shrink-0 bg-line" />
              <button type="button"
                onClick={() => { setCompareMode((c) => !c); setCompare([]); setLinking(null); }}
                title="여러 가지를 골라 견주어 보기"
                className={`tap inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] ${
                  compareMode ? "bg-accent-muted text-accent-fg" : "text-fg-muted hover:bg-hovered"}`}>
                <Scale size={13} /> 비교
              </button>
              {unnamed > 0 && (
                <button type="button" disabled={naming} onClick={async () => {
                  setNaming(true);
                  try { await onName(); } finally { setNaming(false); }
                }}
                  title="갈라지는 가지가 무슨 이야기였는지 AI 가 한 줄로 이름 붙입니다"
                  className="tap inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] text-fg-muted hover:bg-hovered disabled:opacity-50">
                  {naming ? <Loader2 size={13} className="animate-spin" /> : <Tag size={13} />}
                  이름 짓기
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
