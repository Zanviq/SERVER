/** 문서 경로(`서버/설정/기록.md`) 다루기 — 문서 화면의 트리·열기·옮기기가 함께 쓴다. */

/** 목록에 보여줄 파일명 — 확장자를 포함한다.
 *  NoteSummary.title 은 확장자를 뗀 값(= 위키링크 [[제목]]의 키)이라 표시용으로는 안 맞다. */
export const fileName = (path: string) => path.split("/").pop() ?? path;

/**
 * 마크다운 문서인가 — 확장자로(서버 file_kinds.MARKDOWN 과 같은 두 가지). 아니면 평문(.txt·.py·.json…)이다.
 * 평문은 편집기가 마크다운처럼 칠하거나 표시(`**`·`- `·`#`)를 숨기면 안 되고, 읽기 보기도 없다(50차).
 * 이름으로 가리므로 문서 목록이 오기 전에도, 이름을 바꾼 바로 그때도 맞다.
 */
export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);

/** 문서가 들어 있는 폴더 경로(루트면 빈 문자열). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

/**
 * 문서 경로(`서버/설정/기록.md`)의 조상 폴더들 — 가까운 쪽이 뒤에 온다.
 * `서버/설정/기록.md` → ["서버", "서버/설정"]. 트리에서 그 문서가 보이려면 이것을 모두 펼쳐야 한다.
 */
export function ancestorsOf(path: string): string[] {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}
