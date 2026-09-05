import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { DateClickArg } from "@fullcalendar/interaction";
import type { DatesSetArg, DayCellContentArg, EventClickArg, EventContentArg } from "@fullcalendar/core";
import { Loader2, Bot, NotebookPen } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { EventDialog, GCAL_COLORS, GCAL_COLOR_NAMES } from "../components/calendar/EventDialog";
import { DiaryPanel } from "../components/calendar/DiaryPanel";
import { DiaryCell } from "../components/calendar/DiaryShapes";
import { ChatPanel } from "../components/ai/ChatPanel";
import { api, CalEvent, DiaryDay, DiaryShape, Todo, TodoCategory } from "../lib/api";
import { toast } from "../store/toast";
import { useSettings } from "../store/settings";
import { useMediaQuery } from "../lib/useMediaQuery";

const CAL_SUGGESTIONS = [
  "이번 주 일정 정리해줘",
  "내일 오후 3시에 운동 일정 잡아줘",
  "다음 주 회의 가능한 빈 시간 찾아줘",
  "이번 달 할 일 뭐 남았어?",
];

/**
 * 달력에 무엇을 그릴지. 일정·할 일·기록은 저장소가 달라 섞어 보면 헷갈린다.
 * 셋을 한 덩어리 버튼으로 늘어놓고 그중 하나를 고른다.
 */
type CalView = "events" | "todos" | "diary";

const VIEW_BUTTONS: { key: CalView; button: string; text: string; hint: string }[] = [
  { key: "events", button: "viewEvents", text: "일정", hint: "일정 보기" },
  { key: "todos", button: "viewTodos", text: "할 일", hint: "마감이 있는 할 일 보기" },
  { key: "diary", button: "viewDiary", text: "기록", hint: "상태·일기 기록 보기" },
];
/** FullCalendar 툴바 문법: ','로 이으면 한 덩어리, 공백이면 떨어진 버튼. */
const VIEW_GROUP = VIEW_BUTTONS.map((b) => b.button).join(",");

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
const localDay = (d: Date) => localISO(d).slice(0, 10);

/** 기록 보기의 달력 칸 — 도형 세 개만. FC 의 eventContent 는 JSX 를 그대로 받는다. */
function renderDiaryCell(arg: EventContentArg) {
  const p = arg.event.extendedProps as { body: DiaryShape; heart: DiaryShape; mind: DiaryShape; hasText: boolean };
  return <DiaryCell body={p.body} heart={p.heart} mind={p.mind} hasText={p.hasText} />;
}

