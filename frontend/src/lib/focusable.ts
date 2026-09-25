/**
 * Tab 으로 닿는 것들. 대화상자의 Tab 가두기(Modal)와 떠 있는 메뉴의 키보드(useMenuFocus)가 같이 쓴다 —
 * 둘이 다른 목록을 쓰면 한쪽에서는 닿는 칸이 다른 쪽에서는 건너뛰어진다.
 * 결과는 문서 순서다(선택자 안의 순서와 무관).
 */
export const FOCUSABLE =
  "a[href], button:not([disabled]), textarea:not([disabled]), " +
  "input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";
