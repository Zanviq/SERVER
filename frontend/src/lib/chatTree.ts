/**
 * 대화 나무 — 메시지 목록에서 줄기·가지·지도 좌표를 계산한다.
 *
 * 서버와 **같은 규칙**을 쓴다(backend/chat_store.py). 말풍선에 보이는 것도
 * 모델이 받는 것도 head 에서 뿌리까지의 한 줄기뿐이고, 나머지 가지는 지도에만
 * 나온다.
 *
 * 그림 계산을 여기 두는 이유는 화면 없이 시험할 수 있어야 하기 때문이다 —
 * 겹침·순서 같은 것은 눈으로 보고 판단할 일이 아니다.
 */

export interface TreeMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  parent?: string | null;
  ts?: number;
  /** AI 가 붙인 가지 이름. 갈라지는 자리에만 있다(있으면 질문 앞부분 대신 쓴다). */
  branchName?: string;
}

/** 한 '차례'(질문 + 답). 지도의 노드 하나. */
export interface Turn {
  /** 이 차례의 끝 메시지 id. 노드를 누르면 여기가 head 가 된다. */
  id: string;
  /** 질문 메시지 id — 고쳐서 다시 묻기가 쓰는 값 */
  userId: string;
  /** 지도에 적을 한 줄 */
  label: string;
  /** 그 한 줄이 AI 가 지은 가지 이름인가(아니면 질문 앞부분) */
  named: boolean;
  /** 답이 아직 없는 차례(끊겼거나 실패) */
  pending: boolean;
  /** 지금 보고 있는 줄기 위에 있는가 */
  onPath: boolean;
  depth: number;
  children: Turn[];
}

export interface Placed extends Turn {
  x: number;
  y: number;
}

/** 지금 보고 있는 줄기 — head 에서 뿌리까지 거슬러 올라간 뒤 시간순으로. */
export function threadOf(msgs: TreeMessage[], head: string): TreeMessage[] {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  let cur = byId.has(head) ? head : msgs[msgs.length - 1]?.id ?? "";
  const out: TreeMessage[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const m = byId.get(cur);
    if (!m) break;
    out.push(m);
    cur = m.parent ?? "";
  }
  return out.reverse();
}

/** 부모 → 자식들(등록 순서 = 시간 순서). 부모가 없으면 "" 키에 모인다. */
export function childrenIndex(msgs: TreeMessage[]): Map<string, TreeMessage[]> {
  const out = new Map<string, TreeMessage[]>();
  for (const m of msgs) {
    const k = m.parent ?? "";
    const arr = out.get(k);
    if (arr) arr.push(m);
    else out.set(k, [m]);
  }
  return out;
}

/**
 * 이 메시지와 **같은 자리에서 갈라진 형제들**. 말풍선의 ◀ 2/3 ▶ 가 쓴다.
 * 자기 자신을 포함하며 시간순이다.
 */
export function siblingsOf(msgs: TreeMessage[], id: string): TreeMessage[] {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const me = byId.get(id);
  if (!me) return [];
  const key = me.parent ?? "";
  return msgs.filter((m) => (m.parent ?? "") === key);
}

/**
 * 어떤 메시지에서 아래로 내려가는 **가장 최근 끝자락**. 가지를 갈아탈 때
 * "그 가지의 마지막까지" 따라간다 — 갈아탄 순간 반쪽만 보이면 안 된다.
 */
export function deepestLeaf(msgs: TreeMessage[], id: string): string {
  const kids = childrenIndex(msgs);
  let cur = id;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const next = kids.get(cur);
    if (!next || next.length === 0) return cur;
    // 가장 나중에 만들어진 가지를 따라간다(마지막으로 보던 쪽일 가능성이 높다)
    cur = next[next.length - 1].id;
  }
}

/**
 * 노드 상자에 **들어가는 만큼만** 자른다.
 *
 * 글자 수로 자르면 안 된다 — 한글·한자는 라틴 문자의 두 배 가까이 넓어서, 같은
 * 17자라도 "1. backprop details" 는 남고 "역전파, 정규화, 초기화를" 은 상자
 * 밖으로 삐져나온다(실제로 그랬다). 폭으로 센다.
 */
const WIDE = /[ᄀ-ᇿ⺀-鿿가-힯＀-｠]/;

export function fitLabel(text: string, px = NODE_W - 22, size = 11.5): string {
  const one = (text || "").replace(/\s+/g, " ").trim();
  if (!one) return "(빈 메시지)";
  const w = (ch: string) => (WIDE.test(ch) ? size : size * 0.52);
  let used = 0;
  let out = "";
  for (const ch of one) {
    if (used + w(ch) > px - size * 0.6) return `${out}…`;   // … 자리를 남긴다
    used += w(ch);
    out += ch;
  }
  return out;
}

