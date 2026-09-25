import { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Dropdown } from "./Dropdown";

/**
 * 목록 줄 끝의 … 메뉴. 논문·회의 목록이 같은 모양(누름이 줄로 번지지 않게 막는 겉, 줄에 올렸을
 * 때·고른 줄에서만 보이는 단추)을 한 벌씩 들고 있었다 — 31차에 이름(label)이 빠진 것도 둘이 똑같았다.
 * 이름은 **꼭** 받는다(아이콘뿐인 단추라 없으면 화면 읽기 프로그램이 "단추"라고만 읽는다).
 */
export function RowMoreMenu({ label, width, active, children }: {
  label: string;
  width: number;
  /** 고른 줄이면 넓은 화면에서도 늘 보인다(아니면 줄에 올렸을 때·포커스일 때만) */
  active: boolean;
  children: (close: () => void) => ReactNode;
}) {
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Dropdown align="end" width={width} label={label}
        className={`tap grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-hovered hover:text-fg ${active ? "" : "sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"}`}
        trigger={() => <MoreHorizontal size={14} />}>
        {children}
      </Dropdown>
    </span>
  );
}
