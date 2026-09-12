import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, GitBranch, Link2, Loader2, LocateFixed, Minus, Plus,
  Scale, Search, Tag, Unlink, X,
} from "lucide-react";
import {
  NODE_H, NODE_W, Placed, TreeMessage, Turn, buildTurns, findTurns, hiddenCount, layout,
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
  busy?: boolean;
}

const PAD = 40;

/**
 * 대화 지도 — 나무 전체를 보고, 가지를 갈아타고, 잇고, 견준다.
 *
 * 레퍼런스(Conversation-Tree)의 D3 판을 다시 썼다. 옮겨 오지 않은 것과 그 이유:
 *
 *  - **물리 시뮬레이션과 손으로 끌어 놓는 좌표.** 노드가 서로 밀며 떨렸고, 같은
 *    대화를 다시 열 때마다 그림이 달라져서 "아까 그게 어디 있었지"가 통하지
 *    않았다. 여기서는 자리가 나무 모양만으로 정해진다 — 같은 대화면 같은 그림이다.
 *  - **D3 가 DOM 을 직접 만지는 방식.** 리액트가 그린 것을 D3 가 다시 건드리면서
 *    노드가 남거나 사라졌다. 여기서는 좌표만 계산하고 그리는 것은 리액트가 한다.
 *
 * 더한 것: 접기(+n), 검색, 미니맵, 키보드 이동, 지금 자리로 되돌아오기.
 */
