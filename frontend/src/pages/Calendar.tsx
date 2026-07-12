import { useCallback, useEffect, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { DateClickArg } from "@fullcalendar/interaction";
import type { DatesSetArg, EventClickArg } from "@fullcalendar/core";
import { Loader2, Bot } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { EventDialog, GCAL_COLORS, GCAL_COLOR_NAMES } from "../components/calendar/EventDialog";
import { ChatPanel } from "../components/ai/ChatPanel";
import { api, CalEvent } from "../lib/api";
import { toast } from "../store/toast";
import { useSettings } from "../store/settings";

const CAL_SUGGESTIONS = [
  "이번 주 일정 정리해줘",
  "내일 오후 3시에 운동 일정 잡아줘",
  "다음 주 회의 가능한 빈 시간 찾아줘",
  "이번 달 일정 몇 개야?",
];

/** Date를 로컬 naive ISO("YYYY-MM-DDTHH:mm:ss")로. 저장 이벤트와 동일 규약. */
function localISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function Calendar() {
  const s = useSettings((st) => st.settings);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [dialog, setDialog] = useState<Partial<CalEvent> | null>(null);
  const [source, setSource] = useState("internal");
  const [loading, setLoading] = useState(false);
  const [chatColor, setChatColor] = useState<string | null>(null); // AI 채팅에서 지정할 색
  const range = useRef<{ from?: string; to?: string }>({});

  const defaultColor = s?.calendar.default_color ?? "2";
  const defaultView = s?.calendar.default_view ?? "dayGridMonth";
  const weekStart = s?.calendar.week_start ?? 0;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await api.calEvents(range.current.from, range.current.to));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "이벤트 로드 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  // 캘린더 백엔드(source)는 세션 중 바뀌지 않으므로 1회만 조회
  useEffect(() => {
    api.calSource().then((r) => setSource(r.source)).catch(() => {});
  }, []);

  const onDatesSet = (arg: DatesSetArg) => {
    range.current = { from: localISO(arg.start), to: localISO(arg.end) };
    reload();
  };

  const onDateClick = (arg: DateClickArg) => {
    setDialog({
      start: `${arg.dateStr}T09:00:00`,
      end: `${arg.dateStr}T10:00:00`,
      allDay: arg.allDay,
      color: defaultColor,
    });
  };

  const onEventClick = (arg: EventClickArg) => {
    const ev = events.find((e) => e.id === arg.event.id);
    if (ev) setDialog(ev);
  };

  const save = async (e: Partial<CalEvent>) => {
    try {
      if (e.id) {
        // 반복 일정 인스턴스 편집은 시리즈 메타만 수정(시작/종료시간 보존)
        const payload = e.id.includes("@")
          ? { ...e, start: undefined, end: undefined, allDay: undefined }
          : e;
        await api.calUpdate(e.id, payload);
      } else await api.calCreate(e);
      setDialog(null);
      toast.ok("저장됨");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "저장 실패");
    }
  };

  const del = async (id: string) => {
    try {
      await api.calDelete(id);
      setDialog(null);
      toast.ok("삭제됨");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "삭제 실패");
    }
  };

  // 종일 일정의 종료일은 모델에선 '포함(inclusive)'이지만 FullCalendar는 '배타적' →
  // 마지막 날이 그려지도록 +1일 해서 넘긴다. (시간 일정은 그대로)
  const addDay = (d: string) => {
    const dt = new Date(`${d.slice(0, 10)}T00:00:00`);
    dt.setDate(dt.getDate() + 1);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  };

  const fcEvents = events.map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.allDay && e.end ? addDay(e.end) : e.end,
    allDay: e.allDay,
    backgroundColor: GCAL_COLORS[e.color] ?? GCAL_COLORS["2"],
    borderColor: GCAL_COLORS[e.color] ?? GCAL_COLORS["2"],
  }));

  return (
    <Shell
      title="캘린더"
      actions={
        <div className="flex items-center gap-2">
          {loading && <Loader2 size={14} className="animate-spin text-fg-muted" />}
          <span className="badge">{source === "google" ? "Google 동기화" : "내부 저장"}</span>
        </div>
      }
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="card fc-server min-w-0 flex-1 p-4">
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView={defaultView}
            firstDay={weekStart}
            locale="ko"
            headerToolbar={{
              left: "prev,next today",
              center: "title",
              right: "dayGridMonth,timeGridWeek,timeGridDay",
            }}
            buttonText={{ today: "오늘", month: "월", week: "주", day: "일" }}
            events={fcEvents}
            datesSet={onDatesSet}
            dateClick={onDateClick}
            eventClick={onEventClick}
            dayMaxEvents={3}
            height="auto"
            nowIndicator
          />
        </div>
        <div className="card flex h-[70vh] w-full flex-col p-4 lg:h-[calc(100vh-9rem)] lg:w-[380px] lg:shrink-0">
          <div className="mb-2 flex items-center gap-2 border-b border-line/50 pb-2 text-sm font-semibold">
            <Bot size={16} className="text-accent" /> AI 일정 비서
          </div>
          <ChatPanel
            className="flex-1"
            suggestions={CAL_SUGGESTIONS}
            onToolSuccess={reload}
            transformMessage={(t) =>
              chatColor ? `${t}\n(이 일정의 색상은 '${GCAL_COLOR_NAMES[chatColor]}'으로 설정해줘)` : t
            }
            composerTop={
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-fg-muted">색상:</span>
                <button
                  onClick={() => setChatColor(null)}
                  title="자동(규칙/기본색)"
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${chatColor === null ? "border-accent bg-accent-muted text-accent-fg" : "border-line text-fg-muted"}`}
                >
                  자동
                </button>
                {Object.entries(GCAL_COLORS).map(([id, hex]) => (
                  <button
                    key={id}
                    onClick={() => setChatColor(id)}
                    aria-label={GCAL_COLOR_NAMES[id]}
                    title={GCAL_COLOR_NAMES[id]}
                    className={`h-5 w-5 rounded-full border-2 ${chatColor === id ? "border-fg" : "border-transparent"}`}
                    style={{ background: hex }}
                  />
                ))}
              </div>
            }
          />
        </div>
      </div>
      <EventDialog
        open={!!dialog}
        initial={dialog}
        onClose={() => setDialog(null)}
        onSave={save}
        onDelete={del}
      />
    </Shell>
  );
}
