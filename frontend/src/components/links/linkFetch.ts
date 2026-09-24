import { api } from "../../lib/api";
import type { LinkItem } from "../../lib/api";
import { toast } from "../../store/toast";

/** 같은 글자로 다시 물으면 잠깐은 받은 것을 쓴다(폴더를 오르내릴 때 깜빡이지 않게). */
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; items: LinkItem[] }>();

/** 받아 둔 후보가 아직 쓸 만하면 그것. 없으면 undefined. */
export function cachedLinkItems(query: string): LinkItem[] | undefined {
  const hit = cache.get(query);
  return hit && Date.now() - hit.at < CACHE_MS ? hit.items : undefined;
}

/** 링크 후보. 입력칸(useMarkdownInput)과 문서 편집기(cmLinks)가 같은 것을 쓴다. */
export async function fetchLinkItems(query: string): Promise<LinkItem[]> {
  const hit = cachedLinkItems(query);
  if (hit) return hit;
  const r = await api.linkSuggest(query);
  cache.set(query, { at: Date.now(), items: r.items });
  return r.items;
}

/**
 * 링크가 가리키는 화면으로 간다. 주소는 **누를 때** 서버에 묻는다 — 논문·할 일은
 * 경로가 제목이라 id 를 알아야 열 수 있고, 적어 둔 뒤에 이름이 바뀌었을 수도 있다.
 */
export async function openLink(path: string, navigate: (href: string) => void): Promise<void> {
  try {
    const r = await api.linkOpen(path);
    if (!r.found) {
      toast.error(`찾지 못한 링크입니다: ${path}`);
      return;
    }
    navigate(r.href);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "링크를 열지 못했습니다.");
  }
}
