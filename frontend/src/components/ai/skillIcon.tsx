import { LucideIcon } from "lucide-react";
import {
  Activity, AudioLines, BookMarked, CalendarClock, CalendarDays, FileText, FolderOpen,
  GraduationCap, ListChecks, MessageSquare, NotebookPen, Search, Sparkles, Trash2, Wrench,
} from "lucide-react";

/**
 * 스킬 → 아이콘. AI 가 무엇을 했는지 칩만 보고도 갈래가 잡히게 한다.
 *
 * **이름 규칙으로 고른다.** 스킬마다 한 줄씩 적는 표로 두면, 스킬을 더할 때마다
 * 그 표를 잊는다 — 라벨 표에서 실제로 그랬고(bulk_update_calendar_events 가
 * raw 이름으로 떴다), 그래서 라벨 쪽에는 "빠진 것"을 잡는 시험을 붙여 뒀다.
 * 아이콘은 아예 규칙으로 정해서 잊을 자리를 없앤다: 새 스킬도 이름만 갈래에
 * 맞으면 알아서 제 아이콘을 받는다.
 *
 * 규칙은 **위에서부터 먼저 맞는 것**을 쓴다. 순서가 뜻을 만든다 —
 * `search_paper_chats` 는 '논문'이 아니라 '지난 대화'로 읽혀야 자연스럽다.
 */
const RULES: [RegExp, LucideIcon][] = [
  [/^think$/, Sparkles],
  [/^shift_date$/, CalendarClock],
  [/^search_everything$/, Search],
  // 지난 대화 — 논문·회의 대화 검색도 여기다(자료가 아니라 대화를 뒤진다)
  [/context|_chats$/, MessageSquare],
  [/calendar|free_slots/, CalendarDays],
  [/todo/, ListChecks],
  [/vocab/, BookMarked],
  [/paper/, GraduationCap],
  [/meeting/, AudioLines],
  [/diary/, NotebookPen],
  [/trash/, Trash2],
  [/folder/, FolderOpen],
  [/document|backlinks/, FileText],
  [/system_status/, Activity],
];

/** 규칙에 안 걸리는 새 스킬도 칩은 뜬다 — 갈래만 모른다. */
export const FALLBACK_SKILL_ICON = Wrench;

export function skillIcon(name: string): LucideIcon {
  for (const [re, icon] of RULES) {
    if (re.test(name)) return icon;
  }
  return FALLBACK_SKILL_ICON;
}
