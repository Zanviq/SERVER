/**
 * 이미지·첨부 임베드 해석 — 라이브 에디터와 읽기 뷰가 같은 규칙을 쓴다.
 *
 * 지원 문법(옵시디언과 동일):
 *   ![[사진.png]]          벌트 어디에 있든 파일명으로 찾는다
 *   ![[폴더/사진.png]]      경로로 지정
 *   ![[사진.png|300]]       너비 지정(px)
 *   ![대체문구](사진.png)    표준 마크다운. 상대경로는 현재 문서 폴더 기준
 *
 * 두 렌더러가 각자 확장자 목록·경로 규칙을 들고 있으면 반드시 어긋나므로
 * (한쪽에서만 이미지가 보이는 식) 여기 한 곳에서만 정한다.
 */
import { stripMarkdownExt } from "./notePath";

const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "svg",
]);

export function isImagePath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXT.has(ext);
}

/** 벌트 내 파일 목록에서 임베드 대상을 찾는다. */
export type EmbedResolver = (target: string) => { path: string; url: string } | null;

/** `![[대상|옵션]]` 한 건 */
export interface WikiEmbed {
  raw: string;      // 원본 문자열 전체
  target: string;   // 파일명 또는 경로
  width?: number;   // |300 → 300
}

const WIKI_EMBED = /!\[\[([^\[\]]+?)\]\]/g;

export function parseWikiEmbed(inner: string): WikiEmbed {
  const [target, opt] = inner.split("|");
  const w = opt ? parseInt(opt.trim(), 10) : NaN;
  return {
    raw: inner,
    target: target.trim(),
    width: Number.isFinite(w) && w > 0 ? w : undefined,
  };
}

/** 문자열 안의 모든 `![[...]]` 위치를 훑는다(에디터 위젯용). */
export function eachWikiEmbed(
  text: string,
  cb: (m: { start: number; end: number; embed: WikiEmbed }) => void,
): void {
  WIKI_EMBED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_EMBED.exec(text)) !== null) {
    cb({ start: m.index, end: m.index + m[0].length, embed: parseWikiEmbed(m[1]) });
  }
}

/**
 * 벌트 파일 목록으로 해석기를 만든다.
 *
 * - 경로에 `/`가 있으면 그대로 벌트 기준 경로로 본다.
 * - 없으면 파일명으로 찾되, **현재 문서와 같은 폴더를 먼저** 본다(옵시디언과 같은
 *   우선순위). 그다음 경로가 짧은 것을 고른다 — 같은 이름이 여러 폴더에 있을 때
 *   매번 다른 것이 잡히면 안 되므로 규칙을 고정한다.
 */
export function makeResolver(
  files: { path: string }[],
  currentPath: string | null,
  toUrl: (path: string) => string,
  moved?: Record<string, string>,
): EmbedResolver {
  // 루트 문서(경로에 "/"가 없다)에서 replace가 아무것도 못 지워 파일명이 통째로
  // 폴더로 잡히는 실수를 막는다 — "메모.md" → curDir "" 이어야 한다.
  const slash = currentPath ? currentPath.lastIndexOf("/") : -1;
  const curDir = slash >= 0 ? currentPath!.slice(0, slash) : "";
  const byPath = new Set(files.map((f) => f.path));
  const base = resolveIn(files, byPath, curDir, toUrl);

  // 4) 목록에 없으면 — 이름을 바꾸거나 옮겨 간 곳(서버가 옮김 기록으로 찾아 준 것, 73차). 예전엔 그림 이름을
  //    바꾸면 그 그림을 넣은 문서마다 "없음"이 됐다.
  return (target: string) => {
    const hit = base(target);
    if (hit) return hit;
    const now = moved?.[target];
    return now && byPath.has(now) ? { path: now, url: toUrl(now) } : null;
  };
}

