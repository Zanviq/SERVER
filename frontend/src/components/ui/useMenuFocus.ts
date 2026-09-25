import { RefObject, useEffect, useRef } from "react";
import { menuKey } from "../../lib/menuKeys";

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
  "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * body 로 포탈한 메뉴를 키보드로 쓸 수 있게 한다 — 문서 줄 … 메뉴(RowMenu)와 드롭다운이 같이 쓴다.
 * 키마다 하는 일은 lib/menuKeys.ts 에 있다(왜 필요한지도 거기).
 *
 * - 열리면 첫 것이 메뉴 항목일 때 그리로 포커스를 옮긴다. 입력칸이면 옮기지 않는다
 *   (휴대폰에서 가상 자판이 튀어 오른다). 그때도 Tab·↓ 로 들어갈 수 있다.
 * - Esc 는 닫고 여는 단추로 돌아간다.
 * - 패널 안에 포커스가 있던 채로 닫히면(항목을 고름·스크롤로 닫힘) 여는 단추로 돌려준다.
 *   그러지 않으면 사라진 항목과 함께 포커스가 body 로 떨어져 다음 Tab 이 페이지 맨 위에서
 *   시작한다. 항목이 대화상자를 열면 대화상자가 제 칸으로 옮기고, 닫힐 때 이 단추로 돌아온다
 *   (Modal 은 "대화상자 밖에서 마지막으로 포커스를 가진 곳"으로 돌아간다).
 *
 * `ready` 는 패널이 화면에 있고 자리를 잡았을 때만 참이어야 한다(visibility:hidden 이면 focus 가 안 된다).
 */
export function useMenuFocus(
  ready: boolean,
  panel: RefObject<HTMLElement>,
  trigger: RefObject<HTMLElement>,
  close: () => void,
) {
  // 부르는 쪽이 매번 새 함수를 넘겨도 효과가 다시 돌지 않게(다시 돌면 첫 항목으로 포커스가 되감긴다)
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const p = panel.current;
    if (!ready || !p) return;
    const items = () => Array.from(p.querySelectorAll<HTMLElement>(FOCUSABLE));
    const put = (el: HTMLElement | null | undefined) => el?.focus({ preventScroll: true }); // 스크롤하면 닫히는 메뉴가 있다

    const first = items()[0];
    if (first?.getAttribute("role") === "menuitem") put(first);

    let inside = p.contains(document.activeElement);
    const onIn = () => { inside = true; };
    // 다른 요소로 **옮겨 갔을 때만** 밖이다. 고른 항목이 DOM 에서 빠질 때도 focusout 이 올 수 있는데
    // 그때 relatedTarget 은 null 이다 — 그것까지 "밖"으로 치면 돌려줘야 할 때 못 돌려준다.
    const onOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null;
      if (to && !p.contains(to)) inside = false;
    };

    const onKey = (e: KeyboardEvent) => {
      const t = trigger.current;
      const a = document.activeElement as HTMLElement | null;
      const list = items();
      const i = a ? list.indexOf(a) : -1;
      const onTrigger = !!t && a === t;
      if (e.key === "Escape") {
        // 다른 입력칸에 있는 포커스는 빼앗지 않는다
        if (onTrigger || i >= 0 || !a || a === document.body) {
          e.preventDefault();
          e.stopPropagation(); // 대화상자 안의 드롭다운이면 대화상자까지 닫히지 않게
          closeRef.current();
          put(t);
        }
        return;
      }
      if (!onTrigger && i < 0) return;
      const move = menuKey(e.key, e.shiftKey, onTrigger ? -1 : i, list.length, a?.getAttribute("role") === "menuitem");
      if (!move) return;
      if ("focus" in move) {
        e.preventDefault();
        put(list[move.focus]);
        return;
      }
      closeRef.current();
      if (onTrigger) return; // 단추에서 Shift+Tab — 기본대로 앞 요소로
      put(t);
      // 앞으로 떠날 때는 기본 Tab 을 막지 않는다: 이제 포커스가 단추에 있으니 단추 다음으로 간다
      if (move.leave === "back") e.preventDefault();
    };

    p.addEventListener("focusin", onIn);
    p.addEventListener("focusout", onOut);
    document.addEventListener("keydown", onKey, true);
    return () => {
      p.removeEventListener("focusin", onIn);
      p.removeEventListener("focusout", onOut);
      document.removeEventListener("keydown", onKey, true);
      const a = document.activeElement;
      if (inside && (!a || a === document.body) && trigger.current?.isConnected) put(trigger.current);
    };
  }, [ready, panel, trigger]);
}
