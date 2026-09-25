/**
 * 입력칸의 마크다운 쓰기 도움 — 목록·인용을 이어 쓴다.
 *
 * 문서 편집기(CodeMirror)는 `- 첫째` 뒤에서 줄을 바꾸면 `- ` 를 이어 주는데, 채팅·할 일
 * 설명·일기 같은 다른 입력칸은 그냥 줄만 바꿨다. 같은 앱에서 목록을 쓰는 방법이 칸마다
 * 다르면 "마크다운이 안 된다"로 보인다. 규칙은 편집기와 같게 한다:
 *
 *   - 목록 줄에서 줄을 바꾸면 같은 표시를 잇는다(번호는 하나 올린다, 체크박스는 빈 칸으로).
 *   - **빈 항목**에서 줄을 바꾸면 목록을 끝낸다(표시를 지운다).
 *   - 인용(`> `)도 같다.
 *
 * 화면 없이 시험한다(test/mdInput.test.mjs).
 */

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
    else if (m[1][0] === open[0] && m[1].length >= open.length) open = null;
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

  const m = LIST.exec(line);
  if (m && before.length >= m[0].length) {
    const body = line.slice(m[0].length).trim();
    if (!body) {
      // 빈 항목 — 목록을 끝낸다(표시만 지우고 들여쓰기는 남긴다)
      const next = text.slice(0, lineStart) + m[1] + text.slice(lineEnd);
      return { text: next, caret: lineStart + m[1].length };
    }
    const marker = m[3] !== undefined ? `${Number(m[3]) + 1}${m[4]}` : m[2];
    const task = m[6] ? "[ ] " : "";
    const insert = `\n${m[1]}${marker}${m[5]}${task}`;
    return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
  }

  const q = QUOTE.exec(line);
  if (q && before.length >= q[0].length) {
    if (!line.slice(q[0].length).trim()) {
      const next = text.slice(0, lineStart) + text.slice(lineEnd);
      return { text: next, caret: lineStart };
    }
    const insert = `\n${q[1]}`;
    return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
  }
  return null;
}
