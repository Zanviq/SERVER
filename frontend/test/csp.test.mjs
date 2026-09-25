/**
 * 앱 화면의 보안 정책(CSP) — 스크립트는 같은 출처의 파일로만(34차).
 *
 * 마크다운을 날 HTML 까지 받아 살균해 그린다. 살균이 새면 끼어든 <script> 가 곧 세션을 쥔다.
 * 운영 번들에 이 정책을 씌워 전 화면·수식·코드 칠·그림·PDF(pdf.js)를 돌려 막힘 0 을 확인했다.
 * 여기서는 그 정책이 느슨해지거나, 정책에 막힐 인라인 스크립트가 다시 들어오는 것을 막는다.
 *
 * 돌리는 법: node --test test/csp.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const policy = read("../csp-app.conf").match(/Content-Security-Policy "([^"]+)"/)[1];
const directive = (name) => policy.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) ?? "";

test("스크립트는 같은 출처의 파일로만 — 인라인·eval 은 열지 않는다", () => {
  // 바깥은 클라우드플레어가 앞단에서 끼우는 방문 통계 하나뿐(운영에서 막힌 것을 보고 열었다)
  assert.equal(directive("script-src"), "script-src 'self' https://static.cloudflareinsights.com");
  assert.ok(!/'unsafe-inline'/.test(directive("script-src")), "인라인 스크립트를 열었다");
  assert.equal(directive("object-src"), "object-src 'none'");
  assert.equal(directive("base-uri"), "base-uri 'self'");
  assert.match(directive("frame-ancestors"), /'self'/);
  assert.ok(!/unsafe-eval/.test(policy), "eval 을 열었다");
});

test("index.html 에 인라인 스크립트가 없다(정책에 막혀 테마가 안 먹는다)", () => {
  const html = read("../index.html");
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter((m) => m[1].trim());
  assert.equal(inline.length, 0, "인라인 스크립트를 public/ 의 파일로 옮길 것");
  assert.match(html, /<script src="\/theme-init\.js"><\/script>/);
});

test("nginx 가 앱 화면에 정책을 붙이고, 이미지가 그 파일을 싣는다", () => {
  const nginx = read("../nginx.conf");
  const root = nginx.slice(nginx.indexOf("location / {"), nginx.indexOf("location /api/"));
  assert.match(root, /include \/etc\/nginx\/csp-app\.conf;/, "앱 화면에 정책이 없다");
  const docker = read("../Dockerfile");
  // 설정 검사 단계와 실제 이미지 둘 다에 있어야 한다 — 없으면 nginx 가 뜨지 않는다
  assert.equal((docker.match(/COPY csp-app\.conf \/etc\/nginx\/csp-app\.conf/g) ?? []).length, 2);
});
