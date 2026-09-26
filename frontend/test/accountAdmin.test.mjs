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
