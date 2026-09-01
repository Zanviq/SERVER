/**
 * 콜아웃 — `> [!NOTE] 제목` 형태의 강조 상자.
 *
 * 표기는 GitHub·옵시디언이 쓰는 것을 그대로 따랐다. 자체 문법을 만들면 다른
 * 도구로 문서를 열었을 때 깨진 인용문으로 보인다. 이 표기는 어디서 열어도
 * 최소한 인용문으로는 읽힌다.
 */
import type { ReactNode } from "react";
import { Children, isValidElement } from "react";

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

export const CALLOUTS: Record<CalloutKind, { label: string; icon: string }> = {
  note: { label: "참고", icon: "ℹ️" },
  tip: { label: "팁", icon: "💡" },
  important: { label: "중요", icon: "❗" },
  warning: { label: "주의", icon: "⚠️" },
  caution: { label: "경고", icon: "🔥" },
};

const MARKER = /^\s*\[!(note|tip|important|warning|caution)\]\s*(.*)$/i;

/** 문자열이 `[!NOTE] 제목` 으로 시작하면 갈래와 제목을 돌려준다. */
export function matchMarker(text: string): { kind: CalloutKind; title: string } | null {
  const m = MARKER.exec(text);
  if (!m) return null;
  return { kind: m[1].toLowerCase() as CalloutKind, title: m[2].trim() };
}

/**
 * blockquote 의 자식들에서 콜아웃 표시를 찾아, 표시를 뺀 본문을 돌려준다.
 *
 * react-markdown 은 인용문 안을 이미 <p> 로 감싼 뒤라, 첫 문단의 맨 앞
 * 텍스트만 들여다본다.
 */
export function parseCallout(
  children: ReactNode,
): { kind: CalloutKind; title: string; body: ReactNode[] } | null {
  const nodes = Children.toArray(children).filter(
    (n) => !(typeof n === "string" && n.trim() === ""),
  );
  const first = nodes[0];
  if (!isValidElement(first)) return null;

  const inner = Children.toArray(
    (first.props as { children?: ReactNode }).children,
  );
  const head = inner[0];
  if (typeof head !== "string") return null;

  const hit = matchMarker(head);
  if (!hit) return null;

  // 첫 문단에서 표시를 뺀 나머지(같은 줄에 이어 쓴 본문)
  const restOfFirst = inner.slice(1);
  const lead = head.replace(MARKER, "").trim();
  const firstBody: ReactNode[] = [];
  if (lead) firstBody.push(lead);
  firstBody.push(...restOfFirst);

  const body: ReactNode[] = [];
  if (firstBody.some((n) => n !== "" && n !== undefined && n !== null)) {
    body.push(...firstBody);
  }
  body.push(...nodes.slice(1));
  return { kind: hit.kind, title: hit.title, body };
}
