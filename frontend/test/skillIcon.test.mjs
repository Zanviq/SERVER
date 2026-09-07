/**
 * AI 가 쓴 도구를 화면이 제대로 보여 주는가.
 *
 * 두 가지가 걸려 있었다.
 *
 * 1) **짝 없는 결과를 버렸다.** 도구 칩은 `tool_call` 로 만들어지고 `tool_result`
 *    로 완성되는데, 서버가 스스로 한 일은 `tool_result` 만 온다(모델이 잊은 단어
 *    후보를 서버가 채우는 경우). 짝이 없으면 조용히 버려서 **칩도 후보 목록도
 *    화면에 아예 안 나왔다** — 서버가 한 일이 통째로 사라진 셈이다.
 *
 * 2) 칩에 갈래 아이콘이 없었다. 상태(됐나)만 있고 무엇을 했는지는 글자뿐이라
 *    여러 개가 늘어서면 한눈에 안 들어온다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** ChatPanel 의 tool_result 처리와 같은 규칙 */
function onToolResult(steps, e) {
  const out = [...steps];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].name === e.name && out[i].ok === undefined) {
      out[i] = { ...out[i], ok: e.ok, message: e.message, data: e.data };
      return out;
    }
  }
  return [...out, { name: e.name, ok: e.ok, message: e.message, data: e.data }];
}

test("부른 도구의 결과는 그 칩을 완성한다", () => {
  const steps = onToolResult([{ name: "list_vocab" }],
                             { name: "list_vocab", ok: true, message: "단어 3개" });
  assert.deepEqual(steps, [{ name: "list_vocab", ok: true, message: "단어 3개", data: undefined }]);
});

test("짝 없는 결과도 칩으로 남는다 — 서버가 스스로 한 일", () => {
  const steps = onToolResult([], {
    name: "propose_vocab_words", ok: true, message: "후보 6개",
    data: { proposal: [{ word: "hinder" }] },
  });
  assert.equal(steps.length, 1, "버리면 후보 목록이 화면에 아예 안 나온다");
  assert.equal(steps[0].name, "propose_vocab_words");
  assert.ok(steps[0].data.proposal, "후보 목록은 이 data 로 그려진다");
});

test("이미 끝난 칩을 덮어쓰지 않는다(같은 도구를 두 번 부를 때)", () => {
  let steps = [{ name: "list_vocab", ok: true, message: "첫 번째" }];
  steps = onToolResult(steps, { name: "list_vocab", ok: true, message: "두 번째" });
  assert.equal(steps.length, 2, "두 번 불렀으면 칩도 둘이어야 한다");
  assert.equal(steps[0].message, "첫 번째");
});

test("모든 스킬이 갈래 아이콘을 받는다", () => {
  const src = read("../src/components/ai/skillIcon.tsx");
  const rules = [...src.matchAll(/\[\/([^/]+)\/,\s*(\w+)\]/g)].map(([, re, icon]) => [new RegExp(re), icon]);
  assert.ok(rules.length >= 10, `규칙이 너무 적다: ${rules.length}`);

  // 라벨 표에 있는 이름 = 지금 있는 스킬 전부(백엔드 시험이 그 둘을 맞춰 준다)
  const panel = read("../src/components/ai/ChatPanel.tsx");
  const block = panel.slice(panel.indexOf("const SKILL_LABEL"), panel.indexOf("\n};", panel.indexOf("const SKILL_LABEL")));
  const names = [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  assert.ok(names.length >= 55, `스킬 이름을 못 읽었다: ${names.length}`);

  const 없는것 = names.filter((n) => !rules.some(([re]) => re.test(n)));
  assert.deepEqual(없는것, [], "이 스킬들이 갈래 아이콘 규칙에 안 걸린다");
});

test("갈래가 헷갈리는 것들은 뜻대로 갈린다", () => {
  const src = read("../src/components/ai/skillIcon.tsx");
  const rules = [...src.matchAll(/\[\/([^/]+)\/,\s*(\w+)\]/g)].map(([, re, icon]) => [new RegExp(re), icon]);
  const pick = (name) => (rules.find(([re]) => re.test(name)) || [null, "FALLBACK"])[1];

  // 논문 '대화' 검색은 논문이 아니라 지난 대화다
  assert.equal(pick("search_paper_chats"), "MessageSquare");
  assert.equal(pick("read_paper_text"), "GraduationCap");
  assert.equal(pick("search_context"), "MessageSquare");
  assert.equal(pick("find_free_slots"), "CalendarDays");
  assert.equal(pick("shift_date"), "CalendarClock");
  assert.equal(pick("list_meeting_docs"), "AudioLines");   // 회의 문서는 회의 쪽
  assert.equal(pick("create_folder"), "FolderOpen");
});
