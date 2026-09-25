/**
 * 인터넷 주소(클라우드플레어) 뒤의 올리기 상한과, 앞단이 준 HTML 오류의 말 — 소스로 지킨다.
 *
 * 18차 실측: 101MB 올리기는 클라우드플레어가 서버에 닿기도 전에 413 HTML 로 막았고, 화면은
 * 이유 없이 "413" 만 띄웠다(서버는 문서 2GB·녹음 300MB 까지 받는다고 말한다). api.ts 는
 * import.meta.env 를 써서 node 에서 바로 부를 수 없어 소스 모양을 본다(브라우저 탐침으로 확인함).
 *
 * 돌리는 법: node --test test/uploadLimit.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("파일을 올리는 세 곳 모두 보내기 전에 크기를 본다", () => {
  for (const name of ["noteUpload", "paperUpload", "meetingUpload"]) {
    const start = api.indexOf(`  ${name}: `);
    assert.ok(start >= 0, name);
    const body = api.slice(start, api.indexOf("\n  },", start));
    assert.match(body, /await checkUploadSize\(file\)/, `${name} 가 크기를 보지 않고 보낸다`);
  }
  assert.match(api, /headers\.has\("cf-ray"\)/, "클라우드플레어를 거치는지 가리지 않는다(집 네트워크는 막으면 안 된다)");
});

test("JSON 이 아닌 오류(앞단의 HTML)는 상태 번호가 아니라 말로 보인다", () => {
  assert.match(api, /let detail: unknown = undefined;/, "HTML 오류가 '413' 같은 번호 문자열이 된다");
  for (const status of [413, 502, 504]) {
    assert.match(api, new RegExp(`\\n  ${status}: "`), `${status} 의 말이 없다`);
  }
});