export function Calendar() {
  const s = useSettings((st) => st.settings);
  const navigate = useNavigate();
  const calRef = useRef<FullCalendar>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [todoCats, setTodoCats] = useState<TodoCategory[]>([]);
  const [view, setView] = useState<CalView>("events");
  // 기본은 '완료도 보임'. 지운 게 아니라 끝낸 것이라 흔적이 남아야 한다.
  const [showDone, setShowDone] = useState(true);
  // '기록' 보기: 달력은 상태 도형만 그리고, 오른쪽은 AI 대신 상태·일기 패널이 된다.
  const diary = view === "diary";
  const [diaryDays, setDiaryDays] = useState<Record<string, DiaryDay>>({});
  const [selectedDay, setSelectedDay] = useState(() => localDay(new Date()));
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
      // 세 갈래를 함께 받아 둔다 — 토글할 때마다 왕복하면 화면이 깜빡인다.
      const from = range.current.from?.slice(0, 10) ?? localDay(new Date());
      const to = range.current.to?.slice(0, 10) ?? from;
      const [evs, tds, cts, dys] = await Promise.all([
        api.calEvents(range.current.from, range.current.to),
        api.todoList({
          from: range.current.from,
          to: range.current.to,
          include_undated: false, // 기한 없는 할 일은 달력에 놓을 자리가 없다
        }),
        api.todoCategories(),
        api.diaryRange(from, to),
      ]);
      setEvents(evs);
      setTodos(tds);
      setTodoCats(cts);
      setDiaryDays(Object.fromEntries(dys.map((d) => [d.date, d])));
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
    // 기록 보기에서 칸을 누르면 그날을 고른다(오른쪽 패널이 그날로 바뀐다).
    if (diary) {
      setSelectedDay(arg.dateStr.slice(0, 10));
      return;
    }
    // 할 일 보기에서 빈 칸을 누르면 '일정'이 만들어져 엉뚱한 곳에 쌓인다.
    // 할 일은 할 일 화면에서 만든다.
    if (view === "todos") return;
    setDialog({
      start: `${arg.dateStr}T09:00:00`,
      end: `${arg.dateStr}T10:00:00`,
      allDay: arg.allDay,
      color: defaultColor,
    });
  };

  const onEventClick = (arg: EventClickArg) => {
    const id = arg.event.id;
    if (id.startsWith("diary:")) {
      setSelectedDay(id.slice("diary:".length));
      return;
    }
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
        // 완료한 것은 옅게 — 남은 것과 한눈에 구분되어야 한다. 다만 가장 옅은
        // 토큰(--fg-subtle)에 .fc-todo-done 의 opacity 까지 겹치면 대비가
        // 1.6:1 이라 제목이 안 읽힌다. 한 단계 진한 토큰을 쓴다.
        backgroundColor: t.done ? "transparent" : hex,
        borderColor: hex,
        textColor: t.done ? "rgb(var(--fg-muted))" : undefined,
        classNames: t.done ? ["fc-todo-done"] : ["fc-todo"],
      };
    });

  // 기록 보기: 기록이 있는 날마다 투명한 종일 이벤트 하나 — 칸에는 도형만 보인다.
  const diaryItems = Object.values(diaryDays).map((d) => ({
    id: `diary:${d.date}`,
    start: d.date,
    allDay: true,
    backgroundColor: "transparent",
    borderColor: "transparent",
    classNames: ["fc-diary"],
    extendedProps: { body: d.body, heart: d.heart, mind: d.mind, hasText: !!d.text.trim() },
  }));

  const fcEvents = view === "diary" ? diaryItems : view === "events" ? eventItems : todoItems;

  const doneCount = todos.filter((t) => t.done).length;

  // 기록은 달(月) 단위로만 본다 — 주·일 보기에서는 도형을 놓을 자리가 없다.
  useEffect(() => {
    if (diary) calRef.current?.getApi().changeView("dayGridMonth");
  }, [diary]);

  const diaryCellClass = useCallback(
    (arg: DayCellContentArg) => (localDay(arg.date) === selectedDay ? ["fc-diary-selected"] : []),
    [selectedDay],
  );

  const onDiaryChange = useCallback((entry: DiaryDay) => {
    setDiaryDays((prev) => {
      const next = { ...prev };
      // 도형도 글도 없으면 서버가 그날을 지운다 — 달력에서도 뺀다
      if (!entry.body && !entry.heart && !entry.mind && !entry.text.trim()) delete next[entry.date];
      else next[entry.date] = entry;
      return next;
    });
  }, []);

  // customButtons가 만든 버튼에 눈 아이콘을 심는다(FC는 text/icon만 받는다).
  useEffect(() => {
    const btn = document.querySelector<HTMLButtonElement>(".fc-doneToggle-button");
    if (!btn) return;
    btn.innerHTML = showDone ? EYE_ON : EYE_OFF;
    btn.setAttribute("aria-label", showDone ? "완료한 할 일 숨기기" : "완료한 할 일 보기");
    btn.setAttribute("title", showDone ? "완료한 할 일 숨기기" : "완료한 할 일 보기");
    btn.setAttribute("aria-pressed", String(!showDone));
  });
  // 셋 중 지금 보고 있는 것을 보기 버튼처럼 칠한다(FC는 view 버튼에만 active 를 준다).
  useEffect(() => {
    for (const b of VIEW_BUTTONS) {
      const btn = document.querySelector<HTMLButtonElement>(`.fc-${b.button}-button`);
      if (!btn) continue;
      btn.classList.toggle("fc-button-active", view === b.key);
      btn.setAttribute("aria-pressed", String(view === b.key));
    }
  });

  return (
    <Shell
      title="캘린더"
      actions={
        <div className="flex items-center gap-2">
          {loading && <Loader2 size={14} className="animate-spin text-fg-muted" />}
          {diary ? (
            <span className="badge">기록 {Object.keys(diaryDays).length}일</span>
          ) : view === "todos" ? (
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
              ref={calRef}
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView={defaultView}
              firstDay={weekStart}
              locale="ko"
              // 좁은 화면에서 한 줄에 7개를 밀어넣으면 제목과 버튼이 서로 뭉갠다.
              // 모바일은 두 줄로 나눈다(위: 이동+제목, 아래: 보기 전환).
              customButtons={{
                // 셋을 한 덩어리로 늘어놓고 하나를 고른다(FC 는 ','로 이으면 한 그룹이 된다).
                ...Object.fromEntries(VIEW_BUTTONS.map((b) => [b.button, {
                  text: b.text,
                  hint: b.hint,
                  click: () => setView(b.key),
                }])),
                doneToggle: {
                  text: "완료",
                  hint: "완료한 할 일 표시",
                  click: () => setShowDone((v) => !v),
                },
              }}
              // 보기 세 개는 '<> 오늘' 옆에 한 덩어리로, 눈 아이콘은 그 오른쪽에
              // **떨어진 독립 버튼**으로 둔다(공백이 그룹을 나눈다). 눈은 할 일 보기에서만.
              // 기록 보기에서는 주·일 보기를 감춘다(도형을 놓을 자리가 없다).
              headerToolbar={
                isNarrow
                  ? {
                      // 좁은 화면은 위 줄에 이동·제목만 — 보기 버튼까지 넣으면 서로 뭉갠다
                      left: "prev,next",
                      center: "title",
                      right: "today",
                    }
                  : {
                      left: `prev,next today ${VIEW_GROUP}${view === "todos" ? " doneToggle" : ""}`,
                      center: "title",
                      right: diary ? "" : "dayGridMonth,timeGridWeek,timeGridDay",
                    }
              }
              footerToolbar={
                isNarrow
                  ? {
                      left: `${VIEW_GROUP}${view === "todos" ? " doneToggle" : ""}`,
                      right: diary ? "" : "dayGridMonth,timeGridWeek,timeGridDay",
                    }
                  : undefined
              }
              buttonText={{ today: "오늘", month: "월", week: "주", day: "일" }}
              // ko 로케일은 날짜를 "26일"로 낸다. 좁은 칸에서는 두 줄로 깨지므로
              // 숫자만 남긴다(요일은 열 머리글에 이미 있다).
              dayCellContent={isNarrow ? (a) => a.dayNumberText.replace("일", "") : undefined}
              // "+3 more"는 좁은 칸에서 "+3 mo"로 잘린다. 숫자만 보여준다.
              moreLinkContent={isNarrow ? (a) => `+${a.num}` : undefined}
              events={fcEvents}
              eventContent={diary ? renderDiaryCell : undefined}
              dayCellClassNames={diary ? diaryCellClass : undefined}
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
          {diary ? (
            <>
              <div className="mb-3 flex items-center gap-2 border-b border-line/50 pb-2 text-sm font-semibold">
                <NotebookPen size={16} className="text-accent" /> 상태 기록
              </div>
              <DiaryPanel
                date={selectedDay}
                entry={diaryDays[selectedDay]}
                events={events}
                onChange={onDiaryChange}
              />
            </>
          ) : (
            <>
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
            </>
          )}
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
