import { useEffect, useState } from "react";

/**
 * CSS 미디어 쿼리를 리액트 상태로. Tailwind로 못 푸는 경우에만 쓴다 —
 * 클래스를 바꾸는 게 아니라 **컴포넌트에 다른 props를 줘야 할 때**
 * (예: FullCalendar의 headerToolbar 구성)에만 필요하다.
 *
 * 초기값을 false로 두면 첫 페인트가 항상 데스크톱 모양이라 모바일에서 화면이
 * 한 번 덜컥인다. 그래서 최초 렌더에서 바로 matchMedia를 읽는다.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on(); // query가 바뀌었을 수 있다
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);

  return matches;
}

/** 손가락으로 쓰는 화면인가 — 자판 단축키(↑↓·Esc·Shift+Enter)를 기대할 수 없는 곳. */
export const TOUCH = "(pointer: coarse)";

/** TOUCH 를 리액트 상태로. 채팅 줄바꿈 키·링크 후보 안내가 같은 판단을 쓴다. */
export function useTouch(): boolean {
  return useMediaQuery(TOUCH);
}
