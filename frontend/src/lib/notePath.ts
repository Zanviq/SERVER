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

const depth = (path: string) => path.split("/").length;
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * `[[제목]]` 이 가리키는 문서(65차). 제목이 같은 문서가 여럿이면 **링크를 적은 문서(from)에서 가까운 것** —
 * 같은 폴더 → 경로가 얕은 것 → 경로 순서. **서버(notes_graph.nearest)와 같은 규칙**이어야 한다: 예전엔
 * 화면은 목록의 첫 것을, 서버는 먼저 훑은 것을 골라 `나/출발` 의 `[[메모]]` 를 누르면 `가/메모` 가 열리고
 * 역링크는 둘 다에 떴다. 제목이 안 맞으면 예전처럼 경로·파일명으로 찾는다.
 */
export function pickByTitle<T extends { path: string; title: string }>(
  notes: T[], title: string, from?: string | null,
): T | undefined {
  const key = title.toLowerCase();
  const same = notes.filter((n) => n.title.toLowerCase() === key);
  if (same.length === 1) return same[0];
  if (same.length > 1) {
    if (from != null) {
      const here = parentDir(from);
      const near = same.filter((n) => parentDir(n.path) === here).sort(byPath)[0];
      if (near) return near;
    }
    return [...same].sort((a, b) => depth(a.path) - depth(b.path) || byPath(a, b))[0];
  }
  return notes.find((n) => n.path.toLowerCase() === key)
    // `[[폴더/제목]]` — 제목이 겹칠 때 옵시디언이 쓰는 꼴(66차, 서버 _Lookup 과 같다). 못 찾으면 화면은
    // 그 이름으로 '만들기'를 했다.
    ?? (key.includes("/") ? notes.find((n) => n.path.toLowerCase().replace(/\.(md|markdown)$/, "") === key) : undefined)
    ?? notes.find((n) => fileName(n.path).toLowerCase() === key);
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
