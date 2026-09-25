import type { SessionInfo } from "./api";

type Who = Pick<SessionInfo, "origin" | "role">;

/**
 * 서버 주인(.env 로 만든 관리자)인가 — 백엔드 SessionUser.is_owner 와 **같은 판정**이어야 한다.
 * 관리 화면·웹 터미널·구글 연동·시스템 상태·미리 받을 조각이 이것으로 갈린다. 화면 다섯 곳이 같은
 * 식을 따로 들고 있었다(33차) — 한 곳만 바뀌면 메뉴는 보이는데 서버가 403 을 주는 식으로 어긋난다.
 * 타입 가드라, 참이면 세션이 있는 것으로 좁혀진다(식을 그대로 쓸 때와 같게).
 */
export function isOwner<T extends Who>(s: T | null | undefined): s is T {
  return !!s && s.origin === "bootstrap" && s.role === "admin";
}
