/**
 * 형광펜(`==강조==`) 회귀 테스트.  실행: npm test  (frontend 폴더에서)
 *
 * 편집기(CodeMirror/@lezer/markdown)와 읽기 뷰(remark)는 파서가 완전히 다르다.
 * 규칙이 어긋나면 한쪽에서만 칠해지고, 사용자는 편집 중과 저장 후가 다르게 보인다.
 * 그래서 **두 파서에 같은 입력을 먹여 결과가 같은지** 본다.
 *
 * 이 테스트가 생긴 계기: `조건은 a == b 이고 c == d 일 때` 라는 평범한 문장이
 * 읽기 뷰에서 `a` 와 `d` 사이 통째로 형광펜이 됐다(브라우저에서 실측). 개발 메모에
 * 비교 연산자를 쓰는 일은 흔하다.
 */
import { bundle } from "./bundle.mjs";

const { cmHighlightExtension, remarkHighlight } = await bundle("src/lib/markdownExtras.ts");

const { parser: baseParser } = await import("@lezer/markdown");
const { unified } = await import("unified");
const remarkParse = (await import("remark-parse")).default;

const cmParser = baseParser.configure([cmHighlightExtension]);

/** 편집기 파서가 형광펜으로 잡은 구간의 텍스트들. */
function editorMarks(text) {
  const tree = cmParser.parse(text);
  const out = [];
  tree.iterate({
    enter(node) {
      if (node.name === "Highlight") {
        // 구분자(==) 두 쌍을 뺀 알맹이
        out.push(text.slice(node.from + 2, node.to - 2));
      }
    },
  });
  return out;
}

/** 읽기 뷰 변환기가 <mark> 로 만든 구간의 텍스트들. */
const mdProcessor = unified().use(remarkParse).use(remarkHighlight);
function readerMarks(text) {
  const tree = mdProcessor.runSync(mdProcessor.parse(text));
  const out = [];
  (function walk(n) {
    if (n.type === "delete" && n.data && n.data.hName === "mark") {
      out.push((n.children || []).map((c) => c.value ?? "").join(""));
      return;
    }
    (n.children || []).forEach(walk);
  })(tree);
  return out;
}

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

/** 두 파서가 같은 결과를 내는지까지 함께 본다. */
function both(label, text, want) {
  const r = readerMarks(text);
  const e = editorMarks(text);
  check(`읽기 뷰 — ${label}`, r, want);
  check(`편집기   — ${label}`, e, want);
  if (JSON.stringify(r) !== JSON.stringify(e)) {
    fails++;
    console.log(`  FAIL 두 파서가 어긋남 — ${label}\n       읽기 ${JSON.stringify(r)}\n       편집 ${JSON.stringify(e)}`);
  }
}

console.log("형광펜");
both("보통 형광펜", "진짜 ==여기== 강조", ["여기"]);
both("여러 단어", "==여러 단어를 강조== 함", ["여러 단어를 강조"]);
both("한 글자", "==가== 하나", ["가"]);
both("한 줄에 둘", "==앞== 가운데 ==뒤==", ["앞", "뒤"]);

console.log("\n비교 연산자는 형광펜이 아니다");
both("문장 속 ==", "조건은 a == b 이고 c == d 일 때 참이다.", []);
both("숫자 비교", "x == 1 과 y == 2 를 비교", []);
both("여는 쪽 공백", "== 앞에 공백==", []);
both("닫는 쪽 공백", "==뒤에 공백 ==", []);
both("양쪽 공백", "== 양쪽 ==", []);

console.log("\n경계");
both("세 개 이상", "제목\n===\n본문", []);
both("빈 형광펜", "====", []);
both("연산자 뒤 진짜 형광펜", "a == b 인데 ==이건 강조==", ["이건 강조"]);

// 코드 안의 == 는 어느 쪽에서도 칠해지면 안 된다(읽기 뷰는 text 노드만 손대고,
// 편집기는 코드 노드 안에서 인라인 파서가 돌지 않는다)
check("인라인 코드 안 — 읽기", readerMarks("`a == b` 는 코드"), []);
check("인라인 코드 안 — 편집", editorMarks("`a == b` 는 코드"), []);
check("코드블록 안 — 읽기", readerMarks("```\nif a == b and c == d:\n    pass\n```"), []);
check("코드블록 안 — 편집", editorMarks("```\nif a == b and c == d:\n    pass\n```"), []);

console.log(fails === 0 ? "\n모두 통과" : `\n실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
