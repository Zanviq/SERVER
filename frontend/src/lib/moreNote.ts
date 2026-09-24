/**
 * "N개 더" 한 줄 — 목록을 상한에서 잘랐을 때 **말없이 자르지 않으려고** 쓴다.
 *
 * 링크 후보(8차)와 전체 검색(13차)이 같은 결함을 따로 가졌고 따로 고쳤다. 문구가 두 곳에
 * 있으면 한쪽만 바뀌어 같은 사정이 두 가지 말로 나온다 — 여기 하나로 둔다.
 *
 * atLeast: 끝까지 세지 못했다(본문 읽기를 한도에서 멈춤) — "N개 넘게".
 */
export function moreNote(n: number, hint: string, atLeast = false): string {
  return `… ${n}개${atLeast ? " 넘게" : ""} 더 있습니다 — ${hint}`;
}
