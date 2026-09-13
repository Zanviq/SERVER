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

/**
 * 다른 도구에서 쓰는 이름을 우리 다섯 갈래로 접는다.
 *
 * 옵시디언·GitHub 문서를 붙여 넣으면 `[!INFO]`·`[!DANGER]` 같은 이름이 그대로
 * 온다. 모르는 이름은 콜아웃으로 **인식되지 않아** `[!INFO]` 글자가 인용문 안에
 * 그대로 남는다 — 붙여 넣은 문서가 깨져 보인다.
 */
const ALIAS: Record<string, CalloutKind> = {
  note: "note", info: "note", todo: "note", quote: "note", example: "note", abstract: "note",
  tip: "tip", hint: "tip", success: "tip", check: "tip", done: "tip",
  important: "important", question: "important", help: "important", faq: "important",
  warning: "warning", attention: "warning",
  caution: "caution", danger: "caution", error: "caution", bug: "caution", failure: "caution",
};

// `]` 뒤의 `-`·`+` 는 옵시디언의 **접기 표시**다. 제목이 아니므로 떼어낸다
// (안 떼면 제목이 "- 접는 제목" 으로 보였다).
const MARKER = new RegExp(
  `^\\s*\\[!(${Object.keys(ALIAS).join("|")})\\][-+]?\\s*(.*)$`, "i");

/** 문자열이 `[!NOTE] 제목` 으로 시작하면 갈래와 제목을 돌려준다. */
export function matchMarker(text: string): { kind: CalloutKind; title: string } | null {
  const m = MARKER.exec(text);
  if (!m) return null;
  return { kind: ALIAS[m[1].toLowerCase()], title: m[2].trim() };
}

/**
 * blockquote 의 자식들에서 콜아웃 표시를 찾아, 표시를 뺀 본문을 돌려준다.
 *
 * react-markdown 은 인용문 안을 이미 <p> 로 감싼 뒤라, 첫 문단의 맨 앞
 * 텍스트만 들여다본다.
 */
export function parseCallout(
  children: ReactNode,
): { kind: CalloutKind; title: string; titleRest: ReactNode[]; body: ReactNode[] } | null {
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

  // 첫 문단을 **첫 줄바꿈에서** 자른다. 앞쪽은 제목, 뒤쪽은 본문이다.
  //
  // remarkBreaks 가 엔터 한 번을 <br> 로 바꾸므로 `> [!NOTE] 제목` 과 다음 줄이
  // **같은 문단** 안에 <br> 로 이어져 온다. 그래서 <br> 이 곧 줄 경계다.
  //
  // 제목에 서식이 들어갈 수 있다(`> [!TIP] **굵은** 제목`). 그때 첫 텍스트 조각은
  // "[!TIP] " 에서 끊기므로, 표시를 뗀 나머지 **조각들까지** 제목으로 모아야 한다.
  // 예전에는 첫 조각만 제목으로 보고 나머지를 본문으로 흘려서, 제목이 비고
  // 굵은 글씨가 본문 첫 줄에 떨어졌다.
  const rest = inner.slice(1);
  const br = rest.findIndex((n) => isValidElement(n) && n.type === "br");
  const sameLine = br < 0 ? rest : rest.slice(0, br);
  const afterLine = br < 0 ? [] : rest.slice(br + 1);

  const lead = head.replace(MARKER, "").trim();
  const titleRest: ReactNode[] = [];
  if (lead) titleRest.push(lead);
  titleRest.push(...sameLine);

  const body: ReactNode[] = [...afterLine, ...nodes.slice(1)];
  return { kind: hit.kind, title: hit.title, titleRest, body };
}
