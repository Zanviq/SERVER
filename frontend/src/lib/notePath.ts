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
