import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { api, CalEvent, DiaryAxis, DiaryDay, DiaryShape } from "../../lib/api";
import { toast } from "../../store/toast";
import { useSettings } from "../../store/settings";
import { PendingSave } from "../../lib/pendingSave";
import { AXES, AXIS_LABEL, SHAPES, SHAPE_LABEL, ShapeIcon } from "./DiaryShapes";

interface Props {
  /** YYYY-MM-DD */
  date: string;
  /** 없으면 아직 기록이 없는 날 */
  entry?: DiaryDay;
  /** 그날에 걸친 일정(읽기 전용으로 보여만 준다) */
  events: CalEvent[];
  /** 저장이 끝나면 부모의 달력 표시를 갱신한다 */
  onChange: (entry: DiaryDay) => void;
}

function emptyEntry(date: string): DiaryDay {
  return { date, body: "", heart: "", mind: "", text: "", updated_at: "" };
}

function koreanDate(day: string): string {
  const [y, m, d] = day.split("-");
  return `${y}년 ${m}월 ${d}일`;
}

/** 일정이 그날에 걸치는가. 종일 일정의 end 는 포함(inclusive)이다. */
function onDay(e: CalEvent, day: string): boolean {
  const start = e.start.slice(0, 10);
  let end = (e.end || e.start).slice(0, 10);
  // 시간 일정이 자정에 끝나면 다음 날 00:00 이지 다음 날 일정이 아니다
  if (!e.allDay && e.end && e.end.length > 10 && e.end.slice(11, 16) === "00:00" && end > start) {
    const dt = new Date(`${end}T00:00:00`);
    dt.setDate(dt.getDate() - 1);
    const p = (n: number) => String(n).padStart(2, "0");
    end = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }
  return start <= day && day <= end;
}

function timeOf(e: CalEvent): string {
  if (e.allDay || e.start.length <= 10) return "종일";
  return e.start.slice(11, 16);
}

/**
 * 하루의 상태(육체·마음·정신)와 일기. 날짜와 일정은 달력이 채워 주고,
 * 사용자는 도형과 글만 고친다. 도형은 누르는 즉시, 글은 잠시 뒤 자동 저장.
 */
export function DiaryPanel({ date, entry, events, onChange }: Props) {
  const autosaveMs = useSettings((st) => st.settings?.notes.autosave_ms ?? 900);
  const cur = entry ?? emptyEntry(date);
  const [text, setText] = useState(cur.text);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const pending = useRef(new PendingSave());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const dateRef = useRef(date);
  dateRef.current = date;

  // 날짜가 바뀌면 글을 새 날의 것으로 바꾼다. 떠나기 전에 남은 저장은 먼저 보낸다
  // (타이머가 뜨기 전에 다른 날을 누르면 마지막 문장이 사라졌다).
  useEffect(() => {
    return () => {
      void pending.current.flush();
    };
  }, [date]);
  useEffect(() => {
    setText(entry?.text ?? "");
    setDirty(false);
    // entry 는 저장 응답으로도 바뀌는데, 그때 입력 중인 글을 덮으면 안 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const dayEvents = useMemo(
    () => events.filter((e) => onDay(e, date)).sort((a, b) => a.start.localeCompare(b.start)),
    [events, date],
  );

  const pick = async (axis: DiaryAxis, shape: DiaryShape) => {
    // 같은 도형을 다시 누르면 지운다 — '표시 안 함'으로 돌아가는 유일한 길이다.
    const next: DiaryShape = cur[axis] === shape ? "" : shape;
    // 글을 치는 중이면 그것도 함께 보낸다(따로 가면 뒤늦은 저장이 도형을 되돌리진
    // 않지만, 응답으로 오는 entry 가 옛 글이라 화면이 흔들린다).
    const patch: Partial<DiaryDay> = { [axis]: next };
    if (dirty) patch.text = text;
    setSaving(true);
    try {
      const saved = await api.diarySave(date, patch);
      if (dirty) {
        pending.current.cancel();
        setDirty(false);
      }
      onChangeRef.current(saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  };

  const onText = (v: string) => {
    setText(v);
    setDirty(true);
    const day = date;
    pending.current.schedule(autosaveMs, async () => {
      setSaving(true);
      try {
        const saved = await api.diarySave(day, { text: v });
        onChangeRef.current(saved);
        // 떠난 날의 저장이 늦게 끝났다면 새 날의 '입력 중' 표시를 건드리지 않는다
        if (dateRef.current === day) setDirty(false);
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "일기 저장 실패");
        return false;
      } finally {
        setSaving(false);
      }
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 text-sm">
      {/* 상태 — 세 축, 다섯 도형 */}
      <div className="space-y-1.5">
        {AXES.map((axis) => (
          <div key={axis} className="flex items-center gap-2">
            <span className="w-9 shrink-0 text-fg-muted">{AXIS_LABEL[axis]}:</span>
            <div className="flex items-center gap-1">
              {SHAPES.map((shape) => {
                const on = cur[axis] === shape;
                return (
                  <button
                    key={shape}
                    type="button"
                    onClick={() => pick(axis, shape)}
                    aria-pressed={on}
                    aria-label={`${AXIS_LABEL[axis]} ${SHAPE_LABEL[shape]}`}
                    title={SHAPE_LABEL[shape]}
                    // 도형이 제 색을 쓰므로 고른 것을 색으로 알릴 수 없다. 고른
                    // 것은 테두리와 배경으로, 안 고른 것은 흐리게 — 그래도 색은
                    // 남아 있어서 무엇을 고르는 중인지 보인다.
                    className={`rounded-md p-1.5 transition-all hover:bg-hovered ${
                      on ? "bg-accent-muted ring-1 ring-inset ring-accent" : "opacity-60 hover:opacity-100"
                    }`}
                  >
                    <ShapeIcon shape={shape} size={20} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <hr className="border-line/60" />

      {/* 날짜와 일정 — 달력이 채운다 */}
      <div className="min-h-0 shrink-0 space-y-1">
        <div>
          <span className="text-fg-muted">날짜:</span> {koreanDate(date)}
        </div>
        <div className="text-fg-muted">오늘 일정 목록</div>
        {dayEvents.length === 0 ? (
          <div className="text-fg-subtle">- 일정 없음</div>
        ) : (
          <ul className="max-h-32 space-y-0.5 overflow-y-auto">
            {dayEvents.map((e) => (
              <li key={e.id} className="flex items-baseline gap-2 truncate">
                <span className="shrink-0 text-fg-subtle">-</span>
                <span className="truncate">{e.title}</span>
                <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">{timeOf(e)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <hr className="border-line/60" />

      {/* 일기 */}
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-fg-muted">일기</span>
          <span className="flex items-center gap-1 text-[11px] text-fg-subtle">
            {saving ? (
              <><Loader2 size={11} className="animate-spin" /> 저장 중</>
            ) : dirty ? (
              "입력 중"
            ) : cur.updated_at || text ? (
              <><Check size={11} /> 저장됨</>
            ) : null}
          </span>
        </div>
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="오늘 어땠는지 적어 두세요."
          className="input min-h-[120px] flex-1 resize-none leading-relaxed"
        />
      </div>
    </div>
  );
}
