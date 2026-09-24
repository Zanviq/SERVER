/**
 * AI 대화 스트림 읽기 — 잘린 답을 다 쓴 답으로 보이지 않는가.
 *
 * 받던 도중 백엔드를 죽여 실측했다: 끝 신호(done/error) 없이 끝나거나 읽다가 끊겨도
 * 예전에는 정상 종료처럼 다뤘다(또는 받은 답을 오류 한 줄로 갈아치웠다).
 *
 * 돌리는 법:
 *   node --experimental-strip-types --import ./test/tsResolve.mjs --test test/sseStream.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSse, StreamCut } from "../src/lib/sseStream.ts";

const enc = new TextEncoder();
const frame = (ev) => `data: ${JSON.stringify(ev)}\n\n`;

/** 조각들을 읽을 때마다 하나씩 흘리고, 끝에 close(정상 끝) 또는 error(끊김) 를 한다.
 *  (start 에서 넣고 곧바로 error 하면 넣어 둔 조각까지 버려진다 — 실제 끊김은 받은 뒤다) */
function body(chunks, end = "close") {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else if (end === "close") c.close();
      else c.error(new TypeError("network error"));
    },
  });
}

async function collect(stream, signal) {
  const got = [];
  let err = null;
  try {
    await readSse(stream, (e) => got.push(e), signal);
  } catch (e) {
    err = e;
  }
  return { got, err };
}

test("done 까지 받으면 정상으로 끝난다(조각이 이벤트 중간에서 갈려도)", async () => {
  const whole = frame({ type: "text_delta", text: "안녕" }) + frame({ type: "done" });
  const { got, err } = await collect(body([whole.slice(0, 7), whole.slice(7, 30), whole.slice(30)]));
  assert.equal(err, null);
  assert.deepEqual(got.map((e) => e.type), ["text_delta", "done"]);
});

test("done 뒤에 오는 것(서버가 채운 단어 후보)도 받는다", async () => {
  const { got, err } = await collect(body([frame({ type: "done" }), frame({ type: "tool_result", name: "x" })]));
  assert.equal(err, null);
  assert.equal(got.length, 2);
});

test("error 로 끝나도 차례는 끝난 것이다(잘림이 아니다)", async () => {
  const { err } = await collect(body([frame({ type: "error", message: "AI 호출 실패" })]));
  assert.equal(err, null);
});

test("끝 신호 없이 조용히 끝나면 잘린 것이다 — 받은 데까지는 넘기고 StreamCut", async () => {
  const { got, err } = await collect(body([frame({ type: "text_delta", text: "1. 태조" })]));
  assert.ok(err instanceof StreamCut, String(err));
  assert.equal(got[0].text, "1. 태조");
});

test("읽다가 연결이 끊겨도 StreamCut", async () => {
  const { got, err } = await collect(body([frame({ type: "text_delta", text: "절반" })], "error"));
  assert.ok(err instanceof StreamCut, String(err));
  assert.equal(got.length, 1);
});

test("중단 버튼으로 끊은 것은 잘림이 아니다", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  for (const end of ["close", "error"]) {
    const { err } = await collect(body([frame({ type: "text_delta", text: "x" })], end), ctrl.signal);
    assert.equal(err, null, end);
  }
});

test("화면 쪽 처리가 던져도 읽기는 계속된다", async () => {
  let n = 0;
  await readSse(body([frame({ type: "a" }), frame({ type: "done" })]), () => {
    n += 1;
    throw new Error("화면 오류");
  });
  assert.equal(n, 2);
});

test("aiChatStream 은 이 읽기를 쓴다(스트림을 손으로 다시 읽지 않는다)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const fn = src.slice(src.indexOf("export async function aiChatStream"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.match(body, /readSse\(/, "aiChatStream 이 readSse 를 안 쓴다");
  assert.doesNotMatch(body, /getReader\(/, "스트림을 손으로 읽으면 잘림을 못 알아챈다");
});
