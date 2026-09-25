/**
 * 1초마다 바뀌는 값 때문에 화면 전체가 다시 그려지지 않는가.
 *
 * 로그인 저장소(useAuth)에는 1초마다 줄어드는 remaining 이 있다. useAuth() 를 통째로 받으면
 * 그 컴포넌트가 1초마다 다시 그려진다 — App 이 그랬고, 그 아래 화면 전체가 따라 그려져서
 * 300차례 대화의 AI 비서 화면이 가만히 있어도 1초마다 130ms 씩 멈췄다(15차 실측).
 * 필요한 값만 골라 받게(useAuth((s) => …)) 소스에서 지킨다.
 *
 * 돌리는 법: node --test test/rerenders.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(tsx?|jsx?)$/.test(name)) yield p;
  }
}

test("useAuth 는 필요한 값만 골라 받는다(통째로 받으면 1초마다 다시 그려진다)", () => {
  const offenders = [];
  for (const f of files(SRC)) {
    const code = readFileSync(f, "utf8").split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    if (/useAuth\(\s*\)/.test(code)) offenders.push(f.slice(SRC.length + 1));
  }
  assert.deepEqual(offenders, [], `useAuth() 를 통째로 받는 곳: ${offenders.join(", ")}`);
});

test("남은 시간(remaining)은 그것을 보여 주는 곳만 받는다", () => {
  const allowed = new Set(["components/layout/SessionTimer.tsx", "pages/Profile.tsx"]);
  const readers = [];
  for (const f of files(SRC)) {
    const rel = f.slice(SRC.length + 1).replace(/\\/g, "/");
    if (/useAuth\(\(\w+\)\s*=>\s*\w+\.remaining\)/.test(readFileSync(f, "utf8"))) readers.push(rel);
  }
  for (const r of readers) assert.ok(allowed.has(r), `${r} 가 1초마다 바뀌는 remaining 을 받는다`);
});
