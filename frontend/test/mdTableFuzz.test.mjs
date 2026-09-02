/**
 * 표 편집 무작위 검사.  실행: npm test  (frontend 폴더에서)
 *
 * 표는 사용자의 글을 **통째로 다시 써서** 저장한다. 그래서 예시 몇 개로는
 * 부족하다 — 손으로 고른 입력은 늘 내가 상상한 모양뿐이다. 여기서는 무작위로
 * 만든 표에 대고 다음 두 가지가 항상 참인지 본다.
 *
 *   1) 다시 써도 내용이 그대로다(칸 글자가 사라지거나 옮겨 다니지 않는다)
 *   2) 한 번 다시 쓴 결과를 또 쓰면 똑같다(들쭉날쭉 흔들리지 않는다)
 *
 * 무작위지만 씨앗을 고정해서, 깨지면 같은 입력으로 다시 볼 수 있게 한다.
 */
import { bundle } from "./bundle.mjs";

const T = await bundle("src/lib/mdTable.ts");

// 씨앗 고정 난수(xorshift) — 깨진 입력을 그대로 재현할 수 있어야 한다
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

const CELL_BITS = [
  "가", "나다", "한글 여러 글자", "abc", "A", "", " ", "1", "12345",
  "점.있음", "느낌표!", "괄호(안)", "물결~", "밑줄_", "별표*", "**굵게**",
  "`코드`", "`a | b`", "\\|", "==강조==", "가나다라마바사아자차카타파하", "-", ":---:",
];

function randomTable(rand) {
  const cols = 1 + Math.floor(rand() * 5);
  const rows = 1 + Math.floor(rand() * 5);
  const aligns = Array.from({ length: cols }, () => {
    const r = rand();
    return r < 0.4 ? "none" : r < 0.6 ? "left" : r < 0.8 ? "center" : "right";
  });
  const grid = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => CELL_BITS[Math.floor(rand() * CELL_BITS.length)]));
  return { grid, aligns };
}

let fails = 0;
function fail(label, detail) {
  fails++;
  console.log(`  FAIL ${label}\n       ${detail}`);
}

const rand = rng(20260902);
let checked = 0;
for (let i = 0; i < 400; i++) {
  const { grid, aligns } = randomTable(rand);
  const text = T.formatTable(grid, aligns);
  const lines = text.split("\n");

  // 1) 다시 읽어 같은 격자가 나오는가
  const info = T.findTable(lines, 1, 0);
  if (!info) {
    fail(`#${i} 다시 못 읽는다`, JSON.stringify({ grid, aligns, text }));
    continue;
  }
  const back = info.rows.map((r) => r.map((c) => c.trim()));
  const want = grid.map((r) => r.map((c) => c.trim()));
  if (JSON.stringify(back) !== JSON.stringify(want)) {
    fail(`#${i} 내용이 바뀐다`, `${JSON.stringify(want)}\n       → ${JSON.stringify(back)}`);
    continue;
  }
  if (JSON.stringify(info.aligns) !== JSON.stringify(aligns)) {
    fail(`#${i} 정렬이 바뀐다`, `${JSON.stringify(aligns)} → ${JSON.stringify(info.aligns)}`);
    continue;
  }

  // 2) 다시 써도 같은가(안정)
  const again = T.formatTable(info.rows, info.aligns);
  if (again !== text) {
    fail(`#${i} 다시 쓸 때마다 달라진다`, `${JSON.stringify(text)}\n       → ${JSON.stringify(again)}`);
    continue;
  }

  // 3) 어느 칸을 눌러도 커서가 그 칸 안에 놓이는가
  for (let r = 0; r < info.rows.length; r++) {
    for (let c = 0; c < info.aligns.length; c++) {
      const off = T.cellOffset(text, r, c);
      const lineNo = text.slice(0, off).split("\n").length;
      const put = text.slice(0, off) + "x" + text.slice(off);
      const putLine = put.split("\n")[lineNo - 1];
      const cells = T.splitCells(putLine);
      const seg = cells[c] ?? "";
      const orig = (info.rows[r][c] ?? "").trim();
      // 칸 안에 들어가는 것만으로는 부족하다 — **칸 글자가 시작되는 자리**여야 한다.
      // 내용이 있으면 그 앞, 빈 칸이면 `| ` 바로 뒤. 여백 끝까지 밀리면
      // `|     값|` 처럼 오른쪽 파이프에 붙는다(실제로 그랬다).
      // 가운데·오른쪽 정렬은 여백이 앞에 오므로 트림해서 본다.
      const ok = orig ? seg.trim() === `x${orig}` : /^ ?x/.test(seg);
      if (!ok) {
        fail(`#${i} (${r},${c}) 커서가 칸 글자 앞이 아니다`,
          `${JSON.stringify(putLine)} / 칸=${JSON.stringify(seg)} / 원래=${JSON.stringify(orig)}`);
        r = info.rows.length;
        break;
      }
      checked++;
    }
  }
}

console.log(`  표 400개 / 칸 ${checked}곳 확인`);
console.log(fails === 0 ? "\n모두 통과" : `\n실패 ${fails}건`);
process.exit(fails === 0 ? 0 : 1);
