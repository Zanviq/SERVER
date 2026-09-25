/**
 * 달력에 무엇을 그릴지 — 일정·할 일·기록. 저장소가 달라 섞어 보면 헷갈려 하나만 고른다.
 *
 * 주소의 `view=` 로도 고른다. 기록 링크(`diary/2026-09-20`)가 `/calendar?d=…` 로만 오던 때는
 * 달력이 늘 '일정' 보기로 열려, 링크를 눌러도 그날 일기가 보이지 않았다(막다른 길).
 * 이름은 backend/links.py 의 href_of 와 같아야 한다 — 시험(test_smoke)이 그쪽을 본다.
 */
export const CAL_VIEWS = ["events", "todos", "diary"] as const;
export type CalView = (typeof CAL_VIEWS)[number];

/** 주소의 view 값을 보기로. 모르는 값이면 null(지금 보기를 그대로 둔다). */
export function calViewParam(v: string | null): CalView | null {
  return (CAL_VIEWS as readonly string[]).includes(v ?? "") ? (v as CalView) : null;
}
