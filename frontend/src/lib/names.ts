/**
 * 이름 규칙 — **백엔드(backend/file_kinds.py)와 같은 판단을 한다.**
 *
 * 확장자 판정이 양쪽에서 다르면 화면과 서버가 다르게 행동한다. 실제로 프런트는
 * `\.[A-Za-z0-9]{1,8}$` 만 봐서 `v1.2`·`2026.08` 을 확장자가 있는 이름으로 보고
 * "확장자 없이 제목만 적어 주세요"로 막았는데, 서버는 그 둘을 확장자로 보지 않는다.
 * 사용자는 멀쩡한 제목을 못 쓰고 이유도 알 수 없다.
 *
 * 규칙: 마지막 점 뒤가 1~8글자의 영숫자이고 **글자가 하나는 있어야** 확장자다.
 * (`.md`·`.jpeg` 는 확장자, `.08`·`.2` 는 아니다 — 날짜·버전이다)
 */
const EXT_RE = /\.(?=[A-Za-z0-9]{1,8}$)[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/;

/** 이름의 꼬리가 확장자인가. */
export function looksLikeExtension(name: string): boolean {
  return EXT_RE.test(name.split("/").pop() ?? "");
}

/** 이름을 [몸통, 확장자]로 나눈다. 확장자로 볼 수 없으면 확장자는 빈 문자열. */
export function splitExt(name: string): [string, string] {
  const tail = name.split("/").pop() ?? "";
  const m = EXT_RE.exec(tail);
  if (!m) return [name, ""];
  const cut = name.length - tail.length + m.index;
  return [name.slice(0, cut), name.slice(cut)];
}
