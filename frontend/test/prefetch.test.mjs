/**
 * 로그인 뒤 미리 받는 조각은 받을 까닭이 있는 것만(33차).
 *
 * 실측(운영 번들): 대시보드 하나를 열어도 모든 화면의 조각을 받아, 주인이 아닌 사람도 웹 터미널
 * (xterm, gzip 73KB)을 받았고 데이터 절약을 켜도 똑같이 받았다(53조각·gzip 419KB). 고친 뒤:
 * 주인이 아니면 51조각·344KB, 데이터 절약이면 20조각·106KB.
 *
 * 돌리는 법: node --test test/prefetch.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fn = app.slice(app.indexOf("function prefetchRoutes"), app.indexOf("function Spinner"));

test("웹 터미널 조각은 서버 주인에게만 미리 받는다", () => {
  assert.match(fn, /name === "terminal" && !owner/, "주인이 아닌 사람도 터미널 조각을 받는다");
  assert.match(app, /prefetchRoutes\(session\.origin === "bootstrap" && session\.role === "admin"\)/,
    "주인인지 넘기지 않는다");
});

test("데이터 절약·2G 이면 미리 받지 않는다", () => {
  assert.match(fn, /conn\?\.saveData/, "데이터 절약을 보지 않는다");
  assert.match(fn, /2g/, "느린 망을 보지 않는다");
  assert.ok(fn.indexOf("saveData") < fn.indexOf("const run"), "보기 전에 받기부터 건다");
});
