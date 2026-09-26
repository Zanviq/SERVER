/**
 * 서버가 이유를 적어 주지 못한 실패(앞단의 HTML)는 상태 번호가 아니라 **말**로 보인다(18차) — 진짜 api 모듈을
 * 가짜 fetch 로 불러 본다(77차에 오류 읽기를 apiError 하나로 모으며 글자 검사를 행동 검사로 바꿨다).
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/apiErrors.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { api, aiChatStream, ApiError } = await import("../src/lib/api.ts");

function serve(status, body, type) {
  globalThis.fetch = async () => new Response(body, { status, headers: { "Content-Type": type } });
}
const failOf = async (p) => p.then(() => null, (e) => e);

test("JSON 이 아닌 오류(앞단의 HTML)는 상태에 맞는 말", async () => {
  for (const [status, words] of [[413, /100MB/], [502, /잠시 응답하지 않습니다/], [504, /너무 늦습니다/]]) {
    serve(status, "<html><body>Bad Gateway</body></html>", "text/html");
    const e = await failOf(api.noteTree());
    assert.ok(e instanceof ApiError);
    assert.match(e.message, words, `${status} 이 번호 문자열로 보인다: ${e.message}`);
  }
});

test("서버가 적어 준 이유는 그대로, 구조화된 오류는 본문 통째가 detail", async () => {
  serve(409, JSON.stringify({ detail: "이미 있습니다" }), "application/json");
  assert.equal((await failOf(api.noteTree())).message, "이미 있습니다");
  serve(409, JSON.stringify({ error: "moved", message: "옮겨졌습니다", moved_to: "a.md" }), "application/json");
  const e = await failOf(api.noteTree());
  assert.equal(e.message, "옮겨졌습니다");
  assert.equal(e.detail.moved_to, "a.md", "구조화된 오류가 detail 로 오지 않는다(이름 바꾸기 따라가기가 이것을 본다)");
});

test("AI 대화 흐름은 JSON 이 아니면 'AI 요청 실패', 이유가 있으면 그 이유", async () => {
  serve(502, "<html>x</html>", "text/html");
  assert.equal((await failOf(aiChatStream("안녕", [], () => {}))).message, "AI 요청 실패");
  serve(415, JSON.stringify({ detail: "이 그림 형식은 못 읽습니다" }), "application/json");
  assert.equal((await failOf(aiChatStream("안녕", [], () => {}))).message, "이 그림 형식은 못 읽습니다");
});
