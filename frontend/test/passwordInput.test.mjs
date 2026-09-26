/**
 * 로그인·비밀번호 칸(디자인 11차) — 휴대폰에서 비밀번호를 볼 수 있고, 아이디를 자판이 "고치지" 않는가.
 *
 * 실측(390px 손가락): 비밀번호 칸에 보기 단추가 없어 긴 비밀번호를 보지 않고 쳐야 했고(로그인·비밀번호 바꾸기 세 칸),
 * 아이디 칸은 자판의 자동 고침·첫 글자 대문자가 켜져 있었다(`jaemin` → 사전 낱말로 바뀌면 영문 모를 로그인 실패).
 * 자물쇠 아이콘은 칸의 아래 여백까지 친 높이의 가운데에 서서 6px 아래로 처져 있었다.
 *
 * 돌리는 법: node --test test/passwordInput.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("보기 단추는 form 을 제출하지 않고, 켜졌는지 알린다", () => {
  const src = read("../src/components/ui/PasswordInput.tsx");
  const btn = src.slice(src.indexOf("<button"), src.indexOf("</button>"));
  assert.match(btn, /type="button"/, "form 안에서 눈을 누르면 로그인이 제출된다");
  assert.match(btn, /aria-pressed=\{shown\}/);
  assert.match(btn, /aria-label=\{shown \? "비밀번호 숨기기" : "비밀번호 보기"\}/);
  // 보일 때는 글자 칸이 된다 — 자판이 비밀번호를 고치면 안 된다
  assert.match(src, /type=\{shown \? "text" : "password"\} autoCapitalize="none" autoCorrect="off" spellCheck=\{false\}/);
});

test("로그인과 비밀번호 바꾸기는 보기 단추가 있는 칸을 쓴다(일기 네 자리는 그대로)", () => {
  const login = read("../src/pages/Login.tsx");
  assert.doesNotMatch(login, /type="password"/, "로그인에 보기 단추 없는 비밀번호 칸이 남았다");
  assert.match(login, /<PasswordInput/);
  assert.match(login, /wrapClassName="mb-3"/, "여백이 칸에 있으면 자물쇠·눈이 가운데서 처진다");
  const settings = read("../src/pages/Settings.tsx");
  assert.equal(settings.match(/<PasswordInput /g)?.length, 3, "지금·새·한 번 더 세 칸");
  // 남은 type="password" 는 일기 네 자리(숫자 자판)뿐이다
  for (const m of settings.matchAll(/type="password"[^\n]*/g)) assert.match(m[0], /inputMode="numeric"/, m[0]);
});

test("아이디 칸은 자판이 고치거나 대문자로 바꾸지 않는다", () => {
  const login = read("../src/pages/Login.tsx");
  const id = login.slice(login.indexOf('autoComplete="username"') - 400, login.indexOf('autoComplete="username"') + 400);
  assert.match(id, /autoCapitalize="none"/);
  assert.match(id, /autoCorrect="off"/);
  assert.match(id, /spellCheck=\{false\}/);
});
