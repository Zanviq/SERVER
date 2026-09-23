/**
 * 일정 편집창의 시각 셈 — 시작을 옮기면 종료도 따라온다.
 *
 * 화면에서 쓰는 값은 `datetime-local` 의 표기(`2026-09-24T14:00`)이고 **그 지역
 * 시각 그대로**다. UTC 로 바꾸지 않는다 — 바꿔 돌리면 자정 근처에서 날짜가 하루
 * 어긋난다.
 *
 * 컴포넌트에서 떼어 둔 이유는 시험 때문이다(test/eventTimes.test.mjs).
 */

/** 길이를 모를 때 쓰는 기본값(분). "10시로 바꾸면 11시가 된다". */
export const DEFAULT_MINUTES = 60;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

function parse(local: string): Date | null {
  const m = LOCAL.exec(local || "");
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(+y, +mo - 1, +d, +h, +mi);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function format(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

/**
 * 시작이 `prevStart` 에서 `nextStart` 로 바뀌었을 때의 새 종료 시각.
 *
 * - 원래 길이가 있으면 그 길이를 지킨다(2시간짜리는 옮겨도 2시간).
 * - 길이를 모르거나 거꾸로면(종료가 시작보다 앞) 1시간으로 둔다.
 * - 종일 일정은 시각이 없다 — 종료일이 시작일보다 앞서지 않게만 맞춘다.
 */
export function followEnd(
  nextStart: string,
  prevStart: string,
  prevEnd: string,
  allDay = false,
): string {
  if (!nextStart) return prevEnd;
  if (allDay) {
    // 날짜만 견준다(편집창은 종일일 때도 시각 조각을 들고 있다)
    return prevEnd && prevEnd.slice(0, 10) >= nextStart.slice(0, 10)
      ? prevEnd
      : nextStart.slice(0, 10) + (prevEnd.slice(10) || nextStart.slice(10) || "T10:00");
  }
  const next = parse(nextStart);
  if (!next) return prevEnd;
  const from = parse(prevStart);
  const to = parse(prevEnd);
  const kept = from && to ? (to.getTime() - from.getTime()) / 60000 : 0;
  const minutes = kept > 0 ? kept : DEFAULT_MINUTES;
  return format(new Date(next.getTime() + minutes * 60000));
}
