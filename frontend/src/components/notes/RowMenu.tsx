import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Pencil, FolderInput, Trash2 } from "lucide-react";
import { REVEAL_ON_ROW } from "../ui/reveal";
import { useMenuFocus } from "../ui/useMenuFocus";

/**
 * 문서 트리 줄의 "..." 컨텍스트 메뉴(이름 변경 / 이동 / 휴지통).
 * 외부 클릭·ESC로 닫힌다. 문서 줄과 폴더 줄이 같이 쓴다 — 폴더도 끌기만으로
 * 옮길 수 있으면 터치·키보드에선 옮길 길이 없다(38차).
 *
 * 메뉴는 **body로 포탈**한다. 행이 들어 있는 문서 목록은 overflow-auto라,
 * 예전처럼 행 안에 absolute로 두면 목록 아래쪽 행에서는 메뉴가 통째로 잘려
 * 화면에 아예 안 나온다(실측: 목록 206~391px인데 메뉴가 532~636px에 열렸다).
 * 모바일에서는 이 메뉴가 문서를 옮기는 유일한 수단이라 치명적이다.
 */
const MENU_W = 132;
const MENU_H = 104;

export function RowMenu({ onRename, onMove, onTrash }: {
  onRename: () => void;
  onMove: () => void;
  onTrash: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    // 아래로 열 자리가 없으면 위로 뒤집는다. 좌우도 화면 안으로 눌러 넣는다.
    const below = window.innerHeight - b.bottom;
    const top = below >= MENU_H + 8 ? b.bottom + 4 : Math.max(8, b.top - MENU_H - 4);
    const left = Math.min(Math.max(8, b.right - MENU_W), window.innerWidth - MENU_W - 8);
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    // 목록을 스크롤하면 메뉴만 제자리에 떠 있게 되므로 닫는다(위치 추적보다 단순·안전).
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true); // capture: 안쪽 스크롤 컨테이너까지
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open]);

  // 키보드(Esc·Tab·화살표)와 닫힌 뒤 포커스 되돌리기는 드롭다운과 같은 규칙으로(39차)
  useMenuFocus(open && !!pos, menuRef, btnRef, () => setOpen(false));

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="더보기" aria-label="더보기" aria-expanded={open}
        // 보이는 때의 까닭은 REVEAL_ON_ROW. 열려 있는 동안은 늘 보인다.
        className={`grid h-7 w-7 place-items-center rounded text-fg-muted transition-opacity hover:text-fg ${
          open ? "" : REVEAL_ON_ROW
        }`}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          // z는 탭바(40)보다 위, Modal(50)보다 아래
          className="fixed z-[45] overflow-hidden rounded-md border border-line bg-surface py-1 shadow-lg"
          style={{ top: pos.top, left: pos.left, width: MENU_W }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <MenuItem icon={Pencil} label="이름 변경" onClick={() => { setOpen(false); onRename(); }} />
          <MenuItem icon={FolderInput} label="이동" onClick={() => { setOpen(false); onMove(); }} />
          <MenuItem icon={Trash2} label="휴지통으로" danger onClick={() => { setOpen(false); onTrash(); }} />
        </div>,
        document.body,
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: {
  icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button onClick={onClick} role="menuitem"
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-hovered ${danger ? "text-danger" : "text-fg2"}`}>
      <Icon size={13} className="shrink-0" /> {label}
    </button>
  );
}
