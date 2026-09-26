/**
 * 글에 맞춰 늘어나는 입력칸은 높이를 !important 로 못 박지 않는다(디자인 4차).
 *
 * 실측(390px): AI 대화 입력칸에 일곱 줄을 써도 칸이 44px(한 줄 반)이라 쓴 글을 되짚어 볼 수 없었다. 자동 늘이기
 * (style.height = scrollHeight)는 있었는데, 칸의 `!h-auto`(height: auto !important)가 인라인 높이를 이겼다 —
 * 데스크톱도 같았다. `.input` 의 h-9 는 components 층이라 `h-auto` 유틸리티로 충분하다. 고친 뒤 160px(여섯 줄).
 *
 * 돌리는 법: node --test test/autoGrow.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(n)) files.push(p);
  }
})(SRC);

test("자동으로 늘어나는 칸이 있는 파일에는 !important 높이가 없다", () => {
  const growers = files.filter((f) => /\.style\.height = `/.test(readFileSync(f, "utf8")));
  assert.ok(growers.length >= 2, `자동 늘이기를 거의 못 찾았다: ${growers}`);
  for (const f of growers) {
    // 클래스 값 안에서만 찾는다(주석에 적은 옛 꼴은 세지 않는다)
    const classes = (readFileSync(f, "utf8").match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) ?? []).join(" ");
    const bad = classes.match(/!(?:min-|max-)?h-[\w[\]./-]+/g);
    assert.equal(bad, null, `${f.slice(SRC.length)}: ${bad} 가 자동 늘이기의 인라인 높이를 이긴다`);
  }
});

test("AI 대화 입력칸은 .input 의 높이를 유틸리티로만 지운다", () => {
  const chat = readFileSync(join(SRC, "components/ai/ChatPanel.tsx"), "utf8");
  assert.match(chat, /className="input h-auto flex-1 resize-none/);
  assert.match(chat, /el\.style\.height = `\$\{Math\.min\(el\.scrollHeight, 160\)\}px`;/, "자동 늘이기가 사라졌다");
  const css = readFileSync(join(SRC, "index.css"), "utf8");
  // .input 이 components 층에 있어야 h-auto 가 !important 없이 이긴다
  const layer = css.indexOf("@layer components");
  assert.ok(layer > 0 && css.indexOf(".input {", layer) > layer, ".input 이 components 층 밖으로 나갔다");
});
