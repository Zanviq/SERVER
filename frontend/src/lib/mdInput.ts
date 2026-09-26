/**
 * 입력칸의 마크다운 쓰기 도움 — 목록·인용을 이어 쓴다.
 *
 * 문서 편집기(CodeMirror)는 `- 첫째` 뒤에서 줄을 바꾸면 `- ` 를 이어 주는데, 채팅·할 일
 * 설명·일기 같은 다른 입력칸은 그냥 줄만 바꿨다. 같은 앱에서 목록을 쓰는 방법이 칸마다
 * 다르면 "마크다운이 안 된다"로 보인다. 규칙은 편집기와 같게 한다:
 *
 *   - 목록 줄에서 줄을 바꾸면 같은 표시를 잇는다(번호는 하나 올린다, 체크박스는 빈 칸으로).
 *   - **빈 항목**에서 줄을 바꾸면 목록을 끝낸다 — 표시를 지우고 **빈 줄을 하나 둔다**(endsBlock).
 *     들여쓴 빈 항목이면 한 단계 바깥 목록의 새 항목이 된다.
 *   - 인용(`> `)도 같다.
 *
 * 화면 없이 시험한다(test/mdInput.test.mjs).
 */

import { closesFence } from "./fence";

/** 목록 표시: 들여쓰기 · 표시(-, *, +, 1., 1)) · 뒤 공백 · 체크박스 */
const LIST = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const QUOTE = /^(\s*>\s?)/;
/** 코드 울타리(``` 또는 ~~~, 앞 들여쓰기 3칸까지) */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 커서가 닫히지 않은 코드 울타리 안에 있는가.
 *
 * 코드 속의 `- ` 나 `1. ` 는 목록이 아니다. 예전에는 코드블록 안에서도 목록을 이어서,
 * YAML·셸 스크립트를 적다 줄을 바꾸면 `- `·`2. ` 가 코드에 끼어들었다(17차). 닫는 울타리는
 * 연 것과 같은 글자이고 길이가 같거나 길어야 한다(편집기·그래프와 같은 규칙).
 */
function insideFence(text: string, lineStart: number): boolean {
  let open: string | null = null;
  for (const line of text.slice(0, lineStart).split("\n")) {
    const m = FENCE.exec(line);
    if (!m) continue;
    if (open === null) open = m[1];
    else if (closesFence(open, m[1])) open = null;
  }
  return open !== null;
}

export interface Edit {
  text: string;
  caret: number;
}

/**
 * 커서 자리에서 줄을 바꿀 때의 결과. 목록·인용 줄이 아니면 null(보통 줄바꿈).
 */
export function continueList(text: string, caret: number): Edit | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const nl = text.indexOf("\n", caret);
  const lineEnd = nl < 0 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);
  const before = text.slice(lineStart, caret);
  if (insideFence(text, lineStart)) return null;   // 코드 안 — 보통 줄바꿈

  const end = endsBlock(text, caret);
  if (end) return end;
  const m = LIST.exec(line);
  if (m && before.length >= m[0].length) {
    const marker = m[3] !== undefined ? `${Number(m[3]) + 1}${m[4]}` : m[2];
    const task = m[6] ? "[ ] " : "";
    const insert = `\n${m[1]}${marker}${m[5]}${task}`;
    return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
  }

  const q = QUOTE.exec(line);
  if (q && before.length >= q[0].length) {
    const insert = `\n${q[1]}`;
    return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
  }
  return null;
}

/**
 * 빈 항목·빈 인용 줄(표시만 있는 줄)에서 줄을 바꿀 때 — 그 목록·인용을 **끝낸다**. 그런 줄이 아니면 null.
 * 문서 편집기(LiveEditor)도 이것을 부른다(두 곳의 규칙이 갈리면 칸마다 다르게 보인다).
 *
 * 표시만 지우면 다음 글이 바로 위 항목·인용에 **붙는다**(71차) — 마크다운에서 빈 줄 없이 이어진 줄은 앞 문단에
 * 속한다(게으른 이어짐). `- 하나` 에서 Enter 두 번 뒤 `밖` 을 쓰면 `- 하나\n밖` 이 되어 읽기 보기에서 "하나 밖"
 * 한 항목이었고, 인용은 `> 말\n밖` 이 인용 안에 "말 밖" 으로 남았다(실측). 그래서 위 줄이 비어 있지 않으면 빈 줄을
 * 하나 둔다. 들여쓴 빈 항목은 끝내지 않고 한 단계 바깥 목록의 새 항목으로 옮긴다(편집기 CM6 와 같은 규칙).
 */
export function endsBlock(text: string, caret: number): Edit | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const nl = text.indexOf("\n", caret);
  const lineEnd = nl < 0 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);
  const m = LIST.exec(line);
  const q = QUOTE.exec(line);
  const emptyItem = m && !line.slice(m[0].length).trim() ? m : null;
  const emptyQuote = !emptyItem && q && /^\s*(?:>\s*)+$/.test(line) ? q : null;
  if (!emptyItem && !emptyQuote) return null;
  // 표시 앞·가운데에서 누른 것은 끝내기가 아니다(이어쓰기와 같은 조건)
  if (caret - lineStart < (emptyItem ?? emptyQuote)![0].length) return null;
  if (insideFence(text, lineStart)) return null;
  if (emptyItem && emptyItem[1]) {
    const parent = parentMarker(text, lineStart, emptyItem[1].length);
    if (parent !== null) {
      return { text: text.slice(0, lineStart) + parent + text.slice(lineEnd), caret: lineStart + parent.length };
    }
  }
  const prevStart = lineStart === 0 ? -1 : text.lastIndexOf("\n", lineStart - 2) + 1;
  const prevBlank = prevStart < 0 || !/\S/.test(text.slice(prevStart, lineStart - 1));
  const gap = prevBlank ? "" : "\n";
  return { text: text.slice(0, lineStart) + gap + text.slice(lineEnd), caret: lineStart + gap.length };
}

/** 들여쓴 빈 항목의 한 단계 바깥 목록 — 그 목록의 다음 항목 표시(번호면 다음 번호). 바깥 목록이 없으면 null. */
function parentMarker(text: string, lineStart: number, indent: number): string | null {
  let end = lineStart - 1;
  while (end > 0) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const l = text.slice(start, end);
    const pm = LIST.exec(l);
    if (pm && pm[1].length < indent) {
      const marker = pm[3] !== undefined ? `${Number(pm[3]) + 1}${pm[4]}` : pm[2];
      return `${pm[1]}${marker}${pm[5]}${pm[6] ? "[ ] " : ""}`;
    }
    // 들여쓰기가 더 얕은 보통 글줄을 만나면 바깥 목록이 아니다
    if (!pm && /\S/.test(l) && (/^\s*/.exec(l)?.[0].length ?? 0) < indent) return null;
    end = start - 1;
  }
  return null;
}
