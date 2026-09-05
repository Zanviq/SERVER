import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Pencil, FolderInput, Trash2 } from "lucide-react";

/**
 * 파일/문서 행의 "..." 컨텍스트 메뉴(이름 변경 / 이동 / 휴지통).
 * 외부 클릭·ESC로 닫힌다. 노트·AI문서 양쪽에서 공용으로 쓴다.
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
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // 목록을 스크롤하면 메뉴만 제자리에 떠 있게 되므로 닫는다(위치 추적보다 단순·안전).
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true); // capture: 안쪽 스크롤 컨테이너까지
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open]);

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="더보기" aria-label="더보기" aria-expanded={open}
        // 터치 기기엔 hover가 없다. hover로만 띄우면 모바일에서 이름 변경·이동·휴지통이
        // 영영 안 눌린다(드래그 이동도 HTML5 DnD라 터치에선 안 된다). 좁은 화면은 항상 표시.
        //
        // 넓은 화면에서도 `hidden` 은 쓰지 않는다. display:none 은 탭 순서에서
        // 통째로 빠지는데, 이름 변경·이동·삭제는 다른 진입점이 없어서 키보드만
        // 쓰는 사람은 그 기능에 영영 닿지 못한다. 투명하게만 두고 포커스로도 켠다.
        className={`grid h-7 w-7 place-items-center rounded text-fg-muted transition-opacity hover:text-fg ${
          open ? "" : "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
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
