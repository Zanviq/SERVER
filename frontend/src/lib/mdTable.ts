/**
 * 마크다운 표(GFM 파이프 표)를 다루는 순수 함수들.
 *
 * 편집기가 표를 "손으로 파이프를 맞추는 텍스트"가 아니라 격자처럼 다루게 하려고
 * 만들었다. 여기에는 CodeMirror 의존이 없다 — 문자열만 다루므로 동작을 따로
 * 확인하기 쉽고, 편집기 쪽은 위치 계산과 화면만 맡는다.
 *
 * 다루는 문법(GFM):
 *   | 머리1 | 머리2 |
 *   | --- | :---: |
 *   | 값1  | 값2  |
 * 구분선의 콜론이 정렬을 정한다.
 */

export type Align = "none" | "left" | "center" | "right";

export interface TableInfo {
  /** 표가 차지하는 줄 번호(1-based, 양끝 포함) */
  fromLine: number;
  toLine: number;
  /** 머리글 + 본문. 구분선은 뺀다(정렬은 aligns 로 따로 들고 있다). */
  rows: string[][];
  aligns: Align[];
  /** 커서가 있는 칸. 표 밖이면 -1. */
  row: number;
  col: number;
}

/** 구분선인가: `| --- | :--: |` 처럼 대시와 콜론만 있는 줄. */
function isSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-")) return false;
  const cells = splitCells(t);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** 표의 한 줄로 볼 수 있는가. 파이프가 있으면 관대하게 인정한다. */
function isTableLine(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

/**
 * 한 줄을 칸으로 나눈다.
 *
 * `\|`(이스케이프)와 인라인 코드 안의 `|`는 구분자가 아니다 — 그걸 세면
 * 코드가 든 칸에서 표가 통째로 어긋난다.
 */
export function splitCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "\\|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function alignOf(cell: string): Align {
  const t = cell.trim();
  const l = t.startsWith(":");
  const r = t.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return "none";
}

function separatorCell(a: Align, width: number): string {
  const w = Math.max(3, width);
  if (a === "center") return `:${"-".repeat(w - 2)}:`;
  if (a === "right") return `${"-".repeat(w - 1)}:`;
  if (a === "left") return `:${"-".repeat(w - 1)}`;
  return "-".repeat(w);
}

/**
 * 표시 너비. 한글·한자·이모지는 고정폭 글꼴에서 두 칸을 쓴다.
 * 글자 수로만 맞추면 한글이 든 표가 원본에서 삐뚤어진다.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f64f) ||
      (c >= 0x1f900 && c <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s: string, width: number, a: Align): string {
  const gap = Math.max(0, width - displayWidth(s));
  if (a === "right") return " ".repeat(gap) + s;
  if (a === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + s + " ".repeat(gap - left);
  }
  return s + " ".repeat(gap);
}

/**
 * 커서 위치를 기준으로 표를 찾는다. 표가 아니면 null.
 *
 * `lines`는 문서 전체 줄 배열, `lineNo`는 1-based 커서 줄, `ch`는 그 줄에서의
 * 문자 위치(칸을 알아내는 데 쓴다).
 */
export function findTable(lines: string[], lineNo: number, ch: number): TableInfo | null {
  const i = lineNo - 1;
  if (i < 0 || i >= lines.length || !isTableLine(lines[i])) return null;

  let start = i;
  while (start > 0 && isTableLine(lines[start - 1])) start--;
  let end = i;
  while (end < lines.length - 1 && isTableLine(lines[end + 1])) end++;

  // 두 번째 줄이 구분선이어야 표다(그냥 파이프가 든 문단과 구분).
  if (end - start < 1 || !isSeparator(lines[start + 1])) return null;

  const aligns = splitCells(lines[start + 1]).map(alignOf);
  const rows: string[][] = [];
  let cursorRow = -1;
  for (let n = start; n <= end; n++) {
    if (n === start + 1) {
      // 구분선은 rows 에 담지 않는다. 다만 **커서가 거기 있을 수는 있다** —
      // 그때 row 를 -1 로 두면 툴바의 "행−"·"열−"이 splice(-1,1) 로 맨 끝
      // 행·열을 지운다. 구분선은 머리글에 딸린 줄이므로 머리글로 본다.
      if (n === i) cursorRow = 0;
      continue;
    }
    if (n === i) cursorRow = rows.length;
    rows.push(splitCells(lines[n]).map((c) => c.trim()));
  }

  // 커서가 몇 번째 칸인지 — 그 줄에서 커서 앞의 구분자 개수를 센다
  let cursorCol = -1;
  if (cursorRow >= 0) {
    const line = lines[i];
    const before = line.slice(0, ch);
    const lead = line.match(/^\s*\|/) ? 1 : 0;
    let bars = 0;
    let inCode = false;
    for (let k = 0; k < before.length; k++) {
      if (before[k] === "\\" && before[k + 1] === "|") { k++; continue; }
      if (before[k] === "`") inCode = !inCode;
      if (before[k] === "|" && !inCode) bars++;
    }
    cursorCol = Math.max(0, bars - lead);
  }

  const width = Math.max(aligns.length, ...rows.map((r) => r.length));
  return {
    fromLine: start + 1,
    toLine: end + 1,
    rows: rows.map((r) => fit(r, width)),
    aligns: fit(aligns, width, "none" as Align),
    row: cursorRow,
    col: Math.min(cursorCol, width - 1),
  };
}

function fit<T>(arr: T[], n: number, filler?: T): T[] {
  const out = arr.slice(0, n);
  while (out.length < n) out.push((filler ?? ("" as unknown as T)));
  return out;
}

