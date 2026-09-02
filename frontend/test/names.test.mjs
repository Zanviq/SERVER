/**
 * 이름 규칙 회귀 테스트.  실행: npm test  (frontend 폴더에서)
 *
 * 확장자 판정이 프런트와 백엔드에서 다르면 화면과 서버가 다르게 행동한다.
 * 실제로 프런트는 `\.[A-Za-z0-9]{1,8}$` 만 봐서 `v1.2`·`2026.08` 을 확장자가
 * 있는 이름으로 보고 "확장자 없이 제목만 적어 주세요"로 막았는데, 서버는 그 둘을
 * 확장자로 보지 않는다. 사용자는 멀쩡한 제목을 못 쓰고 이유도 알 수 없다.
 *
 * 여기서는 **백엔드와 같은 답이 나오는지**를 표로 못 박는다
 * (backend/file_kinds.py 의 looks_like_extension·split_ext 와 같은 규칙).
 */
import { bundle } from "./bundle.mjs";

const { looksLikeExtension, splitExt } = await bundle("src/lib/names.ts");

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

// [이름, 확장자] — 백엔드 file_kinds.split_ext 와 같은 답이어야 한다
const TABLE = [
  ["문서.md", ".md"],
  ["사진.jpeg", ".jpeg"],
  ["script.py", ".py"],
  ["2026.08 회고", ""],      // 날짜다
  ["2026.08 회고.md", ".md"],
  ["v1.2", ""],              // 버전이다
  ["예산 1.5", ""],
  ["폴더이름", ""],
  ["점.", ""],
  ["폴더/문서.md", ".md"],
  ["폴더/2026.08", ""],
  ["a.verylongext", ""],     // 8글자 초과
  [".gitignore", ""],        // 9글자라 확장자가 아니다(백엔드도 같은 답)
];

console.log("확장자 판정 — 백엔드와 같은 답인가");
for (const [name, ext] of TABLE) {
  check(`${name} → ${ext || "(없음)"}`, splitExt(name)[1], ext);
  check(`looksLikeExtension(${name})`, looksLikeExtension(name), Boolean(ext));
}

console.log("\n몸통 + 확장자 = 원래 이름");
for (const [name] of TABLE) {
  const [base, ext] = splitExt(name);
  check(`왕복 ${name}`, base + ext, name);
}

console.log(fails === 0 ? "\n모두 통과" : `\n실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
