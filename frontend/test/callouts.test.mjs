/**
 * 콜아웃(`> [!NOTE] 제목`) 갈래·제목 가르기.
 *
 * 붙잡는 것:
 *  - 다른 도구 이름([!INFO]·[!DANGER] …)도 알아본다. 모르면 표시가 **글자 그대로**
 *    인용문에 남아 붙여 넣은 문서가 깨져 보인다.
 *  - 접기 표시(`[!NOTE]-`)의 `-` 가 제목에 붙지 않는다.
 *  - 제목에 서식이 있으면(`[!TIP] **굵은** 제목`) 그 서식까지 제목으로 간다.
 *    예전에는 첫 글자 조각만 제목으로 보고 굵은 글씨를 본문으로 흘렸다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { matchMarker, parseCallout, CALLOUTS } = await import("../src/lib/callouts.ts");

/** react-markdown 이 넘기는 모양을 흉내 낸다(문단 하나 + 그 안의 조각들). */
const el = (type, children) => ({
  $$typeof: Symbol.for("react.element"), type, key: null, ref: null,
  props: { children }, _owner: null, _store: {},
});
const p = (...kids) => el("p", kids);
const br = el("br", null);

test("표시를 알아보고 갈래를 정한다", () => {
  assert.deepEqual(matchMarker("[!NOTE] 제목"), { kind: "note", title: "제목" });
  assert.deepEqual(matchMarker("[!warning]"), { kind: "warning", title: "" });
  assert.equal(matchMarker("그냥 인용문"), null);
  assert.equal(matchMarker("[!NOPE] 모르는 것"), null);
});

test("다른 도구의 이름도 다섯 갈래로 접는다", () => {
  const 접힘 = {
    info: "note", todo: "note", quote: "note", example: "note",
    hint: "tip", success: "tip", done: "tip",
    question: "important", help: "important",
    attention: "warning",
    danger: "caution", error: "caution", bug: "caution", failure: "caution",
  };
  for (const [alias, kind] of Object.entries(접힘)) {
    const hit = matchMarker(`[!${alias.toUpperCase()}] 제목`);
    assert.ok(hit, `[!${alias}] 를 못 알아본다 — 표시가 글자 그대로 남는다`);
    assert.equal(hit.kind, kind, `[!${alias}] 가 ${hit.kind} 로 갔다`);
    assert.ok(CALLOUTS[hit.kind], `${hit.kind} 는 그릴 수 없는 갈래다`);
  }
});

test("접기 표시(-, +)는 제목이 아니다", () => {
  assert.deepEqual(matchMarker("[!NOTE]- 접는 제목"), { kind: "note", title: "접는 제목" });
  assert.deepEqual(matchMarker("[!NOTE]+ 펴는 제목"), { kind: "note", title: "펴는 제목" });
});

test("제목에 서식이 있어도 제목으로 간다", () => {
  const strong = el("strong", "굵은");
  const hit = parseCallout([p("[!TIP] ", strong, " 제목", br, "본문 첫 줄")]);
  assert.ok(hit, "콜아웃을 못 알아봤다");
  assert.equal(hit.kind, "tip");
  // Children.toArray 가 key 를 새로 붙이므로 **모양**으로 견준다(동일성 비교 X)
  const shape = (n) => (typeof n === "string" ? n : n?.type);
  assert.deepEqual(hit.titleRest.map(shape), ["strong", " 제목"], "굵은 글씨가 본문으로 샜다");
  assert.deepEqual(hit.body.map(shape), ["본문 첫 줄"]);
});

test("제목 다음 줄부터가 본문이다(맨 앞에 빈 줄이 생기지 않는다)", () => {
  // remarkBreaks 가 엔터 한 번을 <br> 로 바꾸므로 제목과 본문이 한 문단에 온다.
  const hit = parseCallout([p("[!NOTE] 제목", br, "본문")]);
  assert.equal(hit.title, "제목");
  assert.deepEqual(hit.titleRest, [], "제목 줄에 남은 조각이 없어야 한다");
  assert.deepEqual(hit.body, ["본문"], "맨 앞 <br> 이 남으면 본문 위에 빈 줄이 생긴다");
});

test("같은 줄에만 쓴 콜아웃은 본문이 비어 있다", () => {
  const hit = parseCallout([p("[!WARNING] 조심")]);
  assert.equal(hit.title, "조심");
  assert.deepEqual(hit.body, []);
});

test("콜아웃이 아니면 null", () => {
  assert.equal(parseCallout([p("보통 인용문")]), null);
  assert.equal(parseCallout(["글자만"]), null);
  assert.equal(parseCallout([]), null);
});
