import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { api, CalEvent, Todo, TodoCategory } from "../lib/api";
import { toast } from "../store/toast";
import { useSettings } from "../store/settings";
import { useMediaQuery } from "../lib/useMediaQuery";

const CAL_SUGGESTIONS = [
  "이번 주 일정 정리해줘",
  "내일 오후 3시에 운동 일정 잡아줘",
  "다음 주 회의 가능한 빈 시간 찾아줘",
  "이번 달 할 일 뭐 남았어?",
];

/** 달력에 무엇을 그릴지. 일정과 할 일은 저장소가 달라 섞어 보면 헷갈린다. */
type CalMode = "events" | "todos";

// FullCalendar의 customButtons는 text/icon만 받는다(임의 DOM 불가). 눈 아이콘은
// 버튼이 붙은 뒤 DOM에 직접 넣는다 — 매 렌더 다시 넣으므로 FC가 다시 그려도 남는다.
const EYE_ON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>' +
  '<circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
  '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>' +
  '<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>' +
  '<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>' +
  '<path d="m2 2 20 20"/></svg>';

/** Date를 로컬 naive ISO("YYYY-MM-DDTHH:mm:ss")로. 저장 이벤트와 동일 규약. */
function localISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function Calendar() {
  const s = useSettings((st) => st.settings);
  const navigate = useNavigate();
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [todoCats, setTodoCats] = useState<TodoCategory[]>([]);
  const [mode, setMode] = useState<CalMode>("events");
  // 기본은 '완료도 보임'. 지운 게 아니라 끝낸 것이라 흔적이 남아야 한다.
  const [showDone, setShowDone] = useState(true);
  const [dialog, setDialog] = useState<Partial<CalEvent> | null>(null);
  const [source, setSource] = useState("internal");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false); // 저장/삭제 왕복 중
  const [chatColor, setChatColor] = useState<string | null>(null); // AI 채팅에서 지정할 색
  const range = useRef<{ from?: string; to?: string }>({});

  // Tailwind의 sm(640px) 경계와 맞춘다 — 사이드바가 하단 탭바로 바뀌는 지점이다.
  const isNarrow = useMediaQuery("(max-width: 639px)");

  const defaultColor = s?.calendar.default_color ?? "2";
  const defaultView = s?.calendar.default_view ?? "dayGridMonth";
  const weekStart = s?.calendar.week_start ?? 0;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // 두 갈래를 함께 받아 둔다 — 토글할 때마다 왕복하면 화면이 깜빡인다.
      const [evs, tds, cts] = await Promise.all([
        api.calEvents(range.current.from, range.current.to),
        api.todoList({
          from: range.current.from,
          to: range.current.to,
          include_undated: false, // 기한 없는 할 일은 달력에 놓을 자리가 없다
        }),
        api.todoCategories(),
      ]);
      setEvents(evs);
      setTodos(tds);
      setTodoCats(cts);
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
    // 할 일 보기에서 빈 칸을 누르면 '일정'이 만들어져 엉뚱한 곳에 쌓인다.
    // 할 일은 할 일 화면에서 만든다.
    if (mode === "todos") return;
    setDialog({
      start: `${arg.dateStr}T09:00:00`,
      end: `${arg.dateStr}T10:00:00`,
      allDay: arg.allDay,
      color: defaultColor,
    });
  };

  const onEventClick = (arg: EventClickArg) => {
    const id = arg.event.id;
    if (id.startsWith("todo:")) {
      // 할 일 편집은 할 일 화면이 담당한다(상세 폼이 거기 있다)
      navigate("/todo");
      return;
    }
    const ev = events.find((e) => e.id === id);
    if (ev) setDialog(ev);
  };

  const save = async (e: Partial<CalEvent>) => {
    if (busy) return; // 연타로 같은 일정이 두 번 만들어지는 것을 막는다
    setBusy(true);
    try {
      let saved: CalEvent;
      if (e.id) {
        // 반복 일정 인스턴스 편집은 시리즈 메타만 수정(시작/종료시간 보존)
        const payload = e.id.includes("@")
          ? { ...e, start: undefined, end: undefined, allDay: undefined }
          : e;
        saved = await api.calUpdate(e.id, payload);
      } else saved = await api.calCreate(e);
      setDialog(null);
      toast.ok("저장됨");
      // 서버가 돌려준 값을 바로 화면에 반영한다. reload()만 기다리면 왕복이 한 번 더
      // 걸려 "저장했는데 잠깐 안 보이는" 구간이 생긴다.
      // 반복 일정은 응답이 시리즈 1건이라 인스턴스로 펼치는 건 reload()에 맡긴다.
      if (saved && (saved.recurrence ?? "none") === "none") {
        setEvents((prev) => {
          const rest = prev.filter((x) => x.id !== saved.id && x.id !== e.id);
          return [...rest, saved];
        });
      }
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  };

  const del = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.calDelete(id);
      setDialog(null);
      toast.ok("삭제됨");
      setEvents((prev) => prev.filter((x) => x.id !== id)); // 즉시 사라지게
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "삭제 실패");
    } finally {
      setBusy(false);
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

  const eventItems = events.map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.allDay && e.end ? addDay(e.end) : e.end,
    allDay: e.allDay,
    backgroundColor: GCAL_COLORS[e.color] ?? GCAL_COLORS["2"],
    borderColor: GCAL_COLORS[e.color] ?? GCAL_COLORS["2"],
  }));

  /** 할 일 색: 직접 지정한 게 없으면 카테고리 색을 따른다(할 일 화면과 같은 규칙). */
  const todoColor = (t: Todo) =>
    t.color || todoCats.find((c) => c.id === t.category_id)?.color || "2";

  const todoItems = todos
    .filter((t) => showDone || !t.done)
    .map((t) => {
      const hex = GCAL_COLORS[todoColor(t)] ?? GCAL_COLORS["2"];
      return {
        id: `todo:${t.id}`,
        title: (t.done ? "✓ " : "") + t.title,
        start: t.due,
        allDay: t.all_day || t.due.length <= 10,
        // 완료한 것은 옅게 — 남은 것과 한눈에 구분되어야 한다
        backgroundColor: t.done ? "transparent" : hex,
        borderColor: hex,
        textColor: t.done ? "rgb(var(--fg-subtle))" : undefined,
        classNames: t.done ? ["fc-todo-done"] : ["fc-todo"],
      };
    });

  const fcEvents = mode === "events" ? eventItems : todoItems;

  const doneCount = todos.filter((t) => t.done).length;

  // customButtons가 만든 버튼에 눈 아이콘을 심는다(FC는 text/icon만 받는다).
  useEffect(() => {
    const btn = document.querySelector<HTMLButtonElement>(".fc-doneToggle-button");
    if (!btn) return;
    btn.innerHTML = showDone ? EYE_ON : EYE_OFF;
    btn.setAttribute("aria-label", showDone ? "완료한 할 일 숨기기" : "완료한 할 일 보기");
    btn.setAttribute("title", showDone ? "완료한 할 일 숨기기" : "완료한 할 일 보기");
    btn.setAttribute("aria-pressed", String(!showDone));
  });

  return (
    <Shell
      title="캘린더"
      actions={
        <div className="flex items-center gap-2">
          {loading && <Loader2 size={14} className="animate-spin text-fg-muted" />}
          {mode === "todos" ? (
            <span className="badge">
              할 일 {todos.length}개{showDone ? "" : ` (완료 ${doneCount}개 숨김)`}
            </span>
          ) : (
            <span className="badge">{source === "google" ? "Google 동기화" : "내부 저장"}</span>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
        {/* flex-1을 lg에서만 준다. 세로로 쌓이는 모바일에서 flex-1은 basis 0이라
            h-[70vh]를 눌러 버리고, 옆의 AI 패널이 높이를 다 가져가 달력이
            130px로 찌부러졌다(주 몇 줄만 보였다). */}
        <div className="card fc-server flex min-w-0 flex-col p-4 h-[70vh] lg:h-view-9 lg:flex-1">
          <div className="min-h-0 flex-1">
            <FullCalendar
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView={defaultView}
              firstDay={weekStart}
              locale="ko"
              // 좁은 화면에서 한 줄에 7개를 밀어넣으면 제목과 버튼이 서로 뭉갠다.
              // 모바일은 두 줄로 나눈다(위: 이동+제목, 아래: 보기 전환).
              customButtons={{
                modeToggle: {
                  text: mode === "events" ? "일정" : "할 일",
                  hint: "일정 / 할 일 전환",
                  click: () => setMode((m) => (m === "events" ? "todos" : "events")),
                },
                doneToggle: {
                  text: "완료",
                  hint: "완료한 할 일 표시",
                  click: () => setShowDone((v) => !v),
                },
              }}
              // 토글은 '<> 오늘' 바로 옆에 둔다. 눈 아이콘은 할 일 보기일 때만 나온다.
              headerToolbar={
                isNarrow
                  ? {
                      left: `prev,next ${mode === "todos" ? "modeToggle,doneToggle" : "modeToggle"}`,
                      center: "title",
                      right: "today",
                    }
                  : {
                      left: `prev,next today ${mode === "todos" ? "modeToggle,doneToggle" : "modeToggle"}`,
                      center: "title",
                      right: "dayGridMonth,timeGridWeek,timeGridDay",
                    }
              }
              footerToolbar={isNarrow ? { center: "dayGridMonth,timeGridWeek,timeGridDay" } : undefined}
              buttonText={{ today: "오늘", month: "월", week: "주", day: "일" }}
              // ko 로케일은 날짜를 "26일"로 낸다. 좁은 칸에서는 두 줄로 깨지므로
              // 숫자만 남긴다(요일은 열 머리글에 이미 있다).
              dayCellContent={isNarrow ? (a) => a.dayNumberText.replace("일", "") : undefined}
              // "+3 more"는 좁은 칸에서 "+3 mo"로 잘린다. 숫자만 보여준다.
              moreLinkContent={isNarrow ? (a) => `+${a.num}` : undefined}
              events={fcEvents}
              datesSet={onDatesSet}
              dateClick={onDateClick}
              eventClick={onEventClick}
              // 좁은 화면에서는 칸에 들어가는 만큼 채우면 색 막대만 잔뜩 쌓이고
              // '+N'이 안 나온다. 2개로 끊어 나머지를 팝오버(제목이 보이는 곳)로 보낸다.
              dayMaxEvents={isNarrow ? 2 : true}
              height="100%"
              nowIndicator
            />
          </div>
        </div>
        <div className="card flex h-[70vh] w-full flex-col p-4 lg:h-view-9 lg:w-[380px] lg:shrink-0">
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
        busy={busy}
        open={!!dialog}
        initial={dialog}
        onClose={() => setDialog(null)}
        onSave={save}
        onDelete={del}
      />
    </Shell>
  );
}
