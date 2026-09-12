/**
 * SVG 안에서 쓰는 색 토큰이 **실제로 있는 이름인가**.
 *
 * 태그의 `fill`·`stroke` 는 CSS 클래스가 아니라 값이라, 없는 토큰을 쓰면 조용히
 * 실패한다 — 그리고 SVG 의 기본 fill 은 **검정**이다. 대화 지도의 노드 상자를
 * `rgb(var(--surface))` 로 칠했는데 그 이름이 없어서(진짜 이름은 `--bg-elevated`)
 * 밝은 테마에서 상자가 전부 새까맣게 나왔다. 화면을 눈으로 보기 전에는 아무도
 * 모른다 — 타입 검사도 린트도 잡지 못한다.
 *
 * 클래스 이름(`bg-surface`)은 Tailwind 가 토큰으로 바꿔 주지만, 여기서는 우리가
 * 직접 토큰 이름을 적는다. 그래서 여기만 따로 붙잡는다.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const src = new URL("../src/", import.meta.url);
const tokens = readFileSync(new URL("./tokens.css", src), "utf8")
  + readFileSync(new URL("./index.css", src), "utf8");

/** tokens.css 에 `--이름: 12 34 56;` 으로 선언된 것들 */
const declared = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));

function tsxFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const u = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
    if (e.isDirectory()) out.push(...tsxFiles(u));
    else if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) out.push(u);
  }
  return out;
}

test("토큰 정의를 읽어 냈다", () => {
  assert.ok(declared.has("--accent"), "토큰 파일을 못 읽으면 이 시험은 무의미하다");
  assert.ok(declared.size > 10, `토큰이 ${declared.size}개뿐이다 — 파일이 바뀌었나`);
});

test("rgb(var(--x)) 로 쓴 토큰은 모두 선언되어 있다", () => {
  const missing = [];
  for (const f of tsxFiles(src)) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/rgb\(\s*var\((--[a-z0-9-]+)\)/gi)) {
      if (!declared.has(m[1])) {
        missing.push(`${f.pathname.split("/src/")[1]} → ${m[1]}`);
      }
    }
  }
  assert.deepEqual(missing, [],
    "없는 토큰은 조용히 실패한다 — SVG 는 검정으로, CSS 는 무시로 끝난다");
});

test("지도는 테마 토큰만 쓴다(색을 박아 두지 않는다)", () => {
  const tree = readFileSync(new URL("./components/ai/ConversationTree.tsx", src), "utf8");
  const hard = [...tree.matchAll(/(?:fill|stroke)=["']#[0-9a-f]{3,8}["']/gi)].map((m) => m[0]);
  assert.deepEqual(hard, [],
    "색을 박아 두면 다크 테마에서 안 보인다(레퍼런스가 그랬다)");
});
