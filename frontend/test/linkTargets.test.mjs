/**
 * 링크·검색이 만드는 주소(`/notes?folder=…`)를 **받는 화면이 실제로 읽는가.**
 *
 * 주소를 만드는 쪽(백엔드 links.py·검색 팔레트)과 읽는 쪽(각 화면)이 따로 있어서,
 * 한쪽에만 새 값을 넣으면 링크를 눌러도 화면만 뜨고 아무 일도 없다. 실제로
 * `[note/서버]` 폴더 링크가 `/notes?folder=서버` 로 갔는데 문서 화면은 그 값을 읽지
 * 않았다(막다른 길). 여기서 둘을 대조한다.
 *
 * 돌리는 법: node --test test/linkTargets.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** 경로 → 그 경로를 그리는 화면 파일 */
const PAGE = {
  notes: "../src/pages/Notes.tsx",
  papers: "../src/pages/Papers.tsx",
  meetings: "../src/pages/Meetings.tsx",
  todo: "../src/pages/Todo.tsx",
  english: "../src/pages/English.tsx",
  calendar: "../src/pages/Calendar.tsx",
};

/** 소스에서 `/경로?키=` 꼴을 모두 뽑는다 */
function targets(src) {
  const out = new Set();
  for (const m of src.matchAll(/\/(notes|papers|meetings|todo|english|calendar)\?(\w+)=/g)) {
    out.add(`${m[1]}?${m[2]}`);
  }
  return [...out];
}

test("링크와 검색이 만드는 주소의 값은 모두 받는 화면이 읽는다", () => {
  const made = new Set([
    ...targets(read("../../backend/links.py")),
    ...targets(read("../src/components/search/SearchPalette.tsx")),
  ]);
  assert.ok(made.size >= 6, `주소를 거의 못 찾았다 — 이 시험의 정규식을 확인할 것: ${[...made]}`);
  for (const t of made) {
    const [route, key] = t.split("?");
    const page = read(PAGE[route]);
    assert.ok(page.includes(`params.get("${key}")`),
      `/${route}?${key}= 로 보내는데 ${PAGE[route]} 는 "${key}" 를 읽지 않는다(누르면 아무 일도 없다)`);
  }
});
