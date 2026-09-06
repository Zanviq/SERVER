import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Lock } from "lucide-react";
import { api, CalEvent, DiaryAxis, DiaryDay, DiaryShape } from "../../lib/api";
import { toast } from "../../store/toast";
import { useSettings } from "../../store/settings";
import { isSubmitEnter } from "../../lib/keys";
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
  /** 그날 일기가 있는데 아직 비밀번호를 안 넣었다 */
  locked: boolean;
  /** 비밀번호가 맞았을 때. 부모가 글까지 다시 받아 온다 */
  onUnlock: () => void;
}

function emptyEntry(date: string): DiaryDay {
  return { date, body: "", heart: "", mind: "", text: "", has_text: false, updated_at: "" };
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

/** 잠긴 일기를 덮는 회색 판. 누르면 숫자 4자리를 묻는다.
 *
 *  틀렸다고 따로 말하지 않는다 — 자기 일기에 자기가 들어가는 자리라 꾸짖을
 *  이유가 없고, 칸을 비워 다시 치게 하는 것으로 충분하다. */
function DiaryLock({ onUnlock }: { onUnlock: () => void }) {
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (asking) inputRef.current?.focus();
  }, [asking]);

  const submit = async (value: string) => {
    setBusy(true);
    try {
      await api.diaryUnlock(value);
      onUnlock();
    } catch {
      setPin("");            // 조용히 비우고 다시 받는다
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const onPin = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 4);
    setPin(digits);
    // 네 자리를 채우면 바로 확인한다 — 따로 누를 단추가 필요 없다
    if (digits.length === 4) void submit(digits);
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center rounded-md bg-muted">
      {!asking ? (
        <button
          type="button"
          onClick={() => setAsking(true)}
          aria-label="일기 잠금 풀기"
          className="flex h-full w-full items-center justify-center gap-1.5 rounded-md text-[12.5px] text-fg-muted hover:bg-hovered"
        >
          <Lock size={14} /> 잠긴 일기
        </button>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <input
            ref={inputRef}
            value={pin}
            onChange={(e) => onPin(e.target.value)}
            onKeyDown={(e) => { if (isSubmitEnter(e) && pin.length === 4) void submit(pin); }}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            disabled={busy}
            aria-label="일기 비밀번호 4자리"
            className="input h-10 w-28 text-center text-lg tracking-[0.5em]"
          />
          <span className="flex h-4 items-center text-[11px] text-fg-subtle">
            {busy ? <Loader2 size={12} className="animate-spin" /> : "숫자 4자리"}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 하루의 상태(육체·마음·정신)와 일기. 날짜와 일정은 달력이 채워 주고,
 * 사용자는 도형과 글만 고친다. 도형은 누르는 즉시, 글은 잠시 뒤 자동 저장.
 */
export function DiaryPanel({ date, entry, events, onChange, locked, onUnlock }: Props) {
  const autosaveMs = useSettings((st) => st.settings?.notes.autosave_ms ?? 900);
  const cur = entry ?? emptyEntry(date);
  const [text, setText] = useState(cur.text);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const pending = useRef(new PendingSave());
  //: 몇 번째 누름인가. 늦게 끝난 옛 저장이 방금 고른 것을 덮지 않게 한다.
  const picks = useRef(0);
  //: 저장 요청을 한 줄로 세우는 꼬리. 순서가 뒤집히는 것을 막는다.
  const chain = useRef<Promise<void>>(Promise.resolve());
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

  // 잠금이 풀리면 **날짜는 그대로인 채** 글이 뒤늦게 도착한다. 위 효과는 날짜로만
  // 도므로 그때 다시 돌지 않아, 자물쇠를 풀었는데 칸이 비어 있었다(실측).
  // 입력 중이거나 이미 뭔가 적혀 있으면 건드리지 않는다.
  useEffect(() => {
    if (!locked && !dirty && entry?.text && !text) setText(entry.text);
  }, [locked, entry?.text, dirty, text]);

  const dayEvents = useMemo(
    () => events.filter((e) => onDay(e, date)).sort((a, b) => a.start.localeCompare(b.start)),
    [events, date],
  );

  const pick = (axis: DiaryAxis, shape: DiaryShape) => {
    // 같은 도형을 다시 누르면 지운다 — '표시 안 함'으로 돌아가는 유일한 길이다.
    const next: DiaryShape = cur[axis] === shape ? "" : shape;
    // 글을 치는 중이면 그것도 함께 보낸다(따로 가면 뒤늦은 저장이 도형을 되돌리진
    // 않지만, 응답으로 오는 entry 가 옛 글이라 화면이 흔들린다).
    const patch: Partial<DiaryDay> = { [axis]: next };
    if (dirty) patch.text = text;

    // **누른 즉시** 화면을 바꾼다. 예전에는 서버 응답을 기다렸다가 바꿔서, 파이까지
    // 다녀오는 동안(집 회선과 클라우드플레어를 지난다) 도형도 달력 칸도 가만히
    // 있었다 — 눌린 건지 아닌지 알 수 없으니 한 번 더 누르게 되고, 그러면 방금 고른
    // 것이 도로 지워졌다. 저장은 뒤에서 하고, 실패하면 되돌린다.
    const before = cur;
    const optimistic: DiaryDay = { ...cur, ...patch };
    // 글을 함께 보낼 때만 has_text 가 바뀐다. 잠긴 날은 text 가 빈 문자열로 와
    // 있으므로 여기서 다시 계산하면 **글이 있는 날이 없는 날로 바뀐다**.
    if (patch.text !== undefined) optimistic.has_text = !!patch.text.trim();
    onChangeRef.current(optimistic);

    const mine = ++picks.current;
    const day = date;
    setSaving(true);
    // 요청을 줄 세운다. 빠르게 두 번 누르면 두 PUT 이 동시에 날아가는데, 도착 순서가
    // 뒤집히면 **나중에 고른 것이 먼저 고른 것으로 덮인다**(서버는 받은 순서대로 쓴다).
    chain.current = chain.current.then(async () => {
      try {
        const saved = await api.diarySave(day, patch);
        if (dirty) {
          pending.current.cancel();
          setDirty(false);
        }
        // 그 사이에 또 눌렀으면 이 응답은 이미 옛것이다 — 화면을 되돌리지 않는다
        if (mine === picks.current) onChangeRef.current(saved);
      } catch (e) {
        if (mine === picks.current) onChangeRef.current(before);
        toast.error(e instanceof Error ? e.message : "저장 실패");
      } finally {
        if (mine === picks.current) setSaving(false);
      }
    });
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
            {locked ? (
              <><Lock size={11} /> 잠김</>
            ) : saving ? (
              <><Loader2 size={11} className="animate-spin" /> 저장 중</>
            ) : dirty ? (
              "입력 중"
            ) : cur.updated_at || text ? (
              <><Check size={11} /> 저장됨</>
            ) : null}
          </span>
        </div>
        {/* 잠긴 날은 입력칸 자리를 통째로 회색이 덮는다. 서버가 글을 아예 안
            보내므로 덮개 뒤에는 볼 것도 없다(가리는 시늉이 아니다). */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <textarea
            value={locked ? "" : text}
            onChange={(e) => onText(e.target.value)}
            readOnly={locked}
            placeholder={locked ? "" : "오늘 어땠는지 적어 두세요."}
            className="input min-h-[120px] flex-1 resize-none leading-relaxed"
          />
          {locked && <DiaryLock onUnlock={onUnlock} />}
        </div>
      </div>
    </div>
  );
}
