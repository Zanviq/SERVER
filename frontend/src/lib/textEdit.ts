/**
 * 글 두 벌 사이에서 **바뀐 한 조각** — 앞뒤로 같은 부분을 걷어 낸 나머지.
 *
 * 입력칸의 값을 스크립트로 통째로 넣으면 브라우저가 되돌리기(Ctrl+Z) 기록을 지운다. 바뀐
 * 조각만 브라우저의 편집 명령으로 넣어야 기록이 산다(components/links/useMarkdownInput).
 * `before` 의 [from, to) 를 `insert` 로 바꾸면 `after` 가 된다.
 */
export function diffRange(before: string, after: string): { from: number; to: number; insert: string } {
  const max = Math.min(before.length, after.length);
  let from = 0;
  while (from < max && before[from] === after[from]) from++;
  let endB = before.length;
  let endA = after.length;
  while (endB > from && endA > from && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  return { from, to: endB, insert: after.slice(from, endA) };
}

type Field = HTMLTextAreaElement | HTMLInputElement;

/** 리액트가 모르게 값을 바꾸면 onChange 가 안 불린다. 원래 setter 로 넣는다(input 은 부르는 쪽이 쏜다). */
function setNativeValue(el: Field, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
}

/**
 * 입력칸의 값을 `next` 로 바꾸고 커서를 `caret` 에 둔다 — **되돌리기(Ctrl+Z)가 살아 있게.**
 *
 * 값을 통째로 넣으면(setNativeValue) 브라우저가 되돌리기 기록을 지운다. 24차 실측: 목록이 한 번
 * 이어지거나 링크 후보를 한 번 고르면, 그 전에 친 글까지 Ctrl+Z 가 아무것도 되돌리지 못했다.
 * 바뀐 조각만(diffRange) 브라우저의 편집 명령으로 넣는다 — 기록에 한 걸음으로 남고, 진짜 input
 * 이벤트가 나가 리액트도 안다. 명령을 못 쓰는 브라우저에서만 예전처럼 통째로 넣는다.
 * 입력칸의 값을 코드로 바꾸는 곳은 모두 이것을 쓴다.
 */
export function replaceFieldValue(el: Field, next: string, caret: number) {
  const { from, to, insert } = diffRange(el.value, next);
  el.focus();
  el.setSelectionRange(from, to);
  const ok = insert
    ? document.execCommand("insertText", false, insert)
    : document.execCommand("delete", false);
  if (!ok || el.value !== next) {
    setNativeValue(el, next);
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  el.setSelectionRange(caret, caret);
}