export function ConversationTree({
  messages, head, links, onGo, onEdit, onLink, onCompare, onName, onClose, busy,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 420 });
  const [view, setView] = useState({ x: PAD, y: PAD, k: 1 });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [linking, setLinking] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);

  const roots = useMemo(() => buildTurns(messages, head), [messages, head]);
  const { nodes, edges, width, height } = useMemo(
    () => layout(roots, collapsed), [roots, collapsed],
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
      y: box.h / 2 - (cur.y + NODE_H / 2) * v.k,
    }));
  }, [nodes, box.w, box.h]);

  const firstFit = useRef(true);
  useEffect(() => {
    if (!firstFit.current || nodes.length === 0 || box.w < 10) return;
    firstFit.current = false;
    // 처음에는 나무 전체가 들어오도록 맞춘다(다 안 들어오면 지금 자리로)
    const k = Math.min(1, (box.w - PAD * 2) / Math.max(1, width),
      (box.h - PAD * 2) / Math.max(1, height));
    setView({ x: PAD, y: PAD, k: Math.max(0.35, k) });
  }, [nodes.length, box.w, box.h, width, height]);

  // 끌어서 옮기기(포인터 하나로 마우스·터치 모두).
  //
  // 손잡이는 **svg 에만** 붙인다. 감싸는 div 에 붙였더니 그 위에 떠 있는 단추
  // 상자(노드를 누르면 나오는 것)를 누를 때도 끌기가 시작됐고, setPointerCapture
  // 가 포인터를 가로채 **단추의 click 이 아예 오지 않았다** — "여기서 이어가기"를
  // 눌러도 아무 일도 일어나지 않았다(실측).
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("[data-node]")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
  };
  const endDrag = () => { drag.current = null; };

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

  const [compareMode, setCompareMode] = useState(false);
  const [naming, setNaming] = useState(false);
  const pickedNode = picked ? byId.get(picked) : null;

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
    y: box.h / 2 - (n.y + NODE_H / 2) * v.k,
  }));

  const mini = 130 / Math.max(width + NODE_W, height + NODE_H, 1);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
        <GitBranch size={14} className="shrink-0 text-accent" />
        <span className="text-[12.5px] font-medium">대화 지도</span>
        <span className="text-[11px] text-fg-muted">{turnById.size}개 차례</span>

        <div className="ml-2 flex items-center gap-1">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="가지 안에서 찾기"
              className="input h-7 w-40 pl-6 text-[12px]" />
          </div>
          {q.trim() && (
            <span className="flex items-center gap-0.5 text-[11px] text-fg-muted">
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
        </div>

        <div className="ml-auto flex items-center gap-1">
          {unnamed > 0 && (
            <button type="button" disabled={naming} onClick={async () => {
              setNaming(true);
              try { await onName(); } finally { setNaming(false); }
            }}
              title="갈라지는 가지가 무슨 이야기였는지 AI 가 한 줄로 이름 붙입니다"
              className="tap inline-flex h-7 items-center gap-1 rounded px-2 text-[11.5px] text-fg-muted hover:bg-hovered disabled:opacity-50">
              {naming ? <Loader2 size={13} className="animate-spin" /> : <Tag size={13} />}
              가지 이름 짓기
            </button>
          )}
          <button type="button" onClick={() => { setCompareMode((c) => !c); setCompare([]); setLinking(null); }}
            title="여러 가지를 골라 견주어 보기"
            className={`tap inline-flex h-7 items-center gap-1 rounded px-2 text-[11.5px] ${
              compareMode ? "bg-accent-muted text-accent-fg" : "text-fg-muted hover:bg-hovered"}`}>
            <Scale size={13} /> 비교
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="축소"
            className="tap grid h-7 w-7 place-items-center rounded text-fg-muted hover:bg-hovered"><Minus size={14} /></button>
          <button type="button" onClick={() => zoomBy(1.2)} aria-label="확대"
            className="tap grid h-7 w-7 place-items-center rounded text-fg-muted hover:bg-hovered"><Plus size={14} /></button>
          <button type="button" onClick={recenter} aria-label="지금 자리로" title="지금 보고 있는 차례로"
            className="tap grid h-7 w-7 place-items-center rounded text-fg-muted hover:bg-hovered"><LocateFixed size={14} /></button>
          <button type="button" onClick={onClose} aria-label="지도 닫기"
            className="tap grid h-7 w-7 place-items-center rounded text-fg-muted hover:bg-hovered"><X size={14} /></button>
        </div>
      </div>

      {(linking || compareMode) && (
        <div className="flex items-center gap-2 border-b border-line bg-accent-muted/40 px-3 py-1.5 text-[11.5px] text-accent-fg">
          {linking ? (
            <>
              <Link2 size={13} /> 기억을 끌어올 **대상** 차례를 고르세요 — 이 가지의 이야기가 그쪽 맥락으로 들어갑니다.
              <button type="button" className="ml-auto underline" onClick={() => setLinking(null)}>그만두기</button>
            </>
          ) : (
            <>
              <Scale size={13} /> 견줄 가지를 2~4개 고르세요 ({compare.length}개 골랐습니다).
              <button type="button" className="btn btn-primary ml-auto h-6 px-2 text-[11px]"
                disabled={compare.length < 2}
                onClick={() => { onCompare(compare); setCompareMode(false); setCompare([]); }}>
                이 가지들 견주기
              </button>
              <button type="button" className="underline" onClick={() => { setCompareMode(false); setCompare([]); }}>그만두기</button>
            </>
          )}
        </div>
      )}

      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden bg-subtle/40">
        {nodes.length === 0 ? (
          <div className="grid h-full place-items-center text-[12.5px] text-fg-muted">
            아직 대화가 없습니다.
          </div>
        ) : (
          <svg width="100%" height="100%" className="block touch-none"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={endDrag} onPointerCancel={endDrag} onPointerLeave={endDrag}
            onWheel={(e) => {
              const r = wrapRef.current?.getBoundingClientRect();
              zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12,
                e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
            }}>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {edges.map((e, i) => {
                const x1 = e.from.x + NODE_W;
                const y1 = e.from.y + NODE_H / 2;
                const x2 = e.to.x;
                const y2 = e.to.y + NODE_H / 2;
                const mid = (x1 + x2) / 2;
                const on = e.from.onPath && e.to.onPath;
                return (
                  <path key={i} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                    fill="none"
                    stroke={on ? "rgb(var(--accent))" : "rgb(var(--line))"}
                    strokeWidth={on ? 2 : 1.25} />
                );
              })}
              {/* 기억 연결 — 나무의 선과 헷갈리지 않게 점선에 다른 색 */}
              {links.map((l, i) => {
                const a = byId.get(l.from_id);
                const b = byId.get(l.to_id);
                if (!a || !b) return null;
                const x1 = a.x + NODE_W / 2;
                const y1 = a.y + NODE_H;
                const x2 = b.x + NODE_W / 2;
                const y2 = b.y + NODE_H;
                const sag = Math.max(40, Math.abs(y2 - y1) * 0.6);
                return (
                  <g key={`l${i}`}>
                    <path d={`M${x1},${y1} Q${(x1 + x2) / 2},${Math.max(y1, y2) + sag} ${x2},${y2}`}
                      fill="none" stroke="rgb(var(--warning))" strokeWidth={1.5}
                      strokeDasharray="5 4" opacity={0.85} />
                    <circle cx={x2} cy={y2} r={3} fill="rgb(var(--warning))" />
                  </g>
                );
              })}
              {nodes.map((n) => {
                const t = turnById.get(n.id);
                const kids = t ? t.children.length : 0;
                const folded = collapsed.has(n.id);
                const inCompare = compare.indexOf(n.id);
                const isHit = hits.has(n.id);
                return (
                  <g key={n.id} data-node transform={`translate(${n.x} ${n.y})`}
                    className="cursor-pointer" onClick={() => t && clickNode(n)}>
                    <rect width={NODE_W} height={NODE_H} rx={8}
                      fill={n.onPath ? "rgb(var(--accent-muted))" : "rgb(var(--bg-elevated))"}
                      stroke={
                        inCompare >= 0 ? "rgb(var(--positive))"
                        : isHit ? "rgb(var(--warning))"
                        : n.onPath ? "rgb(var(--accent))" : "rgb(var(--line))"}
                      strokeWidth={inCompare >= 0 || isHit || n.onPath ? 2 : 1} />
                    {/* 자르는 것은 chatTree.fitLabel 이 폭으로 한다 — 글자 수로 자르면
                        한글이 상자 밖으로 삐져나온다(라틴 문자의 두 배 가까이 넓다). */}
                    <text x={9} y={NODE_H / 2 + 4} fontSize={11.5}
                      fill={n.onPath ? "rgb(var(--accent-fg))" : "rgb(var(--fg2))"}>
                      {n.label}
                    </text>
                    {n.pending && (
                      <circle cx={NODE_W - 8} cy={8} r={3} fill="rgb(var(--warning))" />
                    )}
                    {inCompare >= 0 && (
                      <text x={NODE_W - 14} y={NODE_H - 8} fontSize={11} fontWeight={600}
                        fill="rgb(var(--positive))">{String.fromCharCode(65 + inCompare)}</text>
                    )}
                    {kids > 0 && (
                      <g onClick={(e) => { e.stopPropagation(); toggleFold(n.id); }}>
                        <circle cx={NODE_W} cy={NODE_H / 2} r={8}
                          fill="rgb(var(--bg-elevated))" stroke="rgb(var(--line))" />
                        <text x={NODE_W} y={NODE_H / 2 + 3.5} fontSize={9} textAnchor="middle"
                          fill="rgb(var(--fg-muted))">
                          {folded ? `+${hiddenCount(t!)}` : "–"}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        {/* 미니맵 — 나무가 커지면 지금 어디를 보고 있는지 알 수 없다.
            지금 보고 있는 칸은 **미니맵 안으로 잘라서** 그린다. 자르지 않으면 나무보다
            큰 사각형이 틀 밖으로 뻗어 나가 흰 막대처럼 보였다(실측). */}
        {nodes.length > 6 && (() => {
          const vx = Math.max(0, -view.x / view.k);
          const vy = Math.max(0, -view.y / view.k);
          const vw = Math.min(box.w / view.k, width + NODE_W - vx);
          const vh = Math.min(box.h / view.k, height + NODE_H - vy);
          const all = vx <= 0 && vy <= 0
            && box.w / view.k >= width + NODE_W && box.h / view.k >= height + NODE_H;
          return (
            <svg className="pointer-events-none absolute bottom-2 right-2 rounded border border-line bg-surface/90"
              width={140} height={Math.min(110, (height + NODE_H) * mini + 10)}>
              <g transform={`translate(5 5) scale(${mini})`}>
                {nodes.map((n) => (
                  <rect key={n.id} x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx={6}
                    fill={n.onPath ? "rgb(var(--accent))" : "rgb(var(--line))"} />
                ))}
                {/* 나무가 통째로 보이는 중이면 틀을 그리지 않는다 — 전부가 곧 지금이다 */}
                {!all && vw > 0 && vh > 0 && (
                  <rect x={vx} y={vy} width={vw} height={vh} rx={4}
                    fill="rgb(var(--accent))" fillOpacity={0.12}
                    stroke="rgb(var(--accent))" strokeWidth={2 / mini} opacity={0.9} />
                )}
              </g>
            </svg>
          );
        })()}

        {/* 고른 노드의 할 일 */}
        {pickedNode && (
          <div className="absolute left-1/2 top-2 w-[min(340px,92%)] -translate-x-1/2 rounded-lg border border-line bg-surface p-2.5 shadow-lg">
            <p className="mb-1.5 line-clamp-2 text-[12px] text-fg2">
              {msgById.get(pickedNode.userId)?.text || pickedNode.label}
            </p>
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
        )}
      </div>
    </div>
  );
}