/** 목록만으로 찾는 해석(1~3) — 목록에서 못 찾은 것을 서버에 물을지 가를 때도 쓴다(unresolvedEmbeds). */
function resolveIn(
  files: { path: string }[],
  byPath: Set<string>,
  curDir: string,
  toUrl: (path: string) => string,
): EmbedResolver {
  return (target: string) => {
    const clean = target.replace(/^\.\//, "").trim();
    if (!clean) return null;

    // 1) 경로로 바로 지정
    if (clean.includes("/")) {
      if (byPath.has(clean)) return { path: clean, url: toUrl(clean) };
      // 현재 폴더 기준 상대경로
      const rel = curDir ? `${curDir}/${clean}` : clean;
      if (byPath.has(rel)) return { path: rel, url: toUrl(rel) };
      return null;
    }

    // 2) 같은 폴더 우선
    const sameDir = curDir ? `${curDir}/${clean}` : clean;
    if (byPath.has(sameDir)) return { path: sameDir, url: toUrl(sameDir) };

    // 3) 벌트 전체에서 파일명이 같은 것 중 경로가 가장 짧은 것
    const hits = files
      .filter((f) => f.path.split("/").pop() === clean)
      .sort((a, b) => a.path.length - b.path.length);
    if (hits.length) return { path: hits[0].path, url: toUrl(hits[0].path) };
    return null;
  };
}

/** 표준 그림 문법의 대상(`![대체](그림/사진.png)`·`![대체](<띄운 이름.png>)`) — 꺾쇠 안은 공백이 들어갈 수 있다. */
const MD_IMAGE = /!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;

/**
 * 글에 넣은 그림·첨부 가운데 **목록에서 못 찾는 것**(73차) — 서버에 옮겨 간 자리를 물을 대상.
 * `![[…]]` 과 표준 그림(`![](…)`) 둘 다. 코드 안인지는 가리지 않는다 — 묻기만 하고, 그리는 쪽이 코드를 거른다.
 */
export function unresolvedEmbeds(text: string, files: { path: string }[], currentPath: string | null): string[] {
  const resolve = makeResolver(files, currentPath, (p) => p);
  const out = new Set<string>();
  eachWikiEmbed(text, ({ embed }) => {
    if (!resolve(embed.target)) out.add(embed.target);
  });
  eachMdImage(text, ({ target }) => {
    if (!resolve(target)) out.add(target);
  });
  return [...out].slice(0, 200);
}

/**
 * 글의 표준 그림(`![대체](…)`) 가운데 **벌트 안** 대상 — 주소(http:·data: 등)·루트 경로(`/api/…`)는 뺀다.
 * 읽기 보기(MarkdownView 의 img)와 같은 기준이다: 그쪽도 이런 대상만 해석기로 보낸다. `%` 로 적은 이름은 푼다.
 */
export function eachMdImage(text: string, cb: (m: { index: number; target: string }) => void): void {
  for (const m of text.matchAll(MD_IMAGE)) {
    const url = m[1] ?? m[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/")) continue;
    let target = url;
    try { target = decodeURIComponent(url); } catch { /* %가 든 이름 — 그대로 */ }
    cb({ index: m.index ?? 0, target });
  }
}

/**
 * 문서에 삽입할 임베드/링크 문자열. 이미지면 임베드, 아니면 링크.
 *
 * `files`를 주면 같은 이름이 여러 폴더에 있을 때 **전체 경로**를 쓴다 —
 * 파일명만 넣으면 해석기가 "가장 짧은 경로"를 고르므로 끌어다 놓은 것과 다른
 * 그림이 표시된다. 이름이 유일할 때만 짧게 쓴다(옵시디언과 같다).
 */
export function embedMarkdownFor(path: string, files?: { path: string }[]): string {
  const name = path.split("/").pop() ?? path;
  const ambiguous =
    !!files && files.filter((f) => (f.path.split("/").pop() ?? f.path) === name).length > 1;
  const target = ambiguous ? path : name;
  // 마크다운 확장자는 대소문자·`.markdown` 까지 뗀다(72차 — `.md` 만 떼면 `[[메모.MD]]` 가 들어갔다)
  return isImagePath(path) ? `![[${target}]]` : `[[${stripMarkdownExt(target)}]]`;
}
