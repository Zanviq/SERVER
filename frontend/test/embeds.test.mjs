/**
 * 그림·첨부 임베드 해석(lib/embeds) — 이름을 바꾼 그림을 넣어 둔 문서에서도 계속 보이는가(73차).
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/embeds.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeResolver, unresolvedEmbeds } from "../src/lib/embeds.ts";

const files = [{ path: "여행/사진.png" }, { path: "여행/글.md" }, { path: "그림/고양이.png" }];
const url = (p) => `/raw/${p}`;

test("목록에 있는 것은 예전 규칙 그대로(같은 폴더 → 짧은 경로)", () => {
  const r = makeResolver(files, "여행/글.md", url);
  assert.equal(r("사진.png")?.path, "여행/사진.png");
  assert.equal(r("그림/고양이.png")?.path, "그림/고양이.png");
  assert.equal(r("없는.png"), null);
});

test("목록에 없는 것은 서버가 알려 준 옮긴 자리로 — 그 자리가 목록에 있을 때만", () => {
  const moved = { "옛사진.png": "그림/고양이.png", "그림/옛이름.png": "그림/고양이.png", "사라진.png": "없는/곳.png" };
  const r = makeResolver(files, "여행/글.md", url, moved);
  assert.equal(r("옛사진.png")?.url, "/raw/그림/고양이.png");
  assert.equal(r("그림/옛이름.png")?.path, "그림/고양이.png");
  assert.equal(r("사라진.png"), null, "옮긴 자리도 없으면 없는 것이다");
  assert.equal(r("사진.png")?.path, "여행/사진.png", "목록에 있는 것이 먼저다");
});

test("서버에 물을 것 — 목록에서 못 찾는 임베드만, 위키·표준 그림 둘 다", () => {
  const text = [
    "![[사진.png]] ![[옛사진.png|300]]",
    "![대체](그림/옛이름.png) ![주소](https://example.com/a.png) ![루트](/api/x.png)",
    "![공백 있는](<그림/띄운 이름.png>) ![인코딩](%EC%98%9B.png)",
  ].join("\n");
  assert.deepEqual(unresolvedEmbeds(text, files, "여행/글.md").sort(),
    ["그림/띄운 이름.png", "그림/옛이름.png", "옛.png", "옛사진.png"].sort());
  assert.deepEqual(unresolvedEmbeds("![[사진.png]]", files, "여행/글.md"), [], "다 찾으면 묻지 않는다");
});

test("문서 화면이 못 찾은 임베드를 서버에 묻고 해석기에 넘긴다", () => {
  const src = readFileSync(new URL("../src/pages/Notes.tsx", import.meta.url), "utf8");
  assert.match(src, /unresolvedEmbeds\(content, notes, current\)/);
  assert.match(src, /makeResolver\(notes, current, \(p\) => api\.noteRawUrl\(p\), embedMoved\)/);
});
