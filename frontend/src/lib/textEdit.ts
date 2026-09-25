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
