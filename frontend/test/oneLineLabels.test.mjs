/**
 * 한 줄이어야 할 머리글이 글자 중간에서 꺾이지 않는다.
 *
 * 한글은 글자마다 줄을 바꿀 수 있어서, 자리가 모자라면 '단어장'이 '단어/장'으로, '복습'이
 * '복/습'으로 갈라진다. 단어가 3000개(총수·복습 수가 네 자리)일 때 1024~1600px 모든 폭에서
 * 단어장 머리글이 그렇게 그려졌다(20차 실측 — 전 화면·세 폭을 훑어 이곳 하나만 나왔다).
 *
 * 돌리는 법: node --test test/oneLineLabels.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("단어장 머리글은 한 줄이고, 복습 수는 네 자리에서 줄인다", () => {
  const src = read("../src/components/vocab/VocabPanel.tsx");
  const head = src.slice(src.indexOf("<BookMarked") - 400, src.indexOf("모아 넣기"));
  assert.match(head, /className="[^"]*whitespace-nowrap[^"]*border-b/, "머리글 줄이 nowrap 이 아니다");
  assert.match(head, /stats\.due > 999 \? "999\+"/, "복습 배지가 자리를 무한히 먹는다");
});
