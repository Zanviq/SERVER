/**
 * 할 일 화면의 배치(디자인 2차) — 추가 칸이 목록 끝에 묻히지 않고, 줄이 손가락에 넉넉한가.
 *
 * 실측(운영 번들, 할 일 600개): 추가 칸이 휴대폰에서 y=38,187, 데스크톱에서 y=26,594 였다. 오른쪽 칸이
 * `flex-1` 인데 높이가 정해지지 않은 세로 flex 안이라 기준 크기(0%)가 내용 크기로 풀려 h-[60vh]·h-view-9 가
 * 무시됐고, 카드가 할 일 전부의 길이로 자랐다(목록의 overflow-auto 는 한 번도 일하지 않았다). 하나를 더하려면
 * 600개를 굴려 내려가야 했다. 고친 뒤 390×844 에서 y=648, 1280×800 에서 y=648.
 *
 * 돌리는 법: node --test test/todoLayout.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/pages/Todo.tsx", import.meta.url), "utf8");

test("오른쪽 칸은 두 크기 모두 높이가 못 박혀 있다 — 목록이 칸 안에서 구르고 추가 칸이 보인다", () => {
  const m = src.match(/<div className="([^"]*)">\{rightPane\}<\/div>/);
  assert.ok(m, "오른쪽 칸을 감싸는 곳을 못 찾았다");
  const cls = m[1].split(/\s+/);
  assert.ok(cls.includes("h-[60vh]") && cls.includes("flex-none"),
    "좁은 화면: flex-1 이면 높이(60vh)가 내용 크기로 풀려 카드가 목록 길이만큼 자란다");
  assert.ok(cls.includes("lg:h-view-9"), "넓은 화면: h-auto 면 안쪽 카드의 flex-1 이 내용 크기로 풀린다");
  assert.ok(!cls.includes("lg:h-auto"));
  // 짧은 휴대폰(568px): 60vh 로는 추가 칸을 빼면 할 일이 한 개만 보였다(디자인 38차)
  assert.ok(cls.includes("min-h-[26rem]") && cls.includes("lg:min-h-0"), "짧은 휴대폰에서 목록이 한 줄로 쪼그라든다");
  // 목록이 칸 안에서 구르는 쪽이어야 위의 높이가 뜻을 가진다
  assert.match(src, /const timeline = \(\s*<div className="min-h-0 flex-1 overflow-auto/);
});

test("완료한 할 일 보기/숨기기 — 고른 것이 남고, 검색으로 온 완료 항목은 가리지 않는다", () => {
  assert.match(src, /const SHOW_DONE_KEY = "todo\.showDone";/);
  assert.match(src, /localStorage\.getItem\(SHOW_DONE_KEY\) !== "0"/, "처음에는 지금처럼 모두 보인다");
  assert.match(src, /showDone \? inCategory : inCategory\.filter\(\(t\) => !t\.done\)/);
  // 목록이 그리는 것은 걸러진 visible 이다
  const tl = src.slice(src.indexOf("const timeline = ("), src.indexOf("const detailPane"));
  assert.match(tl, /\{visible\.map\(/);
  assert.match(src, /aria-pressed=\{showDone\}/);
  assert.match(src, /if \(target\.done\) setShowDoneState\(true\);/, "?t= 로 온 완료 항목이 목록에서 사라진다");
});

test("기한이 없는 할 일에는 둘째 줄을 두지 않는다", () => {
  const tl = src.slice(src.indexOf("const timeline = ("), src.indexOf("const detailPane"));
  assert.match(tl, /\{t\.due && \(/, "기한 줄이 기한 없는 할 일에도 그려진다(줄마다 '기한 없음')");
  assert.doesNotMatch(tl, /: tone\.label\}/, "기한이 없을 때 '기한 없음' 을 쓰는 갈래가 남아 있다");
});

test("줄·단추는 손가락 화면에서 넉넉하다", () => {
  const tl = src.slice(src.indexOf("const timeline = ("), src.indexOf("const detailPane"));
  // 완료 동그라미와 제목 단추가 줄 높이 전체를 누를 자리로 쓴다(줄의 여백을 단추 안으로 옮겼다)
  assert.match(tl, /className="tap mt-0\.5 shrink-0 py-1\.5 text-fg-subtle hover:text-accent coarse:py-2\.5"/);
  assert.match(tl, /className="min-w-0 flex-1 py-1\.5 text-left coarse:py-2\.5"/);
  assert.match(tl, /ring-surface coarse:top-4"/, "줄이 높아진 만큼 시간선 점도 내려야 글과 맞는다");
  assert.equal(src.match(/rounded-md px-2 py-1 text-sm coarse:py-2\.5/g)?.length, 2, "전체·미분류 줄");
  assert.match(src, /coarse:h-9 coarse:w-9"/, "카테고리 편집·삭제(붙어 있어 .tap 으로 넓히면 서로 겹친다)");
  const composer = readFileSync(new URL("../src/components/todo/TodoComposer.tsx", import.meta.url), "utf8");
  assert.match(composer, /transition-colors coarse:h-9 \$\{/, "추가 칸의 기한·카테고리 칩");
});
