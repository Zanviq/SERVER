/**
 * 두 곳(폰·PC, 탭 둘)에서 같은 글을 고쳤을 때 **둘 다 남기는** 합치기 — 일기(28차)·할 일 설명(43차).
 *
 * 서버는 화면이 연 뒤에 다른 곳에서 글이 바뀌었으면 저장을 409 로 돌려보낸다(예전에는
 * 나중 저장이 말없이 이겨, 폰에서 이어 쓴 문단이 아침에 열어 둔 PC 탭의 자동 저장에 사라졌다).
 * 그때 화면은 서버 글 뒤에 **이 기기에서 쓴 부분**만 표시를 달아 붙인다. 둘이 같이 시작한
 * 앞부분은 한 번만 남긴다(줄 머리에서 자른다 — 낱말 한가운데서 가르지 않게).
 * (예전 이름은 diaryMerge.mergeDiaryText — 할 일 설명도 쓰게 되어 하는 일에 맞췄다.)
 */
export const MERGE_MARK = "— 이 기기에서 쓴 글 —";

export function mergeTexts(theirs: string, mine: string): string {
  if (!mine.trim() || mine === theirs) return theirs;
  if (!theirs.trim()) return mine;
  let n = 0;
  while (n < theirs.length && n < mine.length && theirs[n] === mine[n]) n++;
  const cut = n > 0 ? mine.lastIndexOf("\n", n - 1) + 1 : 0;
  const rest = mine.slice(cut).trim();
  // 이 기기의 글이 이미 저쪽에 다 들어 있으면 붙일 것이 없다
  if (!rest || theirs.includes(rest)) return theirs;
  return `${theirs.trimEnd()}\n\n${MERGE_MARK}\n${rest}`;
}
