import { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookOpen, CalendarDays, CheckSquare, FileText, Folder, Languages, Link2, Mic, NotebookPen,
} from "lucide-react";
import { splitLink } from "../../lib/links";
import type { LinkKind } from "../../lib/links";
import { openLink } from "./linkFetch";

/** 갈래별 아이콘. 검색 팔레트와 같은 그림을 쓴다(같은 것은 같게 보여야 한다). */
export const LINK_ICONS: Record<LinkKind, typeof FileText> = {
  note: FileText, paper: BookOpen, meeting: Mic, todo: CheckSquare,
  event: CalendarDays, vocab: Languages, diary: NotebookPen,
};

export function linkIcon(kind: string, folder = false): typeof FileText {
  if (folder) return Folder;
  return LINK_ICONS[kind as LinkKind] ?? Link2;
}

/** 글 속의 `[note/…]` 링크. 누르면 그 항목의 화면으로 간다(openLink). */
export function LinkChip({ path, children }: { path: string; children: ReactNode }) {
  const navigate = useNavigate();
  const Icon = linkIcon(splitLink(path).kind ?? "");
  return (
    <button
      type="button"
      onClick={() => void openLink(path, navigate)}
      title={path}
      className="link-chip inline-flex max-w-full items-baseline gap-1 rounded bg-info/10 px-1 align-baseline font-medium text-info hover:bg-info/20"
    >
      <Icon size={12} className="shrink-0 translate-y-[1px]" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </button>
  );
}
