/**
 * 논문 메모 칸은 **치던 글을 덮지 않는다.**
 *
 * 메모는 사람과 AI 가 같은 칸을 쓴다. "메모에 정리해 줘"를 시켜 두고 정보 탭에서
 * 직접 메모를 쓰고 있으면, AI 가 끝나는 순간 화면이 논문을 다시 받아 오면서
 * 여기까지 새 값으로 갈아치웠다 — 치던 문장이 눈앞에서 사라진다.
 *
 * 그렇다고 밖에서 바뀐 것을 숨기면 사용자가 모르고 덮어쓴다. 그래서 두 가지를
 * 함께 지킨다: 치던 글은 그대로 두고, **바뀌었다는 사실은 알린다.**
 *
 * PaperInfo 의 메모 효과와 같은 규칙(그 파일은 React 라 노드에서 못 부른다).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** 밖에서 온 p.notes 를 받았을 때 무엇을 할지 */
function onIncoming({ editing, shown, incoming }) {
  if (editing && incoming !== shown) return { shown, conflict: true };
  return { shown: incoming, conflict: false };
}

test("안 치고 있으면 밖에서 온 값을 그대로 받는다", () => {
  assert.deepEqual(
    onIncoming({ editing: false, shown: "옛 메모", incoming: "AI 가 적은 정리" }),
    { shown: "AI 가 적은 정리", conflict: false },
  );
});

test("치는 중이면 덮지 않고 알린다", () => {
  assert.deepEqual(
    onIncoming({ editing: true, shown: "내가 치던 문장", incoming: "AI 가 적은 정리" }),
    { shown: "내가 치던 문장", conflict: true },
  );
});

test("치는 중이라도 같은 값이면 소란 피우지 않는다", () => {
  assert.deepEqual(
    onIncoming({ editing: true, shown: "같은 글", incoming: "같은 글" }),
    { shown: "같은 글", conflict: false },
  );
});

test("화면이 실제로 그렇게 돼 있다", () => {
  const src = readFileSync(new URL("../src/components/papers/PaperInfo.tsx", import.meta.url), "utf8");
  assert.match(src, /editing\.current && p\.notes !== notes/, "치는 중인지 보고 갈라져야 한다");
  assert.match(src, /setNoteConflict\(true\)/);
  assert.match(src, /editing\.current = true/, "친 순간부터 '치는 중'이다");
  const 메모칸 = src.slice(src.indexOf("placeholder=\"읽으면서 남길 메모"));
  const onBlur = 메모칸.slice(메모칸.indexOf("onBlur="), 메모칸.indexOf("/>"));
  assert.match(onBlur, /editing\.current = false/, "저장하면 다시 밖의 값을 받는다");
  // 논문을 바꾸면 그 논문 메모다 — 무조건 새로 채워야 한다
  assert.match(src, /useEffect\(\(\) => \{ editing\.current = false; setNotes\(p\.notes\)/);
  assert.match(src, /바뀐 내용 보기/, "덮어쓸지 버릴지는 사용자가 정한다");
});

test("메모 상한이 서버와 같다", () => {
  const front = readFileSync(new URL("../src/components/papers/PaperInfo.tsx", import.meta.url), "utf8");
  const back = readFileSync(new URL("../../backend/paper_store.py", import.meta.url), "utf8");
  const max = Number(front.match(/const MAX_NOTES = (\d+)/)[1]);
  const maxText = Number(back.match(/^MAX_TEXT = (\d+)/m)[1]);
  assert.equal(max, maxText * 2,
    "화면이 서버보다 더 받으면 저장할 때 뒤가 잘려 눈앞에서 글이 사라진다");
});
