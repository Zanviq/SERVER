/**
 * 모아 두었다 보내는 저장(디바운스)은 **PendingSave 로만** 한다.
 *
 * 맨 타이머(`setTimeout(() => api.xxxUpdate(...))`)로 저장을 미루면, 화면을 떠날 때의
 * 정리 코드가 그 타이머를 지우면서 **보내지 않은 저장을 버린다**. 실제로 지도에서 끈
 * 노드 자리와 논문에서 읽던 쪽이 그렇게 사라졌다. PendingSave 는 떠날 때 보내고(flush),
 * 실패하면 버리지 않고 다시 보낸다.
 *
 * 돌리는 법: node --test test/debouncedSaves.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const WRITE = /(Update|Save|Layout|Create|Delete|Rename|Move|Patch|Put)\w*\(/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(tsx?|mts)$/.test(name)) yield p;
  }
}

test("저장 API 를 맨 타이머로 미루는 코드가 없다(PendingSave 를 쓴다)", () => {
  const bad = [];
  for (const f of files(SRC)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/setTimeout\(\s*(?:async\s*)?\([^)]*\)\s*=>/g)) {
      // 콜백 앞부분만 본다(다음 문장까지 넘어가 엉뚱한 것을 잡지 않게)
      const body = src.slice(m.index, m.index + 220).split(/\n\s*\n/)[0];
      const call = body.match(/api\.(\w+)\(/);
      if (call && WRITE.test(`${call[1]}(`)) {
        const line = src.slice(0, m.index).split("\n").length;
        bad.push(`${f.slice(SRC.length)}:${line} api.${call[1]}`);
      }
    }
  }
  assert.deepEqual(bad, [], `맨 타이머로 저장을 미루는 곳 — PendingSave 로 바꿀 것:\n${bad.join("\n")}`);
});
