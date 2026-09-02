/**
 * 위키링크·임베드 변환 회귀 테스트.  실행: npm test  (frontend 폴더에서)
 *
 * 이 변환은 마크다운 파서에 넣기 **전에** 원문 문자열을 직접 고친다. 그래서
 * 코드 안까지 바꿔 버리기 쉽다 — 문서에 위키링크 문법을 설명하려고 코드로 적어 둔
 * `[[제목]]` 이 진짜 링크가 되면, 화면의 코드가 사용자가 쓴 것과 달라진다.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "wiki-"));
const outFile = join(dir, "wiki.mjs");
const src = join(here, "..", "src", "lib", "wikiTransform.ts");
execFileSync("npx", ["esbuild", src, "--bundle", "--format=esm", `--outfile=${outFile}`],
  { stdio: "pipe", shell: true });
const { transformWiki } = await import("file://" + outFile.replace(/\\/g, "/"));

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

console.log(fails === 0 ? "\n모두 통과" : `\n실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
