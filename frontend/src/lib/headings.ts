/**
 * 문서 안 제목(섹션)으로 가는 링크 — `[[문서#섹션]]`·`[[#섹션]]`(이 문서)·`[글](문서.md#섹션)`·`[글](#섹션)`.
 *
 * 예전엔 `#섹션` 을 떼고 문서만 열었다(79차에 남긴 것) — 긴 문서에서는 링크가 가리킨 자리를 손으로 찾아야 했다.
 * 읽기 보기는 `[[#섹션]]` 을 제목 없는 위키링크로 보고, 누르면 맨 위에 이름 없는 `.md` 문서를 만들었다.
 * 편집기(CM6 구문 나무)와 읽기 보기(그려진 h1~h6)가 각자 제목 목록을 뽑고, 고르는 규칙은 여기 하나다.
 */
import { decodeTarget } from "./embeds";

/**
 * 링크 대상에서 `#섹션` 을 뗀다. `문서#가#나` 는 옵시디언의 하위 제목 사슬이라 마지막 조각이 가는 곳이다.
 * `#^abc` 같은 블록 참조는 제목이 아니다 — 문서만 연다(section 은 null).
 */
export function splitSection(target: string): { doc: string; section: string | null } {
  const i = target.indexOf("#");
  if (i < 0) return { doc: target.trim(), section: null };
  const chain = target.slice(i + 1).split("#").map((s) => s.trim()).filter(Boolean);
  const last = chain[chain.length - 1] ?? null;
  return { doc: target.slice(0, i).trim(), section: last && !last.startsWith("^") ? last : null };
}

/** 표준 링크 주소의 `#섹션`(퍼센트를 푼 것) — `보고서.md#결론`·`#설치-방법`. 없거나 비면 null. */
export function hrefSection(href: string): string | null {
  const i = href.indexOf("#");
  if (i < 0) return null;
  const s = decodeTarget(href.slice(i + 1)).trim();
  return s && !s.startsWith("^") ? s : null;
}

/**
 * 깃허브 방식 이름표 하나 — 읽기 보기가 제목에 다는 id(rehype-slug → github-slugger)와 같은 규칙: 소문자로,
 * 글자·숫자·결합 기호·이음 부호(`_`)·`-`·띄어쓰기 말고는 지우고, 띄어쓰기는 하나하나 `-` 로(앞뒤를 다듬지 않는다).
 * test/headings 가 실제 파이프라인의 id 와 맞대어 본다.
 */
export function slugOf(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/** 문서의 제목들(나온 차례)의 이름표 — 같은 이름표가 또 나오면 `-1`·`-2` 를 붙인다(github-slugger 와 같다). */
export function slugsOf(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((t) => {
    const base = slugOf(t);
    let s = base;
    while (seen.has(s)) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      s = `${base}-${n}`;
    }
    seen.set(s, 0);
    return s;
  });
}

/** 띄어쓰기·문장부호를 뺀 글 — 옵시디언은 링크에 못 쓰는 `:`·`#`·`|` 를 빼고 적는다(`[[문서#1단계 준비]]` ← `## 1단계: 준비`). */
const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");

/**
 * 제목 목록(나온 차례의 보이는 글) 가운데 section 이 가리키는 것의 번호 — 없으면 -1.
 * 차례: 글이 같은 것(`[[문서#설치 방법]]`, 대소문자 무시) → 이름표가 같은 것(`문서.md#설치-방법`, 같은 제목이 둘이면
 * 둘째는 `-1`) → 띄어쓰기·문장부호를 빼고 같은 것. ids 는 그려진 제목의 실제 id(읽기 보기) — 이름표와 함께 본다.
 */
export function findHeading(texts: readonly string[], section: string, ids?: readonly string[]): number {
  const want = section.trim().toLowerCase();
  if (!want) return -1;
  const exact = texts.findIndex((t) => t.trim().toLowerCase() === want);
  if (exact >= 0) return exact;
  const slugs = slugsOf(texts);
  const wantSlug = slugOf(want);
  const bySlug = slugs.findIndex((s, i) => s === want || s === wantSlug || (!!ids?.[i] && ids[i] === want));
  if (bySlug >= 0) return bySlug;
  const w = loose(want);
  return w ? texts.findIndex((t) => loose(t) === w) : -1;
}

/**
 * 원문 제목 줄 → 읽기 보기에 보이는 글(그려진 h 의 글과 맞춘다 — 편집기는 원문만 안다): `#` 표시와 닫는 `#`,
 * 링크는 보이는 글(위키링크는 별칭, 없으면 적은 그대로 — wikiTransform 과 같다), 그림은 없음, 강조·코드 기호·HTML
 * 꼬리표·`\` 탈출은 뗀다. 목록 번호(`## 1. 개요`)는 제목 글이므로 남긴다(plainLine 은 지운다 — 그래서 따로 둔다).
 */
export function headingText(raw: string): string {
  // `\*별\*` 처럼 탈출한 글자는 먼저 비켜 둔다 — 아니면 아래 강조 규칙이 그 별표를 기울임으로 보고 지운다
  const kept: string[] = [];
  return raw
    .replace(/\\([!-/:-@[-`{-~])/g, (_m, c: string) => `${kept.push(c) - 1}`)
    .replace(/^\s{0,3}#{1,6}(?=\s|$)/, "")
    .replace(/\s#+\s*$/, "")
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, a?: string) => (a ?? t).trim())
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^)]*\))*\)/g, "")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/<[^>\n]+>/g, "")
    .replace(/\*\*|__|~~|==/g, "")
    .replace(/(^|[^\w*])[*_](?=\S)([^*_]*?\S)[*_](?![\w*])/g, "$1$2")
    .replace(/`+/g, "")
    .replace(/(\d+)/g, (_m, i: string) => kept[Number(i)])
    .replace(/\s+/g, " ")
    .trim();
}
