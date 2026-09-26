/**
 * 손가락으로 누를 수 있어야 한다.
 *
 * 실측(390px 휴대폰 크기)으로 세 화면을 훑었더니 이런 자리가 나왔다.
 *   회의 받아쓰기의 시각  33×19   ← 녹음을 되감는 **주된 조작**이고 한 회의에 수백 개
 *   회의 목록으로 단추     24×24
 *   화자 이름 칩          58×22
 *   목록 줄 끝 아이콘      24×24 (논문·회의)
 *   좁은 화면 전환 단추    54×27 (영어의 대화/단어장)
 * 권장 최소치는 44×44 이다.
 *
 * 두 가지로 고쳤다.
 *   - 받아쓰기는 **줄 전체**를 눌러 되감게 했다(작은 글자를 정확히 짚을 필요가 없다).
 *   - 작게 보여야 하는 아이콘은 `.tap` 으로 **보이는 크기는 그대로 두고 눌리는
 *     자리만** 44×44 로 넓혔다. 마우스에서는 켜지 않는다 — 넓은 자리가 옆 줄을
 *     가로챌 이유가 없다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test(".tap 은 손가락일 때만, 보이는 크기는 그대로", () => {
  const css = read("../src/index.css");
  const block = css.slice(css.indexOf("@media (pointer: coarse)"));
  assert.match(block, /\.tap::after/, "가짜 요소로 눌리는 자리만 넓힌다");
  assert.match(block, /width: max\(100%, 44px\)/);
  assert.match(block, /height: max\(100%, 44px\)/);
  assert.ok(css.indexOf("@media (pointer: coarse)") > 0, "마우스에서는 켜지지 않아야 한다");
});

test("받아쓰기는 줄 전체가 되감기 단추다", () => {
  const src = read("../src/components/meetings/TranscriptView.tsx");
  const li = src.slice(src.indexOf("<li key={i}>"), src.indexOf("</li>"));
  assert.match(li, /<button[\s\S]*?onSeek\(toSec\(s\.start\)\)/, "줄을 감싸는 단추가 되감는다");
  assert.match(li, /w-full/, "줄 너비를 다 쓴다");
  // 단추 안에 또 단추를 넣으면 안 된다 — 줄에는 되감기 단추 하나뿐이어야 한다
  assert.equal(li.match(/<button/g).length, 1, `줄 안의 단추가 하나가 아니다`);
});

test("작게 남아야 하는 아이콘에는 .tap 이 붙어 있다", () => {
  // 논문·회의 줄 끝의 … 는 한 벌(RowMoreMenu)로 모였다 — 거기에 붙어 있고 두 목록이 그것을 쓴다
  for (const file of ["../src/components/papers/PaperList.tsx", "../src/components/meetings/MeetingList.tsx"]) {
    assert.match(read(file), /<RowMoreMenu\b/, `${file} 가 줄 끝 메뉴를 한 벌로 쓰지 않는다`);
  }
  for (const [file, what] of [
    ["../src/components/ui/RowMoreMenu.tsx", "논문·회의 줄 끝 아이콘"],
    ["../src/components/meetings/TranscriptView.tsx", "화자 이름 칩"],
    ["../src/pages/Meetings.tsx", "회의 목록으로"],
  ]) {
    assert.match(read(file), /className=\{?[`"][^`"]*\btap\b/, `${what} 에 .tap 이 없다`);
  }
});

test("좁은 화면의 전환 단추는 넉넉하다", () => {
  const src = read("../src/components/notes/ThreePane.tsx");
  const sw = src.slice(src.indexOf("function MobileSwitch"), src.indexOf("function MobileSwitch") + 1400);
  assert.match(sw, /h-10/, "h-8 이면 테두리 안쪽이 27px 이라 손가락에 작다");
});

test("문서 트리는 손가락 화면에서 줄이 넉넉하고, 줄 끝 단추가 붐비지 않는다(디자인 1차)", () => {
  const config = read("../tailwind.config.js");
  assert.match(config, /addVariant\("coarse", "@media \(pointer: coarse\)"\)/, "coarse: 가 손가락 화면에만 걸리지 않는다");
  const notes = read("../src/pages/Notes.tsx");
  // 폴더 줄·문서 줄 모두 — 32px 이던 줄이 손가락으로는 40px
  assert.equal(notes.match(/py-1\.5 text-left coarse:py-2\.5/g)?.length, 2, "트리 줄이 손가락 화면에서 넓어지지 않는다");
  // 줄마다 늘 뜨던 폴더 받기는 휴대폰에서 감춘다(머리의 '폴더 받기'가 같은 일)
  assert.match(notes, /aria-label="폴더 다운로드"|title="폴더를 zip으로 내려받기"/);
  const dl = notes.slice(notes.indexOf("api.noteArchiveUrl(child.path)"), notes.indexOf('aria-label="폴더 다운로드"'));
  assert.match(dl, /\bhidden\b[^`]*\bsm:grid\b/, "휴대폰의 폴더 줄마다 받기 아이콘이 다시 뜬다");
  const menu = read("../src/components/notes/RowMenu.tsx");
  assert.match(menu, /className=\{`tap grid h-7 w-7/, "트리 줄 끝 … 에 .tap 이 없다");
  assert.match(menu, /coarse:py-3/, "메뉴 항목이 손가락 화면에서 좁다");
  assert.match(menu, /m\.offsetHeight/, "높아진 메뉴를 어림값으로 놓으면 위로 열 때 단추를 덮는다");
});

test("문서 머리는 꺾이지 않고, 좁으면 폴더 쪽부터 줄인다(디자인 1차)", () => {
  const notes = read("../src/pages/Notes.tsx");
  assert.match(notes, /<div className="flex shrink-0 items-center gap-1 whitespace-nowrap">/,
    "머리 오른쪽 묶음이 줄어들면 휴대폰에서 '저장됨'·'편집' 이 두 줄로 꺾인다");
  assert.match(notes, /<span className="max-w-full shrink-0 truncate">\{fileName\(current\)\}<\/span>/,
    "문서 이름이 폴더보다 먼저 잘린다");
  // 한 칸 화면에서 백링크는 접힌다 — 넓은 화면은 늘 펼침
  assert.match(notes, /lg:flex lg:max-h-none lg:overflow-visible \$\{linksOpen \? "flex" : "hidden"\}/);
});

test("더보기 시트의 테마 단추는 손가락 크기, 줄 끝 메뉴는 줄마다 다른 이름(디자인 6차)", () => {
  assert.match(read("../src/components/layout/ThemeToggle.tsx"), /coarse:h-9 coarse:w-10/, "테마 단추가 28px 이다");
  const menu = read("../src/components/notes/RowMenu.tsx");
  assert.match(menu, /aria-label=\{name \? `\$\{name\} 더보기` : "더보기"\}/);
  const notes = read("../src/pages/Notes.tsx");
  assert.equal(notes.match(/<RowMenu\s+name=\{/g)?.length, 2, "폴더 줄·문서 줄 모두 이름을 넘겨야 한다");
  assert.match(read("../src/components/layout/Sidebar.tsx"), /<nav aria-label="화면 이동"/, "아래 탭바가 이름 없는 목록이다");
});

test("남은 작은 단추들 — 대화 고르기·그래프 전환·컨텍스트 줄·영어 전환(디자인 10차)", () => {
  assert.match(read("../src/components/ai/ChatSessions.tsx"), /text-fg2 hover:bg-hovered coarse:py-2"/, "대화 고르기(다섯 화면)가 27px");
  const graph = read("../src/pages/Graph.tsx");
  assert.equal(graph.match(/font-medium coarse:py-1\.5 \$\{mode ===/g)?.length, 2, "그래프 링크·폴더 구조 전환이 28px");
  // 고른 쪽이 색으로만 드러나면 화면 읽기로는 무엇이 켜졌는지 모른다
  assert.match(graph, /aria-pressed=\{mode === "links"\}/);
  assert.match(graph, /aria-pressed=\{mode === "folders"\}/);
  assert.match(read("../src/pages/Context.tsx"), /text-left text-\[12\.5px\] coarse:py-2\.5 \$\{/, "컨텍스트 공간 줄이 31px");
  assert.equal(read("../src/pages/English.tsx").match(/text-\[12px\] coarse:py-2 /g)?.length, 2, "영어 대화/단어장 전환");
});
