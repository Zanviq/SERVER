/**
 * 마우스를 올려야만 보이는 단추는 손가락 화면에서도 보여야 한다(디자인 7차).
 *
 * 실측(390px, 대화 고르기): 대화마다 붙은 이름 바꾸기·지우기 단추가 `opacity-0 group-hover:opacity-100` 뿐이라
 * 휴대폰에서는 **보이지 않는 채 눌렸다**. `.tap` 으로 넓힌 자리가 시각 글자 위를 덮어 한 번 스치면 대화가 통째로
 * 지워졌다(되돌릴 수 없다 — 휴지통에 가지 않는다). 이제 손가락·자판으로는 늘 보이고, 지우기는 한 번 묻는다.
 *
 * 규칙: 클래스에 `opacity-0` 과 `group-hover:opacity-100` 이 함께 있으면 손가락 화면에서 보이는 길이 있어야 한다 —
 * `coarse:opacity-100`, 또는 좁은 화면에서만 숨기는 꼴(`sm:opacity-0 …`, REVEAL_ON_ROW). 누를 수 없는 풍선
 * (`pointer-events-none`)은 뺀다.
 *
 * 돌리는 법: node --test test/hoverOnly.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx$/.test(n)) files.push(p);
  }
})(SRC);

test("마우스로만 드러나는 단추에는 손가락 화면에서 드러나는 길이 있다", () => {
  const bad = [];
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const cls = m[1] ?? m[2];
      if (!/(^|\s)opacity-0(\s|$)/.test(cls) || !/group-hover:opacity-100/.test(cls)) continue;
      seen++;
      if (/pointer-events-none/.test(cls)) continue;            // 누를 수 없는 풍선
      if (/coarse:opacity-100/.test(cls)) continue;
      if (/hoverable:opacity-0/.test(cls)) continue;              // 마우스 화면에서만 숨김(REVEAL_ON_ROW 꼴)
      bad.push(`${f.slice(SRC.length)}: ${cls.slice(0, 90)}`);
    }
  }
  assert.ok(seen >= 3, `훑은 것이 너무 적다 — 이 시험의 정규식을 확인할 것(${seen})`);
  assert.deepEqual(bad, [], "손가락 화면에서는 보이지 않은 채 눌린다");
});

test("'올리면 보임'은 화면 너비가 아니라 마우스가 있는지로 가른다(태블릿)", () => {
  // 디자인 8차: sm:opacity-0 로 숨기던 때 820×1180 태블릿(손가락)에서 문서 트리 줄 23개의 … ·폴더 받기와 논문 줄
  // 메뉴가 보이지 않은 채 눌렸다. 넓다고 마우스가 있는 것이 아니다.
  const config = readFileSync(new URL("../tailwind.config.js", import.meta.url), "utf8");
  assert.match(config, /addVariant\("hoverable", "@media \(hover: hover\) and \(pointer: fine\)"\)/);
  const reveal = readFileSync(join(SRC, "components/ui/reveal.ts"), "utf8");
  assert.match(reveal, /REVEAL_ON_ROW = "hoverable:opacity-0 hoverable:group-hover:opacity-100 hoverable:focus-visible:opacity-100"/);
  const widthHidden = files.filter((f) => /\bsm:opacity-0\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length));
  assert.deepEqual(widthHidden, [], "화면 너비로 숨기는 곳이 남았다 — 태블릿에서 보이지 않는다");
});

test("점·모양으로만 드러나는 뜻은 화면 읽기 이름이 있고, 주황 점은 뜻이 화면에 적혀 있다(디자인 15차)", () => {
  // 뜻이 title(마우스 풍선)에만 있던 곳 — 손가락 화면에서는 뜻 모를 주황 점, 화면 읽기에는 이름 없는 점들이었다
  const card = readFileSync(join(SRC, "components/vocab/WordCard.tsx"), "utf8");
  assert.match(card, /<span role="img" aria-label=\{`복습 단계 \$\{level\}\/\$\{MAX_LEVEL\}/);
  const panel = readFileSync(join(SRC, "components/vocab/VocabPanel.tsx"), "utf8");
  const chip = panel.slice(panel.indexOf("<Chip active={dueOnly}"), panel.indexOf("</Chip>", panel.indexOf("<Chip active={dueOnly}")));
  assert.match(chip, /rounded-full bg-warning/, "'오늘 복습' 칩에 줄마다 붙는 주황 점이 없다 — 점의 뜻을 읽을 곳이 없다");
  const diary = readFileSync(join(SRC, "components/calendar/DiaryShapes.tsx"), "utf8");
  assert.match(diary, /className="fc-diary-row" role="img" aria-label=/);
});

test("기록 패널은 고른 도형의 뜻을 글로 보인다(디자인 36차)", () => {
  // ★·●·▲·■·⬟ 의 뜻("매우 좋음"…)이 title 에만 있어 휴대폰에서는 무엇을 고르는지 알 길이 없었다
  const panel = readFileSync(join(SRC, "components/calendar/DiaryPanel.tsx"), "utf8");
  assert.match(panel, /\{cur\[axis\] \? SHAPE_LABEL\[cur\[axis\] as Exclude<DiaryShape, "">\] : ""\}/);
});

test("대화 지우기는 되돌릴 수 없으니 한 번 묻는다", () => {
  const chat = readFileSync(join(SRC, "components/ai/ChatPanel.tsx"), "utf8");
  const drop = chat.slice(chat.indexOf("const dropSession"), chat.indexOf("const dropSession") + 900);
  assert.match(drop, /window\.confirm\(/, "대화를 묻지 않고 지운다");
  assert.ok(drop.indexOf("window.confirm(") < drop.indexOf("api.aiSessionDrop"), "지운 다음에 묻는다");
});
