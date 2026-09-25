/**
 * 떠 있는 메뉴(body 로 포탈한 패널) 안에서 키 하나가 할 일. 화면 없이 시험하려고 DOM 과 떼어 둔다.
 *
 * 포탈한 패널은 DOM 맨 끝에 붙어서, 여는 단추 다음 Tab 은 패널이 아니라 그 줄의 다음 단추로
 * 간다. 39차 실측: 문서 줄 … 메뉴를 Enter 로 연 뒤 Tab 을 200번 눌러도 항목에 닿지 못했다 —
 * 이름 변경·이동·휴지통은 다른 진입점이 없어서 키보드만 쓰는 사람에게는 없는 기능이었다.
 *
 * - `i` 는 지금 포커스가 있는 항목의 차례, 여는 단추면 -1. `n` 은 패널에서 포커스 받을 것의 수.
 * - `onItem` 은 그것이 메뉴 항목(role=menuitem)인가. 입력칸 안의 화살표는 커서·값을 움직이므로 뺏지 않는다.
 * - `leave` 는 메뉴를 닫고 여는 단추로 돌아간다는 뜻. forward 면 거기서 브라우저 기본 Tab 이 이어진다.
 */
export type MenuMove = { focus: number } | { leave: "back" | "forward" } | null;

export function menuKey(key: string, shift: boolean, i: number, n: number, onItem: boolean): MenuMove {
  if (n === 0) return null;
  if (i < 0) {
    // 여는 단추에서: 아래로·Tab 은 패널 첫 항목으로, 위로는 끝 항목으로, Shift+Tab 은 메뉴를 두고 앞으로
    if (key === "ArrowDown" || (key === "Tab" && !shift)) return { focus: 0 };
    if (key === "ArrowUp") return { focus: n - 1 };
    if (key === "Tab" && shift) return { leave: "back" };
    return null;
  }
  if (key === "Tab") {
    if (shift && i === 0) return { leave: "back" };
    if (!shift && i === n - 1) return { leave: "forward" };
    return null; // 가운데서는 브라우저 기본 Tab(날짜 칸 같은 것을 지나간다)
  }
  if (!onItem) return null;
  switch (key) {
    case "ArrowDown": return { focus: (i + 1) % n };
    case "ArrowUp": return { focus: (i - 1 + n) % n };
    case "Home": return { focus: 0 };
    case "End": return { focus: n - 1 };
  }
  return null;
}
