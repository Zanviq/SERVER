/**
 * 한 요소에 부딪치는 색 클래스가 함께 붙지 않는다(디자인 30차).
 *
 * 29차: 논문·회의 메뉴의 '휴지통으로'가 `className="text-danger"` 인데 보통 글이었다 — 컴포넌트의 기본 `text-fg` 와 한
 * 요소에 붙어 **스타일시트의 차례**로 갈렸고 text-fg 가 이겼다(뜻한 빨강이 조용히 사라졌다). 같은 모양: className 템플릿의
 * 고정 부분에 글자색·배경색이 있는데 `${…}` 갈래가 같은 종류의 다른 색을 더하는 것. 지금은 한 곳도 없다(30차에 전체 화면과
 * 소스를 훑었다) — 새로 생기면 여기서 깨진다.
 *
 * 돌리는 법: node --test test/classConflicts.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const COLORS = "fg|fg2|fg-muted|fg-subtle|danger|accent|accent-fg|accent-contrast|positive|warning|info|white|black|surface|subtle|muted|hovered|sidebar-fg|sidebar-fg-active|accent-soft|accent-muted|bg";
const colorRe = (kind) => new RegExp(`(?:^|\\s)${kind}-(?:${COLORS})(?:\\/\\d+)?(?=\\s|$)`, "g");

/** className 템플릿 하나에서 "고정 색 + 갈래 색" 이 부딪치는 종류(text·bg)를 돌려준다. */
function clashes(tpl) {
  const fixed = tpl.replace(/\$\{[^}]*\}/g, " ");
  const branchWords = [...tpl.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(" ")
    .match(/"[^"]*"/g)?.join(" ").replace(/"/g, " ") ?? "";
  return ["text", "bg"].filter((k) => (fixed.match(colorRe(k)) ?? []).length && (branchWords.match(colorRe(k)) ?? []).length);
}

test("검사기 자체가 부딪침을 잡는다(자기 점검)", () => {
  assert.deepEqual(clashes('px-2 text-fg ${on ? "text-accent" : ""}'), ["text"]);
  assert.deepEqual(clashes('px-2 ${on ? "text-accent" : "text-fg"}'), [], "갈래끼리만 고르면 부딪치지 않는다");
  assert.deepEqual(clashes('text-[13px] ${on ? "text-accent" : ""}'), [], "글자 크기는 색이 아니다");
});

test("기본 글자색을 가진 컴포넌트에 className 으로 글자색을 덧대지 않는다 — 위험한 메뉴는 danger 로", () => {
  // 29차와 같은 모양이 회의 문서 메뉴의 '삭제'에 남아 있었다(DropdownItem 기본 text-fg 와 부딪쳐 보통 글). 위 검사는
  // 한 템플릿 안만 봐서 컴포넌트 기본색 + 넘긴 className 은 못 봤다.
  const bad = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx$/.test(n)) {
        const src = readFileSync(p, "utf8");
        // 꼬리표 안에서 `>` 를 만나면 멈추되 화살표 함수의 `=>` 는 넘는다 — onClick={() => …} 다음의 className 을 놓쳤다
        for (const m of src.matchAll(/<DropdownItem\b(?:[^>]|=>)*?className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
          if (colorRe("text").test(` ${m[1] ?? m[2]} `)) bad.push(`${p.slice(SRC.length)}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
  })(SRC);
  assert.deepEqual(bad, []);
});

test("소스 어디에도 고정 색 위에 갈래 색을 덧대는 className 이 없다", () => {
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx$/.test(n)) files.push(p);
    }
  })(SRC);
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) {
      const k = clashes(m[1]);
      if (k.length) bad.push(`${f.slice(SRC.length)}:${src.slice(0, m.index).split("\n").length} ${k}`);
    }
  }
  assert.deepEqual(bad, [], "한 요소에 같은 종류의 색이 둘 — 이기는 쪽은 스타일시트 차례가 정한다");
});
