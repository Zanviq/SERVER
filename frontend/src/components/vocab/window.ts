/**
 * 단어장 목록을 몇 개까지 그릴지.
 *
 * 단어장은 **끝없이 쌓이는 목록**이다(1년 모으면 수천 개). 전부 그리면 카드 하나가
 * DOM 노드 20개쯤이라 3000개에서 63,866개가 됐다 — 실측(390px, 데스크톱 CPU):
 * 첫 카드까지 3.5초, 다 그릴 때까지 8.4초. 휴대폰은 여기서 몇 배 더 걸린다.
 *
 * 규칙이 두 개뿐이지만 둘 다 조용히 깨지기 쉬워서 따로 뺐다.
 *   - **거르기는 언제나 전체에 대고 한다.** 먼저 자르고 거르면 "word2999" 를
 *     검색해도 안 나온다 — 넣은 단어가 사라진 것처럼 보인다.
 *   - 찾아온 단어(focus)가 창 밖이면 창을 늘린다. 그러지 않으면 전역 검색에서
 *     골라 들어왔는데 아무 일도 일어나지 않는다(DOM 에 없으니 열리지도 않는다).
 */

/** 한 번에 그리는 개수 */
export const PAGE = 150;

export interface Window<T> {
  /** 실제로 그릴 것 */
  visible: T[];
  /** 아직 안 그린 개수. 0 이 아니면 **몇 개를 감췄는지 말해야 한다.** */
  hidden: number;
}

export function windowOf<T>(all: T[], shown: number): Window<T> {
  const n = Math.max(0, Math.min(shown, all.length));
  return { visible: all.slice(0, n), hidden: all.length - n };
}

/**
 * focus 한 항목이 창 밖이면 필요한 만큼 늘린 값. 안이면 그대로.
 * `index` 는 **거른 뒤 목록에서의 자리**여야 한다(없으면 -1).
 */
export function shownForFocus(index: number, shown: number): number {
  return index >= 0 && index >= shown ? index + 1 : shown;
}