/** 격자를 파이프 폭이 맞은 마크다운으로. */
export function formatTable(rows: string[][], aligns: Align[]): string {
  const cols = Math.max(aligns.length, ...rows.map((r) => r.length));
  const grid = rows.map((r) => fit(r, cols, ""));
  const al = fit(aligns, cols, "none" as Align);
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths.push(Math.max(3, ...grid.map((r) => displayWidth(r[c] ?? ""))));
  }
  const line = (cells: string[]) =>
    `| ${cells.map((v, c) => pad(v, widths[c], al[c])).join(" | ")} |`;
  const out = [line(grid[0] ?? [])];
  out.push(`| ${al.map((a, c) => separatorCell(a, widths[c])).join(" | ")} |`);
  for (let r = 1; r < grid.length; r++) out.push(line(grid[r]));
  return out.join("\n");
}

// ── 변형 ─────────────────────────────────────────────────────────────

const clone = (rows: string[][]) => rows.map((r) => r.slice());

export function insertRow(t: TableInfo, at: number): TableInfo {
  const rows = clone(t.rows);
  // 머리글 위에는 넣지 않는다(머리글이 없는 표는 GFM이 아니다)
  const idx = Math.max(1, Math.min(at, rows.length));
  rows.splice(idx, 0, new Array(t.aligns.length).fill(""));
  return { ...t, rows, row: idx, col: 0 };
}

export function deleteRow(t: TableInfo, at: number): TableInfo | null {
  if (at < 0) return null; // 음수는 splice 가 뒤에서부터 세어 엉뚱한 행을 지운다
  if (at <= 0) return null; // 머리글은 지우지 않는다
  if (t.rows.length <= 2) return null; // 머리글 + 최소 1행은 남긴다
  const rows = clone(t.rows);
  rows.splice(at, 1);
  return { ...t, rows, row: Math.min(at, rows.length - 1) };
}

export function insertCol(t: TableInfo, at: number): TableInfo {
  const idx = Math.max(0, Math.min(at, t.aligns.length));
  const rows = t.rows.map((r) => {
    const c = r.slice();
    c.splice(idx, 0, "");
    return c;
  });
  const aligns = t.aligns.slice();
  aligns.splice(idx, 0, "none");
  return { ...t, rows, aligns, col: idx };
}

export function deleteCol(t: TableInfo, at: number): TableInfo | null {
  if (at < 0) return null; // 음수는 splice 가 뒤에서부터 세어 엉뚱한 열을 지운다
  if (t.aligns.length <= 1) return null; // 마지막 열은 남긴다
  const rows = t.rows.map((r) => {
    const c = r.slice();
    c.splice(at, 1);
    return c;
  });
  const aligns = t.aligns.slice();
  aligns.splice(at, 1);
  return { ...t, rows, aligns, col: Math.max(0, Math.min(at, aligns.length - 1)) };
}

export function setAlign(t: TableInfo, at: number, a: Align): TableInfo {
  if (at < 0 || at >= t.aligns.length) return t;
  const aligns = t.aligns.slice();
  aligns[at] = a;
  return { ...t, aligns };
}

/** 다음/이전 칸. 표 끝에서 앞으로 가면 행을 하나 늘린다(노션과 같다). */
export function nextCell(t: TableInfo, dir: 1 | -1): TableInfo {
  const cols = t.aligns.length;
  let r = t.row;
  let c = t.col + dir;
  if (c >= cols) {
    c = 0;
    r++;
    if (r >= t.rows.length) return { ...insertRow(t, t.rows.length), col: 0 };
  } else if (c < 0) {
    c = cols - 1;
    r--;
    if (r < 0) return { ...t, row: 0, col: 0 };
  }
  return { ...t, row: r, col: c };
}

/**
 * 격자에서 (행, 열) 칸의 텍스트가 시작하는 위치(표 문자열 기준 오프셋).
 * 편집기가 커서를 그 칸에 놓는 데 쓴다.
 */
export function cellOffset(text: string, row: number, col: number): number {
  const lines = text.split("\n");
  // 구분선은 rows 색인에 없으므로 실제 줄 번호로 되돌린다
  const lineIdx = row === 0 ? 0 : row + 1;
  if (lineIdx >= lines.length) return text.length;
  let off = 0;
  for (let i = 0; i < lineIdx; i++) off += lines[i].length + 1;
  const line = lines[lineIdx];
  // 이 줄의 칸 구분자 위치들(이스케이프 `\|` 와 인라인 코드 안은 제외)
  const bars: number[] = [];
  let inCode = false;
  for (let k = 0; k < line.length; k++) {
    if (line[k] === "\\" && line[k + 1] === "|") { k++; continue; }
    if (line[k] === "`") inCode = !inCode;
    if (line[k] === "|" && !inCode) bars.push(k);
  }
  const open = bars[col];
  if (open === undefined) return off + line.length;
  // 칸의 오른쪽 끝. **여백을 건너뛸 때 이 선을 넘으면 안 된다** — 넘으면 빈 칸에서
  // 커서가 오른쪽 파이프에 가서 붙고, Tab 으로 옮겨 가 글자를 치면
  // `|     값|` 처럼 칸 밖에 붙어 버린다(브라우저에서 실측).
  const close = bars[col + 1] ?? line.length;
  let s = open + 1;
  while (s < close && line[s] === " ") s++;
  if (s >= close) s = Math.min(open + 2, close); // 빈 칸이면 `| ` 바로 뒤
  return off + s;
}
