import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Pencil, FolderInput, Trash2 } from "lucide-react";

/**
 * 파일/문서 행의 "..." 컨텍스트 메뉴(이름 변경 / 이동 / 휴지통).
 * 외부 클릭·ESC로 닫힌다. 노트·AI문서 양쪽에서 공용으로 쓴다.
 */
export function RowMenu({ onRename, onMove, onTrash }: {
  onRename: () => void;
  onMove: () => void;
  onTrash: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} title="더보기" aria-label="더보기"
        className={`rounded p-1 text-fg-muted hover:text-fg ${open ? "block" : "hidden group-hover:block"}`}>
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 w-32 overflow-hidden rounded-md border border-line bg-surface py-1 shadow-lg">
          <MenuItem icon={Pencil} label="이름 변경" onClick={() => { setOpen(false); onRename(); }} />
          <MenuItem icon={FolderInput} label="이동" onClick={() => { setOpen(false); onMove(); }} />
          <MenuItem icon={Trash2} label="휴지통으로" danger onClick={() => { setOpen(false); onTrash(); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: {
  icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-hovered ${danger ? "text-danger" : "text-fg2"}`}>
      <Icon size={13} className="shrink-0" /> {label}
    </button>
  );
}
