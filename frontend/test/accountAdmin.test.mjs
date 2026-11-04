/**
 * 계정 관리(디자인 31차) — 늘 실패할 단추를 내 줄에 두지 않는가.
 *
 * 서버는 자기 자신의 비활성화·삭제를 거절한다(routers/admin._not_self, 400). 그런데 화면은 내 줄에도 두 단추를 두어,
 * 삭제를 누르면 "계정을 삭제할까요?" 를 묻고 확인하면 늘 오류가 났다.
 *
 * 돌리는 법: node --test test/accountAdmin.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/components/settings/AccountAdmin.tsx", import.meta.url), "utf8");

test("내 줄에는 비활성화·삭제가 없다", () => {
  assert.match(src, /\{u\.status === "active" && u\.username !== me && \(/, "내 줄에 비활성화가 뜬다");
  const del = src.slice(src.lastIndexOf("{u.username !== me && ("), src.indexOf("<Trash2 size={14} />"));
  assert.match(del, /title="계정 삭제/, "내 줄에 삭제가 뜬다");
});

test("비활성화도 묻고 한다 — 그 사람은 모든 기기에서 바로 로그아웃된다", () => {
  // 삭제·임시 비밀번호는 물었는데 비활성화만 누르는 즉시 끊었다(휴대폰에서는 ⊘ 가 무엇인지도 보이지 않았다)
  const block = src.slice(src.indexOf('{u.status === "active" && u.username !== me && ('), src.indexOf("api.adminDisable("));
  assert.match(block, /confirm\(/, "비활성화를 묻지 않는다");
});

test("그림 단추는 모두 이름이 있고, 손가락 화면에서는 글로도 뜻을 적는다", () => {
  const list = src.slice(src.indexOf("{users.map("));
  const buttons = [...list.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0])
    .filter((b) => /<(Ban|KeyRound|Check|Trash2) size/.test(b));
  assert.equal(buttons.length, 4, `조작 단추를 다 못 찾았다: ${buttons.length}`);
  for (const b of buttons) {
    assert.match(b, /aria-label=\{`\$\{u\.username\} [^`]+`\}/, `이름 없는 그림 단추: ${b.slice(0, 80)}`);
    assert.match(b, /<span className="hidden coarse:inline">[^<]+<\/span>/, `손가락 화면에 뜻이 안 보인다: ${b.slice(0, 80)}`);
  }
});

test("좁은 화면에서는 조작이 아랫줄로 — 이름·상태를 잘라 내지 않는다", () => {
  // 한 줄에 우겨 넣던 때는 375px 에서 "승인을 기다리는 아…"·"@이름 · 사용자 · 사…" 로 잘렸다
  const lists = src.slice(src.indexOf("{pending.map("));
  assert.ok([...lists.matchAll(/<li key=\{u\.username\}\s+className="([^"]*)"/g)].every((m) => /flex-wrap/.test(m[1])));
  assert.doesNotMatch(lists, /className="truncate/, "줄 안의 글이 아직 잘린다");
});
