/**
 * 줄 끝 도구 단추(… 메뉴·내려받기·제목 고치기)가 보이는 규칙 하나.
 *
 * 넓은 화면(sm 이상)에서는 줄에 올렸을 때·키보드 포커스일 때만 보이고, 좁은 화면은
 * 늘 보인다 — 터치 기기엔 hover 가 없어서 hover 로만 띄우면 휴대폰에서 영영 안 눌린다.
 * `hidden` 은 쓰지 않는다. display:none 은 탭 순서에서 통째로 빠져, 다른 진입점이 없는
 * 기능(이름 변경·이동·삭제)에 키보드로는 닿지 못한다. 투명하게만 둔다.
 *
 * 부모 줄에 `group` 이 있어야 한다. 예전에는 이 문자열이 파일마다 따로 적혀 있었다.
 */
export const REVEAL_ON_ROW = "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100";
