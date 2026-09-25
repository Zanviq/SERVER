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

test("다른 곳에 따로 안 보이는 긴 글 칸은 칸을 벗어날 때만 저장하지 않는다 — 42차", () => {
  // 할 일 설명·논문 메모는 onBlur 에서만 보냈다. 새로고침·탭 닫기·휴대폰 앱 전환은 blur 없이 페이지가
  // 숨겨져, 친 글이 서버에 한 글자도 가지 않았다(실측 3/3). 칠 때 PendingSave 에 모아 두고 blur 는
  // flush 만 한다 — 그래야 usePendingSave 가 페이지가 숨겨질 때 keepalive 로 보낸다.
  const bad = [];
  for (const f of files(SRC)) {
    const src = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    for (const m of src.matchAll(/<LinkTextarea\b[\s\S]*?\/>/g)) {
      const blur = m[0].match(/onBlur=\{[\s\S]*?\}\s*\}/)?.[0] ?? "";
      if (/(?:api\.\w+|onUpdate|patchDetail)\(/.test(blur)) {
        bad.push(`${f.slice(SRC.length)}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  assert.deepEqual(bad, [], `blur 에서 곧바로 저장을 보내는 칸:\n${bad.join("\n")}`);
  const todo = readFileSync(join(SRC, "pages/Todo.tsx"), "utf8");
  assert.match(todo, /const descSave = usePendingSave\(\[selectedTodo\]\)/);
  // 43차: 열어 둔 옛 탭의 모아 보내기가 다른 기기에서 고친 설명을 덮었다 — 기준을 싣고, 409 면 합친다
  assert.match(todo, /base_description: base/, "할 일 설명 저장이 기준(base)을 싣지 않는다");
  assert.match(todo, /if \(isConflict\(e\)\) \{[\s\S]{0,300}mergeDiaryText\(theirs\.description, text\)/, "409 를 받아 두 글을 합치지 않는다");
  // 기준은 목록을 다시 받을 때 따라가면 안 된다(다른 기기의 글을 "본 것"으로 쳐서 덮는다)
  assert.doesNotMatch(todo, /descBase\.current = [^;]*b\.todos/);
  const info = readFileSync(join(SRC, "components/papers/PaperInfo.tsx"), "utf8");
  assert.match(info, /const notesSave = usePendingSave\(\[p\.id\]\)/);
  // 모아 보내면 화면이 다시 받기 전에 저장이 나간다 — 서버가 base 로 막아야 다른 곳의 메모를 안 덮는다
  assert.match(info, /onSaveNotes\(text, seenNotes\.current, keepalive\)/, "메모 저장이 화면이 아는 메모(base)를 싣지 않는다");
  // 알림의 단추를 누르는 순간의 blur 가 치던 메모로 덮어 저장하면 '바뀐 내용 보기'는 영영 못 누른다
  assert.match(info, /conflictRef\.current\?\.contains\(e\.relatedTarget/);
  assert.match(info, /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/);
});