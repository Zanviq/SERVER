/**
 * 아주 좁은 휴대폰(320px)의 머리 줄(디자인 37차) — 제목이 잘리지 않고 단추 글이 한 글자씩 꺾이지 않는가.
 *
 * 실측(320×568): 제목이 "문…"·"컨텍…"·"그래…", 단추 글이 "전체 받 / 기"·"업로 / 드"·"대 / 화"·"링 / 크"·"폴더 구 / 조"
 * 로 꺾였다. 머리 줄의 단추 묶음이 줄어들며 글을 꺾었고 제목도 함께 줄었다. 이제 제목은 줄지 않고 단추 글은 꺾이지
 * 않으며, 360px 미만에서는 단추 글을 sr-only 로 감춰 아이콘만 남긴다(화면 읽기 이름은 그대로).
 *
 * 돌리는 법: node --test test/narrowHeaders.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const N = "max-[359px]:sr-only";

test("머리 줄: 제목은 줄지 않고, 단추 묶음은 글을 꺾지 않는다", () => {
  const shell = read("../src/components/layout/Shell.tsx");
  assert.match(shell, /<h1 className="shrink-0 text-base font-semibold tracking-tight">/);
  assert.match(shell, /<div className="flex min-w-0 items-center gap-2 whitespace-nowrap">/);
});

test("좁은 화면에서 단추 글은 아이콘만 남기고 화면 읽기 이름으로 남는다", () => {
  const cases = [
    ["../src/pages/Notes.tsx", 2],
    ["../src/pages/English.tsx", 2],
    ["../src/pages/Graph.tsx", 2],
    ["../src/pages/Trash.tsx", 1],
  ];
  for (const [file, n] of cases) {
    const count = read(file).split(`className="${N}"`).length - 1;
    assert.equal(count, n, `${file}: ${count}/${n}`);
  }
  assert.match(read("../src/pages/Context.tsx"), /className="badge max-\[359px\]:hidden"/, "컨텍스트 머리의 안내 칩");
});
