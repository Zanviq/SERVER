/**
 * 위키링크·임베드 변환 회귀 테스트.  실행: npm test  (frontend 폴더에서)
 *
 * 이 변환은 마크다운 파서에 넣기 **전에** 원문 문자열을 직접 고친다. 그래서
 * 코드 안까지 바꿔 버리기 쉽다 — 문서에 위키링크 문법을 설명하려고 코드로 적어 둔
 * `[[제목]]` 이 진짜 링크가 되면, 화면의 코드가 사용자가 쓴 것과 달라진다.
 */
import { bundle } from "./bundle.mjs";

const { transformWiki } = await bundle("src/lib/wikiTransform.ts");

// 있는 파일만 찾아 주는 해석기
const resolve = (target) =>
  target === "사진.png" ? { path: "사진.png", url: "/api/notes/raw?path=%EC%82%AC%EC%A7%84.png" } : null;

let fails = 0;
function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  OK   ${label}`);
  } else {
    fails++;
    console.log(`  FAIL ${label}\n       got  ${g}\n       want ${w}`);
  }
}

console.log("위키 변환");
check("링크", transformWiki("앞 [[제목]] 뒤", resolve), "앞 [제목](#wiki/%EC%A0%9C%EB%AA%A9) 뒤");
check("별칭", transformWiki("[[제목|다르게]]", resolve), "[다르게](#wiki/%EC%A0%9C%EB%AA%A9)");
check("임베드", transformWiki("![[사진.png]]", resolve),
  "![사진.png](/api/notes/raw?path=%EC%82%AC%EC%A7%84.png)");
check("너비 지정", transformWiki("![[사진.png|400]]", resolve),
  "![사진.png|400](/api/notes/raw?path=%EC%82%AC%EC%A7%84.png)");

console.log("\n없는 파일 자리표시자");
{
  const got = transformWiki("![[없는것.png]]", resolve);
  check("링크 문법으로 다시 바뀌지 않는다", /#wiki\//.test(got), false);
  check("무엇이 없는지 보인다", got.includes("없는것.png"), true);
}

console.log("\n코드 안은 건드리지 않는다");
check("인라인 코드", transformWiki("문법은 `[[제목]]` 입니다", resolve), "문법은 `[[제목]]` 입니다");
check("인라인 임베드", transformWiki("`![[사진.png]]`", resolve), "`![[사진.png]]`");
check("울타리 블록",
  transformWiki("```\n[[제목]]\n![[사진.png]]\n```", resolve),
  "```\n[[제목]]\n![[사진.png]]\n```");
check("언어 붙은 울타리",
  transformWiki("```md\n[[제목]]\n```", resolve),
  "```md\n[[제목]]\n```");
check("물결 울타리",
  transformWiki("~~~\n[[제목]]\n~~~", resolve),
  "~~~\n[[제목]]\n~~~");
check("울타리 밖은 바뀐다",
  transformWiki("```\n[[안]]\n```\n\n[[밖]]", resolve),
  "```\n[[안]]\n```\n\n[밖](#wiki/%EB%B0%96)");
check("코드 옆의 링크는 바뀐다",
  transformWiki("`[[안]]` 과 [[밖]]", resolve),
  "`[[안]]` 과 [밖](#wiki/%EB%B0%96)");
check("인용문 안 코드블록",
  transformWiki("> ```\n> [[제목]]\n> ```", resolve),
  "> ```\n> [[제목]]\n> ```");
check("목록 안 코드블록",
  transformWiki("- ```\n  [[제목]]\n  ```", resolve),
  "- ```\n  [[제목]]\n  ```");
check("4칸 들여쓴 코드블록",
  transformWiki("본문\n\n    [[제목]]\n", resolve),
  "본문\n\n    [[제목]]\n");
check("들여쓰기 없는 곳은 그대로 바뀐다",
  transformWiki("본문 [[제목]]", resolve),
  "본문 [제목](#wiki/%EC%A0%9C%EB%AA%A9)");

console.log("\n코드가 아닌데 코드로 보면 안 되는 것");
const LINK = "[제목](#wiki/%EC%A0%9C%EB%AA%A9)";
// 4칸 들여쓰기를 무조건 코드로 보면, 흔한 중첩 목록의 링크가 글자로만 남는다.
check("2단 중첩 목록", transformWiki("- 상위\n    - [[제목]]\n", resolve),
  `- 상위\n    - ${LINK}\n`);
check("3단 중첩 목록", transformWiki("- 하나\n  - 둘\n    - [[제목]]\n", resolve),
  `- 하나\n  - 둘\n    - ${LINK}\n`);
check("번호 목록 중첩", transformWiki("1. 하나\n    1. [[제목]]\n", resolve),
  `1. 하나\n    1. ${LINK}\n`);
// 코드 구간은 한 문단 안이다 — 빈 줄을 넘으면 문서 뒤쪽 링크가 통째로 죽는다
check("문단 건너 백틱은 코드가 아니다",
  transformWiki("` 첫 문단\n\n[[제목]]\n\n` 마지막", resolve),
  `\` 첫 문단\n\n${LINK}\n\n\` 마지막`);
// 반대로 한 문단 안에서는 줄을 넘는다(렌더러가 그렇게 그린다)
check("한 문단 안의 줄 넘는 코드",
  transformWiki("앞 ` 열고\n[[제목]]\n뒤 ` 닫음", resolve),
  "앞 ` 열고\n[[제목]]\n뒤 ` 닫음");
check("4중 울타리 속 3중 줄은 닫지 않는다",
  transformWiki("````\n```\n[[제목]]\n```\n````", resolve),
  "````\n```\n[[제목]]\n```\n````");

console.log(fails === 0 ? "\n모두 통과" : `\n실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
