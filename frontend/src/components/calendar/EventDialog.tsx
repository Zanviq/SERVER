import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal } from "../ui/Modal";
import { CalEvent } from "../../lib/api";

export const GCAL_COLORS: Record<string, string> = {
  "1": "#7986cb", "2": "#33b679", "3": "#8e24aa", "4": "#e67c73",
  "5": "#f6bf26", "6": "#f4511e", "7": "#039be5", "8": "#616161",
  "9": "#3f51b5", "10": "#0b8043", "11": "#d50000",
};

// datetime-local 값 변환
const toLocal = (iso: string) => (iso ? iso.slice(0, 16) : "");
const toIso = (local: string) => (local ? `${local}:00` : "");

export function EventDialog({
  open,
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  initial: Partial<CalEvent> | null;
  onClose: () => void;
  onSave: (e: Partial<CalEvent>) => void;
  onDelete?: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [color, setColor] = useState("2");
  const [recurrence, setRecurrence] = useState("none");
  const [interval, setInterval] = useState(1);
  const [until, setUntil] = useState("");
  const [remind, setRemind] = useState(0);

  useEffect(() => {
    if (!initial) return;
    setTitle(initial.title ?? "");
    setDesc(initial.description ?? "");
    setAllDay(initial.allDay ?? false);
    setStart(toLocal(initial.start ?? ""));
    setEnd(toLocal(initial.end ?? initial.start ?? ""));
    setColor(initial.color ?? "2");
    setRecurrence(initial.recurrence ?? "none");
    setInterval(initial.interval ?? 1);
    setUntil(initial.recur_until ?? "");
    setRemind(initial.remind_minutes ?? 0);
  }, [initial]);

  const isEdit = !!initial?.id;

  const submit = () => {
    if (!title.trim() || !start) return;
    onSave({
      id: initial?.id,
      title: title.trim(),
      description: desc,
      allDay,
      start: allDay ? start.slice(0, 10) : toIso(start),
      end: allDay ? end.slice(0, 10) || start.slice(0, 10) : toIso(end || start),
      color,
      recurrence,
      interval: Math.max(1, interval),
      recur_until: until,
      remind_minutes: remind,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? "일정 수정" : "새 일정"} width="max-w-md">
      <div className="space-y-3">
        <div>
          <label className="label mb-1 block">제목</label>
          <input autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="일정 제목" />
        </div>
        <div>
          <label className="label mb-1 block">설명</label>
          <textarea className="input h-auto py-2" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          하루 종일
        </label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label mb-1 block">시작</label>
            <input
              type={allDay ? "date" : "datetime-local"}
              className="input"
              value={allDay ? start.slice(0, 10) : start}
              onChange={(e) =>
                setStart(allDay ? `${e.target.value}T${start.slice(11) || "09:00"}` : e.target.value)
              }
            />
          </div>
          <div>
            <label className="label mb-1 block">종료</label>
            <input
              type={allDay ? "date" : "datetime-local"}
              className="input"
              value={allDay ? end.slice(0, 10) : end}
              onChange={(e) =>
                setEnd(allDay ? `${e.target.value}T${end.slice(11) || "10:00"}` : e.target.value)
              }
            />
          </div>
        </div>
        <div>
          <label className="label mb-1 block">색상</label>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(GCAL_COLORS).map(([id, hex]) => (
              <button key={id} onClick={() => setColor(id)}
                aria-label={`색상 ${id}`} aria-pressed={color === id} title={`색상 ${id}`}
                className={`h-6 w-6 rounded-full border-2 ${color === id ? "border-fg" : "border-transparent"}`}
                style={{ background: hex }} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label mb-1 block">반복</label>
            <select className="input" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
              <option value="none">안 함</option>
              <option value="daily">매일</option>
              <option value="weekly">매주</option>
              <option value="monthly">매월</option>
              <option value="yearly">매년</option>
            </select>
          </div>
          <div>
            <label className="label mb-1 block">알림</label>
            <select className="input" value={remind} onChange={(e) => setRemind(+e.target.value)}>
              <option value={0}>없음</option>
              <option value={10}>10분 전</option>
              <option value={30}>30분 전</option>
              <option value={60}>1시간 전</option>
              <option value={1440}>1일 전</option>
            </select>
          </div>
        </div>
        {recurrence !== "none" && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label mb-1 block">간격</label>
              <input type="number" min={1} max={99} className="input" value={interval}
                onChange={(e) => setInterval(Math.max(1, +e.target.value))} />
            </div>
            <div>
              <label className="label mb-1 block">종료일(선택)</label>
              <input type="date" className="input" value={until} onChange={(e) => setUntil(e.target.value)} />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          {isEdit && onDelete ? (
            <button onClick={() => onDelete(initial!.id!)} className="btn btn-danger">
              <Trash2 size={14} /> 삭제
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="btn btn-ghost">취소</button>
            <button onClick={submit} className="btn btn-primary">저장</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