/**
 * 메시지 나무 → '차례' 나무(숲).
 *
 * 질문과 답을 한 노드로 묶는다. 노드 하나 = 한 번의 주고받음이라, 지도가 실제
 * 대화 흐름과 같은 리듬으로 읽힌다(메시지마다 노드를 두면 갈래마다 높이가
 * 두 배가 되고 U-A-U-A 가 번갈아 나와 눈에 남는 것이 없다).
 */
export function buildTurns(msgs: TreeMessage[], head: string): Turn[] {
  const kids = childrenIndex(msgs);
  const onPath = new Set(threadOf(msgs, head).map((m) => m.id));

  const build = (userMsg: TreeMessage, depth: number): Turn => {
    // 질문의 첫 자식이 답이다. 답이 없으면(끊긴 차례) 질문이 곧 끝이다.
    const reply = (kids.get(userMsg.id) ?? []).find((m) => m.role === "assistant");
    const endId = reply ? reply.id : userMsg.id;
    const next = reply ? kids.get(reply.id) ?? [] : (kids.get(userMsg.id) ?? []).filter(
      (m) => m.role === "user",
    );
    return {
      id: endId,
      userId: userMsg.id,
      // 갈라지는 자리의 질문은 "1번 더 자세히" 처럼 앞말에 기대는 짧은 말이 많다 —
      // 이름이 있으면 그걸 쓴다. 그것이 지도에서 알고 싶은 바로 그 정보다.
      label: fitLabel(userMsg.branchName?.trim() || userMsg.text),
      named: !!userMsg.branchName?.trim(),
      pending: !reply,
      onPath: onPath.has(endId) || onPath.has(userMsg.id),
      depth,
      children: next.filter((m) => m.role === "user").map((m) => build(m, depth + 1)),
    };
  };

  // 뿌리가 여럿일 수 있다(오래된 메시지가 잘려 부모를 잃은 경우) — 숲으로 그린다
  return (kids.get("") ?? []).filter((m) => m.role === "user").map((m) => build(m, 0));
}

export const NODE_W = 132;
export const NODE_H = 34;
export const COL_GAP = 60;
export const ROW_GAP = 14;

/**
 * 겹치지 않는 나무 배치(왼→오른쪽).
 *
 * 잎은 저마다 한 줄을 차지하고, 부모는 제 자식들의 한가운데에 선다. 잎이 줄을
 * 나눠 쓰지 않으므로 **겹칠 수가 없다** — 레퍼런스가 쓰던 물리 시뮬레이션은
 * 노드가 서로 밀며 떨리고, 같은 대화를 다시 열 때마다 모양이 달라져서 어디에
 * 무엇이 있었는지 기억할 수 없었다. 여기서는 같은 대화면 언제나 같은 그림이다.
 */
export function layout(roots: Turn[], collapsed: Set<string> = new Set()): {
  nodes: Placed[];
  edges: { from: Placed; to: Placed }[];
  width: number;
  height: number;
} {
  const nodes: Placed[] = [];
  const edges: { from: Placed; to: Placed }[] = [];
  let row = 0;

  const place = (t: Turn): Placed => {
    const kids = collapsed.has(t.id) ? [] : t.children;
    let y: number;
    let placedKids: Placed[] = [];
    if (kids.length === 0) {
      y = row * (NODE_H + ROW_GAP);
      row += 1;
    } else {
      placedKids = kids.map(place);
      y = (placedKids[0].y + placedKids[placedKids.length - 1].y) / 2;
    }
    const me: Placed = { ...t, x: t.depth * (NODE_W + COL_GAP), y };
    nodes.push(me);
    for (const k of placedKids) edges.push({ from: me, to: k });
    return me;
  };

  for (const r of roots) place(r);
  const width = nodes.reduce((w, n) => Math.max(w, n.x + NODE_W), 0);
  const height = nodes.reduce((h, n) => Math.max(h, n.y + NODE_H), 0);
  return { nodes, edges, width, height };
}

/** 접힌 노드 밑에 가려진 차례 수 — "+3" 처럼 보여 준다. */
export function hiddenCount(t: Turn): number {
  let n = 0;
  const walk = (x: Turn) => {
    for (const c of x.children) {
      n += 1;
      walk(c);
    }
  };
  walk(t);
  return n;
}

/** 검색어에 걸리는 차례들. 지도에서 표시하고 이동에 쓴다. */
export function findTurns(roots: Turn[], msgs: TreeMessage[], q: string): Set<string> {
  const needle = q.trim().toLowerCase();
  const hit = new Set<string>();
  if (!needle) return hit;
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const walk = (t: Turn) => {
    const a = byId.get(t.userId)?.text ?? "";
    const b = byId.get(t.id)?.text ?? "";
    if (`${a}\n${b}`.toLowerCase().includes(needle)) hit.add(t.id);
    t.children.forEach(walk);
  };
  roots.forEach(walk);
  return hit;
}
