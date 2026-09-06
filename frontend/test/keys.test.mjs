/**
 * 한글 조합 중의 Enter 회귀 테스트.  실행: npm test  (frontend 폴더에서)
 *
 * 한글을 치는 동안 Enter 는 **조합을 확정하는 키**다. 그 keydown 을 제출로 받으면
 * 마지막 글자가 확정되기 전에 값이 읽혀 "회의록"이 "회의ㄹ"로 들어간다. 영문
 * 자판에서는 티가 안 나서, 채팅 입력칸 말고 아홉 군데가 이 검사를 빠뜨리고 있었다
 * (노트 이름 변경·새 문서·새 폴더, 논문 폴더·제목, 단어 태그, 회의 화자, 대화
 * 검색, 설정, Ctrl+K 결과 이동).
 */
import { bundle } from "./bundle.mjs";

const { isSubmitEnter } = await bundle("src/lib/keys.ts");

let fails = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    fails++;
    console.log(`  FAIL ${label}`);
  }
}

/** 리액트 합성 이벤트 흉내 — 우리가 보는 것은 key 와 nativeEvent.isComposing 뿐. */
const ev = (key, isComposing = false) => ({ key, nativeEvent: { isComposing } });

console.log("\n조합 중의 Enter 는 제출이 아니다");
check("조합이 끝난 Enter 는 제출", isSubmitEnter(ev("Enter")) === true);
check("조합 중 Enter 는 제출이 아니다", isSubmitEnter(ev("Enter", true)) === false);

console.log("\n다른 키는 언제나 제출이 아니다");
for (const k of ["Escape", "Tab", "a", "ㄱ", " ", "ArrowDown", "NumpadEnter"]) {
  check(`${k} 는 제출이 아니다`, isSubmitEnter(ev(k)) === false);
}

console.log("\nisComposing 이 없는 이벤트도 다루어야 한다(합성 이벤트·구형 브라우저)");
check("nativeEvent 에 isComposing 이 없으면 제출로 본다",
  isSubmitEnter({ key: "Enter", nativeEvent: {} }) === true);

console.log(fails ? `\n${fails}개 실패` : "\n모두 통과");
process.exit(fails ? 1 : 0);
