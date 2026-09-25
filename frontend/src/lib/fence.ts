/**
 * 코드 울타리(``` · ~~~)의 규칙 — 읽기 뷰의 위키링크 풀이(wikiTransform)와 입력칸의 목록
 * 이어 쓰기(mdInput)가 같은 것을 쓴다(백엔드 notes_graph 도 같은 규칙).
 *
 * 닫는 울타리는 **연 것과 같은 글자**이고 **길이가 같거나 길어야** 한다. 길이를 3으로 뭉개면
 * ````` 로 연 울타리 안의 ``` 줄이 울타리를 닫아 버려서, 코드 예시 속 글이 코드 밖으로 샌다.
 */
export function closesFence(open: string, marker: string): boolean {
  return marker[0] === open[0] && marker.length >= open.length;
}
