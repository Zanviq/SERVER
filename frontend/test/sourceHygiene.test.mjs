/**
 * 소스 파일에 **홀로 선 CR**(뒤에 LF 가 없는 \r)이 없다.
 *
 * 33차: 줄 끝을 CRLF 로 둔 파일에 스크립트로 import 한 줄을 끼우다 `\r` 과 `\n` 사이에 넣어,
 * 홀로 선 CR 이 하나 생겼다. git 은 그런 파일을 **글이 아닌 것(-text)** 으로 보고 줄 끝을 바꾸지
 * 않은 채 CRLF 로 올렸다 — 커밋이 파일 통째(App.tsx 393줄)를 바꾼 것처럼 보였다(뒤 커밋에서 되돌림).
 *
 * 돌리는 법: node --test test/sourceHygiene.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("src·test 의 어떤 파일에도 홀로 선 CR·NUL 이 없다", () => {
  const bad = [];
  for (const top of ["../src/", "./"]) {
    const root = new URL(top, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|mjs|css)$/.test(n)) {
          const s = readFileSync(p, "utf8");
          if (/\r(?!\n)/.test(s) || s.includes("\0")) bad.push(p.split(/[\\/]/).slice(-2).join("/"));
        }
      }
    };
    walk(root);
  }
  assert.deepEqual(bad, [], `git 이 글이 아닌 것으로 볼 파일: ${bad.join(", ")}`);
});
