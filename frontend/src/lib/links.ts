/**
 * `[note/서버/기록.md]` 링크 — 어느 입력칸에서나 서버의 항목을 가리킨다.
 *
 * 경로의 맨 앞 조각이 갈래다(note·paper·meeting·todo·event·vocab·diary).
 * 무엇이 링크인지는 **백엔드(backend/links.py)와 같은 식**으로 정한다. 한쪽만
 * 고치면 화면에서는 링크로 보이는데 AI 는 못 읽는(또는 그 반대) 일이 생긴다.
 *
 * 컴포넌트에서 떼어 둔 이유는 테스트 때문이다(test/links.test.mjs).
 */

export const LINK_KINDS = ["note", "paper", "meeting", "todo", "event", "vocab", "diary"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

const ALIASES: Record<string, LinkKind> = {
  notes: "note", papers: "paper", meetings: "meeting", todos: "todo",
  events: "event", words: "vocab", word: "vocab",
};

export const LINK_LABELS: Record<LinkKind, string> = {
  note: "문서", paper: "논문", meeting: "회의", todo: "할 일",
  event: "일정", vocab: "단어장", diary: "기록",
};

const PREFIXES = [...LINK_KINDS, ...Object.keys(ALIASES)]
  .sort((a, b) => b.length - a.length)
  .join("|");

/** 이런 것은 링크가 아니다: `[[위키]]` · `![그림](…)` · `[글](주소)` ·
 *  `[글][참조]`(두 괄호 모두) · `[참조]: 주소` · `\[이스케이프]` */
const REF_SOURCE = String.raw`(?<![\[\]\\!])\[((?:${PREFIXES})/[^\[\]\n]+?)\](?![\](\[:])`;

/** 링크를 찾는 식(전역 g). 매번 새로 만든다 — g 식은 lastIndex 를 들고 다닌다. */
export function refRegex(): RegExp {
  return new RegExp(REF_SOURCE, "g");
}

export function canonKind(k: string): LinkKind | null {
  const low = k.trim().toLowerCase();
  const c = ALIASES[low] ?? low;
  return (LINK_KINDS as readonly string[]).includes(c) ? (c as LinkKind) : null;
}

/** `note/서버/기록.md` → { kind: "note", rest: "서버/기록.md" } */
export function splitLink(path: string): { kind: LinkKind | null; rest: string } {
  const p = path.trim().replace(/^\[|\]$/g, "").replace(/^\/+|\/+$/g, "");
  const i = p.indexOf("/");
  const head = i < 0 ? p : p.slice(0, i);
  return { kind: canonKind(head), rest: i < 0 ? "" : p.slice(i + 1).replace(/^\/+|\/+$/g, "") };
}

/** 글 속의 링크 경로들(나온 순서, 중복 없이). 코드 구간은 부르는 쪽이 거른다. */
export function findRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(REF_SOURCE, "g"))) {
    const { kind, rest } = splitLink(m[1]);
    if (!kind || !rest) continue;
    const path = `${kind}/${rest}`;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** 칩에 보일 짧은 이름. 경로 전체는 마우스를 올리면 보인다. */
export function linkLabel(path: string): string {
  const { kind, rest } = splitLink(path);
  const parts = rest.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? rest;
  // 일정은 제목만으로는 어느 날 것인지 모른다
  if (kind === "event" && parts.length >= 2) return `${parts[0]} ${parts.slice(1).join("/")}`;
  if (kind === "diary") return `기록 ${last}`;
  return last || path;
}

/** 링크를 짧은 이름으로 바꾼 평문 — 지도 노드·목록처럼 마크다운을 안 그리는 자리용. */
export function plainRefs(text: string): string {
  return text.replace(refRegex(), (m, inner: string) => {
    const { kind, rest } = splitLink(inner);
    return kind && rest ? linkLabel(`${kind}/${rest}`) : m;
  });
}

const escapeLabel = (s: string) => s.replace(/([\\`*_[\]<>])/g, "\\$1");

/**
 * 마크다운 원문 조각의 링크를 표준 링크(`[이름](#link/…)`)로 바꾼다.
 * 코드 밖 조각만 넘겨야 한다(wikiTransform 의 mapOutsideCode 가 그렇게 부른다).
 */
export function transformLinks(chunk: string): string {
  return chunk.replace(new RegExp(REF_SOURCE, "g"), (m, inner: string) => {
    const { kind, rest } = splitLink(inner);
    if (!kind || !rest) return m;
    const path = `${kind}/${rest}`;
    return `[${escapeLabel(linkLabel(path))}](#link/${encodeURIComponent(path)})`;
  });
}

/** 입력칸에서 지금 치고 있는 링크. */
export interface LinkQuery {
  /** `[` 의 위치 */
  start: number;
  /** 바꿀 구간의 끝(이미 닫는 `]` 가 있으면 그 뒤까지) */
  end: number;
  /** `[` 와 커서 사이의 글자 */
  query: string;
}

/**
 * 커서가 `[…` 안에 있으면 그 구간. 아니면 null.
 *
 * 이런 때는 뜨지 않는다 — 대괄호를 쓰는 다른 문법을 치는 중이다:
 * `[[위키`, `![그림`, `[글][참`, `\[`, `- [ ]` 체크박스(공백으로 시작), 이미 닫힌 괄호.
 */
export function linkQueryAt(text: string, caret: number): LinkQuery | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const before = text.slice(lineStart, caret);
  const open = before.lastIndexOf("[");
  if (open < 0) return null;
  const query = before.slice(open + 1);
  if (query.includes("]") || /^\s/.test(query) || query.length > 200) return null;
  const prev = before[open - 1];
  if (prev === "[" || prev === "]" || prev === "!" || prev === "\\") return null;
  // 커서 뒤에 이미 `…]` 가 있으면(고치는 중) 그 닫는 괄호까지 바꾼다
  const nl = text.indexOf("\n", caret);
  const after = text.slice(caret, nl < 0 ? text.length : nl);
  const close = after.match(/^[^[\]\s]*\]/);
  return { start: lineStart + open, end: caret + (close ? close[0].length : 0), query };
}

/**
 * 후보를 고른 결과. 폴더는 **안으로 들어간다**(닫지 않고 `/` 로 끝내 다음 후보를
 * 받는다), 항목은 `]` 로 닫는다.
 */
export function applyPick(
  text: string,
  q: LinkQuery,
  path: string,
  folder: boolean,
): { text: string; caret: number } {
  const ins = folder ? `[${path.endsWith("/") ? path : `${path}/`}` : `[${path}]`;
  return { text: text.slice(0, q.start) + ins + text.slice(q.end), caret: q.start + ins.length };
}
