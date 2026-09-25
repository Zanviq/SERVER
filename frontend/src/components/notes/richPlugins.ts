import { useEffect, useState } from "react";
import type { PluggableList } from "unified";

/*
 * 수식(KaTeX)·코드 칠(highlight.js)은 **그것이 있는 글에서만** 불러 온다(35차).
 *
 * 둘을 늘 싣던 때는 이 조각이 780KB(gzip 239KB)였다 — 말풍선 하나를 그려도 전부 해석·실행한다.
 * 빼면 347KB. 실측(운영 번들, CPU 4배 느림 ≈ 보통 휴대폰, 받아 둔 상태): 대화 화면 첫 말풍선까지
 * 2037ms → 1713ms. 대부분의 말에는 수식도 코드 울타리도 없다.
 *
 * 수식은 remark-math 가 늘 읽어 두므로, 불러 오기 전에는 수식 자리가 코드 모양으로 잠깐 보였다가
 * 바뀐다. 코드 울타리는 칠하기 전의 고정폭 글씨로 먼저 보인다. 한 번 불러 오면 모두가 같이 쓴다.
 * 순서는 예전 그대로다 — 둘 다 **살균 뒤**(까닭은 아래 rehypePlugins 주석).
 * 코드 색은 앱 테마 변수로 칠한다(index.css 의 .hljs-* 규칙 — 별도 테마 CSS 를 쓰면 다크/라이트를
 * 따라오지 못한다). 수식 글꼴·자리잡기 CSS 는 KaTeX 와 함께 불러 온다.
 */
const MATH_HINT = /\$|\\\(|\\\[/;
const CODE_HINT = /(^|\n)[ \t]{0,3}(```|~~~)/;
let katexPlugin: PluggableList[number] | null = null;
let highlightPlugin: PluggableList[number] | null = null;
let katexLoad: Promise<unknown> | null = null;
let highlightLoad: Promise<unknown> | null = null;

function loadKatex() {
  return (katexLoad ??= Promise.all([import("rehype-katex"), import("katex/dist/katex.min.css")])
    .then(([{ default: rehypeKatex }]) => {
      katexPlugin = [rehypeKatex, { throwOnError: false, errorColor: "rgb(var(--danger))" }];
    }));
}

function loadHighlight() {
  return (highlightLoad ??= import("rehype-highlight").then(({ default: rehypeHighlight }) => {
    highlightPlugin = [rehypeHighlight, { detect: false, ignoreMissing: true }];
  }));
}

/** 이 글에 필요한 무거운 플러그인 — 아직 안 불러 왔으면 불러 오고, 오면 다시 그린다. */
export function useRichPlugins(content: string): PluggableList {
  const wantMath = MATH_HINT.test(content);
  const wantCode = CODE_HINT.test(content);
  const [, redraw] = useState(0);
  useEffect(() => {
    const jobs: Promise<unknown>[] = [];
    if (wantMath && !katexPlugin) jobs.push(loadKatex());
    if (wantCode && !highlightPlugin) jobs.push(loadHighlight());
    if (!jobs.length) return;
    let alive = true;
    Promise.all(jobs).then(() => { if (alive) redraw((n) => n + 1); }).catch(() => {
      // 못 불러 왔으면 칠하지 않은 채로 둔다(글은 그대로 읽힌다). 다음 글에서 다시 해 본다.
      katexLoad = katexPlugin ? katexLoad : null;
      highlightLoad = highlightPlugin ? highlightLoad : null;
    });
    return () => { alive = false; };
  }, [wantMath, wantCode]);
  const out: PluggableList = [];
  if (wantMath && katexPlugin) out.push(katexPlugin);
  if (wantCode && highlightPlugin) out.push(highlightPlugin);
  return out;
}
