/**
 * 보조 글자색이 바탕 위에서 읽히는가 — tokens.css 의 값으로 대비를 계산한다(52차).
 *
 * 화면 전체를 훑자(모든 화면·라이트/다크) 대비 3 미만(큰 글자 기준도 못 넘는) 글자가 전부 한 토큰,
 * fg-subtle 이었다 — 라이트 2.3~2.55, 다크 2.0~2.9. 할 일 개수, "기한 없음", 디스크 사용량, 올리기
 * 안내처럼 **뜻이 있는 글자**가 그 색이었다. fg-muted 도 라이트 바탕 대부분에서 4.5 가 안 됐다.
 * 토큰을 다시 고칠 때 여기서 먼저 걸린다.
 *
 * 돌리는 법: node --test test/tokenContrast.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function block(selectorStart) {
  const i = css.indexOf(selectorStart);
  assert.ok(i >= 0, `${selectorStart} 블록을 못 찾았다`);
  return css.slice(i, css.indexOf("\n}", i));
}
function tok(src, name) {
  const m = src.match(new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+);`));
  assert.ok(m, `--${name} 이 없다`);
  return m.slice(1).map(Number);
}
const lum = (c) => {
  const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const [name, start] of [["라이트", ':root,\n[data-theme="light"]'], ["다크", '[data-theme="dark"]']]) {
  test(`${name}: 보조 글자가 바탕 위에서 4.5 이상`, () => {
    const b = block(start);
    const surfaces = { bg: tok(b, "bg"), "bg-elevated": tok(b, "bg-elevated"), "bg-subtle": tok(b, "bg-subtle") };
    const all = { ...surfaces, "bg-muted": tok(b, "bg-muted"), "bg-hover": tok(b, "bg-hover") };
    const subtle = tok(b, "fg-subtle");
    const muted = tok(b, "fg-muted");
    for (const [s, v] of Object.entries(surfaces)) {
      assert.ok(contrast(subtle, v) >= 4.5, `fg-subtle / ${s} = ${contrast(subtle, v).toFixed(2)}`);
    }
    for (const [s, v] of Object.entries(all)) {
      assert.ok(contrast(muted, v) >= 4.5, `fg-muted / ${s} = ${contrast(muted, v).toFixed(2)}`);
    }
    // 층은 남는다 — muted 가 subtle 보다 또렷하다
    assert.ok(contrast(muted, surfaces.bg) > contrast(subtle, surfaces.bg) * 1.2, "muted 와 subtle 의 층이 사라졌다");
  });
}
