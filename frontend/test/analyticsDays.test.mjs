/**
 * 사용량의 날짜별 막대(디자인 14차) — 휴대폰에서도 그날의 값을 읽을 수 있는가.
 *
 * 실측(390px): 값이 막대의 title(마우스를 올려야 뜨는 풍선)에만 있어 손가락 화면에서는 막대 높이만 보이고 어느 날
 * 얼마를 썼는지 읽을 길이 없었다. 이제 막대가 단추이고, 고른 날(처음엔 마지막 날)의 값이 아래 줄에 나온다.
 *
 * 돌리는 법: node --test test/analyticsDays.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/pages/Analytics.tsx", import.meta.url), "utf8");

test("날짜 막대는 눌러 고르고, 고른 날의 값이 글로 나온다", () => {
  const bars = src.slice(src.indexOf("function DayBars"), src.indexOf("/** 가로 막대 하나"));
  assert.match(bars, /<button key=\{d\} type="button" onClick=\{\(\) => setPicked\(d\)\} aria-pressed=/);
  assert.match(bars, /aria-label=\{`\$\{d\} · \$\{hhmm\(v\.seconds\)\} · 토큰 \$\{num\(v\.tokens\)\}`\}/);
  assert.match(bars, /aria-live="polite"/, "고른 날의 값을 보여 주는 줄이 없다");
  assert.doesNotMatch(bars, /title=\{/, "값을 다시 마우스 풍선에만 두었다");
  assert.match(src, /<DayBars days=\{days\} maxDay=\{maxDay\} \/>/);
});
