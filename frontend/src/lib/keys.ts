import type { KeyboardEvent } from "react";

/**
 * "지금 Enter 는 제출인가?"
 *
 * 한글을 치는 동안 Enter 는 **조합을 확정하는 키**다. 그 keydown 을 제출로 받으면
 * 마지막 글자가 확정되기 전에 값이 읽혀 "회의록"이 "회의ㄹ"로 들어가거나, 한 번
 * 더 눌러야 하는 것처럼 보인다. 영문 자판에서는 티가 안 나서 놓치기 쉽다.
 *
 * 채팅 입력칸과 할 일 작성기는 각자 이 검사를 들고 있었는데, 이름 변경·새 문서·
 * 새 폴더처럼 **한국어를 더 많이 치는 자리**에는 빠져 있었다. 한 곳에 모아 둔다.
 */
export function isSubmitEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !(e.nativeEvent as unknown as { isComposing?: boolean }).isComposing;
}
