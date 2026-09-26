/**
 * 로그아웃된 것과 서버에 닿지 못한 것은 **다르다.**
 *
 * 60초마다 도는 `refresh()` 는 이미 그렇게 하고 있었다("쿠키가 멀쩡한데 로그인
 * 화면으로 튕기고 쓰던 화면을 잃었다"고 그 자리에 적혀 있다). 그런데 첫 확인인
 * `init()` 은 무슨 실패든 세션을 지웠다 — **서버가 잠깐 내려간 사이에 새로
 * 고치면 로그인 화면이 떴다.** 사용자는 비밀번호를 다시 치고, 그것도 실패하니
 * 계정이 잘못된 줄 안다. 배포할 때마다 컨테이너가 재시작하므로 드문 일도 아니다.
 *
 * **진짜 store/auth 를 불러** 본다(가짜 fetch). 예전엔 zustand·TS 라 노드에서 못 불러 init 규칙을 이 파일에 베껴
 * 적었는데, 베낀 규칙은 원본이 바뀌어도 조용히 통과한다(76차에 strip-types 로 옮기며 걷어 냈다).
 *
 * 돌리는 법: node --experimental-strip-types --import ./test/tsResolve.mjs --test test/authOffline.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** /api/auth/session 이 answer() 대로 답하는 가짜 서버 위에서 init 을 돌린 뒤의 상태 */
async function initWith(answer) {
  globalThis.fetch = async () => answer();
  const { useAuth } = await import("../src/store/auth.ts");
  useAuth.setState({ session: null, loading: true, offline: false });
  await useAuth.getState().init();
  const { session, loading, offline } = useAuth.getState();
  return { session, loading, offline };
}
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const me = { username: "me", display_name: "me", expires_at: 0, remaining: 60, role: "user", origin: "signup" };

test("들어와 있으면 그대로 들어간다", async () => {
  assert.deepEqual(await initWith(() => reply(200, me)), { session: me, loading: false, offline: false });
});

test("401 은 진짜 로그아웃 — 로그인 화면이 맞다", async () => {
  const s = await initWith(() => reply(401, { detail: "로그인이 필요합니다." }));
  assert.equal(s.session, null);
  assert.equal(s.offline, false, "401 에 offline 을 켜면 로그인할 길이 없어진다");
});

test("403 도 로그인 화면", async () => {
  assert.equal((await initWith(() => reply(403, { detail: "x" }))).offline, false);
});

test("네트워크가 끊기면 로그인 화면이 아니라 '닿지 못했습니다'", async () => {
  const s = await initWith(() => { throw new TypeError("Failed to fetch"); });
  assert.equal(s.offline, true, "여기서 로그인 화면을 띄우면 비밀번호를 다시 치게 된다");
});

test("5xx 도 마찬가지 — 서버 잘못이지 로그아웃이 아니다", async () => {
  for (const code of [500, 502, 503, 504]) {
    assert.equal((await initWith(() => reply(code, { detail: "x" }))).offline, true, `${code} 에서 로그인 화면이 떴다`);
  }
});

test("어떤 요청이든 401 을 받으면 곧바로 세션을 다시 본다 — 60초를 기다리지 않는다(76차)", async () => {
  // 다른 곳에서 로그아웃·비밀번호 바꾸기(59차)·비활성화(60차) 뒤에도 이 탭이 최대 1분 동안 저장이 안 되는 편집기를
  // 보여 줬다(실측: 25초 동안 로그인 화면이 안 뜸). 실제 api 모듈을 가짜 fetch 로 불러 본다.
  const calls = [];
  const statusOf = { "/api/notes/save": 401, "/api/auth/password": 401, "/api/notes/list": 200 };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const status = statusOf[path] ?? 200;
    return new Response(JSON.stringify(status === 200 ? [] : { detail: "로그인이 필요합니다." }),
      { status, headers: { "Content-Type": "application/json" } });
  };
  const { api, setUnauthorizedHandler } = await import("../src/lib/api.ts");
  setUnauthorizedHandler(() => calls.push("check"));
  await api.noteSave("a.md", "x").catch(() => {});
  assert.deepEqual(calls, ["check"], "401 인데 세션을 다시 보지 않는다");
  await api.changePassword("wrong", "new-password").catch(() => {});
  assert.deepEqual(calls, ["check"], "로그인·비밀번호 창구의 401(틀린 비밀번호)로 세션을 끊으려 한다");
  await api.noteTree().catch(() => {});
  assert.equal(calls.length, 1, "잘 된 요청에도 세션을 다시 본다");
  // AI 대화 흐름은 req 를 거치지 않는다 — 거기서 받은 401 도(77차)
  statusOf["/api/ai/chat"] = 401;
  const { aiChatStream } = await import("../src/lib/api.ts");
  await aiChatStream("안녕", [], () => {}).catch(() => {});
  assert.equal(calls.length, 2, "AI 대화의 401 로 세션을 다시 보지 않는다");
  setUnauthorizedHandler(null);

  // 구조로도: fetch 를 직접 부르는 곳은 모두 noticeUnauthorized 를 지난다
  const apiSrc = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const direct = [...apiSrc.matchAll(/await fetch\(`\$\{BASE\}([^`]*)`/g)].map((m) => m.index);
  for (const at of direct) {
    assert.match(apiSrc.slice(at, at + 600), /noticeUnauthorized\(res,/, `fetch 를 직접 부르고 401 을 알리지 않는 곳: ${apiSrc.slice(at, at + 60)}`);
  }

  const auth = readFileSync(new URL("../src/store/auth.ts", import.meta.url), "utf8");
  assert.match(auth, /setUnauthorizedHandler\(\(\) => \{/, "인증 상태가 401 알림을 받지 않는다");
});

test("화면이 실제로 그렇게 갈린다", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /if \(offline\) return/, "offline 일 때는 Login 보다 먼저 갈라져야 한다");
  assert.ok(app.indexOf("if (offline) return") < app.indexOf("<Login />"),
    "Login 이 먼저 걸리면 offline 화면은 영영 안 보인다");
  assert.match(app, /다시 시도/, "서버가 살아났는지 눌러 볼 길이 있어야 한다");

  const auth = readFileSync(new URL("../src/store/auth.ts", import.meta.url), "utf8");
  // 인터페이스 선언에도 같은 이름이 나오므로 **구현부**를 집는다
  const init = auth.slice(auth.indexOf("init: async"), auth.indexOf("login: async"));
  assert.match(init, /status !== 401 && status !== 403/, "init 도 refresh 와 같은 규칙을 써야 한다");
});
