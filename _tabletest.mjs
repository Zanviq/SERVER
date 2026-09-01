// mdTable 순수 함수 검증 — 편집기에 붙이기 전에.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ts를 그대로 못 돌리므로 esbuild로 한 번 굴린다(vite에 딸려 있다)
const dir = mkdtempSync(join(tmpdir(), "mdt-"));
const outFile = join(dir, "mdTable.mjs");
const src = join(process.cwd(), "src", "lib", "mdTable.ts");
// 인자 배열로 넘긴다 — 셸을 거치지 않으므로 경로에 공백이 있어도 안전하다
execFileSync("npx", ["esbuild", src, "--bundle", "--format=esm", `--outfile=${outFile}`],
  { stdio: "pipe", shell: true });
const T = await import("file://" + outFile.replace(/\\/g, "/"));

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

const doc = [
  "앞 문단",
  "",
  "| 이름 | 값 | 비고 |",
  "| --- | :---: | ---: |",
  "| 하나 | 1 | 가 |",
  "| 둘 | 2 | 나 |",
  "",
  "뒤 문단",
];

console.log("[찾기]");
const t = T.findTable(doc, 5, 3); // "| 하나 | ..." 의 3번째 글자
check("표 범위", [t.fromLine, t.toLine], [3, 6]);
// GFM에서 `---`는 "왼쪽 정렬"이 아니라 "지정 없음"이다(렌더는 왼쪽으로 보이지만
// 원본을 되쓸 때 콜론을 임의로 붙이면 안 되므로 구분해서 들고 있다).
check("정렬 해석", t.aligns, ["none", "center", "right"]);
check("격자", t.rows, [["이름", "값", "비고"], ["하나", "1", "가"], ["둘", "2", "나"]]);
check("커서 행/열", [t.row, t.col], [1, 0]);
check("표 아닌 줄", T.findTable(doc, 1, 0), null);
check("구분선 없으면 표 아님", T.findTable(["| a | b |", "| c | d |"], 1, 0), null);

console.log("\n[칸 나누기]");
check("이스케이프 파이프", T.splitCells("| a \\| b | c |"), [" a \\| b ", " c "]);
check("인라인 코드 안 파이프", T.splitCells("| `a|b` | c |"), [" `a|b` ", " c "]);

console.log("\n[표시 너비]");
check("한글은 두 칸", T.displayWidth("가나"), 4);
check("영문은 한 칸", T.displayWidth("ab"), 2);

console.log("\n[서식]");
const formatted = T.formatTable(t.rows, t.aligns);
console.log(formatted.split("\n").map((l) => "       " + l).join("\n"));
check("줄 수", formatted.split("\n").length, 4);
check("정렬 유지", formatted.split("\n")[1], "| ---- | :-: | ---: |");

console.log("\n[변형]");
const added = T.insertRow(t, 2);
check("행 추가", added.rows.length, 4);
check("머리글 위에는 안 넣는다", T.insertRow(t, 0).rows[0], ["이름", "값", "비고"]);
check("머리글은 못 지운다", T.deleteRow(t, 0), null);
const delRow = T.deleteRow(t, 1);
check("행 삭제", delRow.rows.length, 2);
check("최소 1행은 남긴다", T.deleteRow(delRow, 1), null);

const addedCol = T.insertCol(t, 1);
check("열 추가", addedCol.aligns.length, 4);
check("모든 행에 칸 추가", addedCol.rows.every((r) => r.length === 4), true);
const delCol = T.deleteCol(t, 1);
check("열 삭제", delCol.aligns, ["none", "right"]);
check("마지막 열은 못 지운다", T.deleteCol({ ...t, aligns: ["left"], rows: [["a"], ["b"]] }, 0), null);
check("정렬 바꾸기", T.setAlign(t, 0, "center").aligns[0], "center");

console.log("\n[칸 이동]");
check("다음 칸", [T.nextCell(t, 1).row, T.nextCell(t, 1).col], [1, 1]);
const atEnd = { ...t, row: 2, col: 2 };
const wrapped = T.nextCell(atEnd, 1);
check("끝에서 Tab → 새 행", [wrapped.rows.length, wrapped.row, wrapped.col], [4, 3, 0]);
check("이전 칸", [T.nextCell({ ...t, row: 1, col: 0 }, -1).row, T.nextCell({ ...t, row: 1, col: 0 }, -1).col], [0, 2]);

console.log("\n[커서 위치]");
const txt = T.formatTable(t.rows, t.aligns);
const off = T.cellOffset(txt, 1, 1);
check("1행 1열 시작 글자", txt.slice(off, off + 1), "1");
const off2 = T.cellOffset(txt, 0, 2);
check("머리글 2열 시작", txt.slice(off2, off2 + 2), "비고");

console.log(`\n실패: ${fails}`);
process.exit(fails ? 1 : 0);
