/**
 * 표 편집 도구 — 커서가 표 안에 있을 때만 뜨는 툴바 + Tab으로 칸 이동.
 *
 * 마크다운 표는 텍스트라, 노션처럼 쓰려면 "격자를 고치고 다시 써 넣는" 층이
 * 필요하다. 격자 계산은 lib/mdTable(순수 함수)에 있고 여기서는 CodeMirror와
 * 이어 붙이기만 한다 — 위치 계산과 화면.
 */
import { EditorView, keymap, showTooltip } from "@codemirror/view";
import type { Tooltip } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  Align,
  TableInfo,
  cellOffset,
  deleteCol,
  deleteRow,
  findTable,
  formatTable,
  insertCol,
  insertRow,
  nextCell,
  setAlign,
} from "../../lib/mdTable";

/** 코드블록 안인가. 안이면 표처럼 생긴 줄도 손대면 안 된다. */
function inCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    const n = node.name;
    if (n === "FencedCode" || n === "CodeBlock" || n === "CodeText" || n === "InlineCode") {
      return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

/**
 * 커서 위치의 표. 없으면 null.
 *
 * **코드블록 안은 제외한다.** 코드에 파이프 표를 적어 두는 일은 흔한데(문서에
 * 표 문법을 설명하는 등), 그걸 표로 보고 Tab 을 누르면 코드가 다시 쓰여 망가진다
 * (실측으로 잡았다).
 */
function tableAt(state: EditorState): TableInfo | null {
  const sel = state.selection.main;
  if (!sel.empty) return null; // 여러 줄을 고른 상태에서는 방해하지 않는다
  if (inCode(state, sel.head)) return null;
  const line = state.doc.lineAt(sel.head);
  const lines = state.doc.toString().split("\n");
  return findTable(lines, line.number, sel.head - line.from);
}

/** 바뀐 격자를 문서에 써 넣고, 지정한 칸으로 커서를 옮긴다. */
function applyTable(view: EditorView, t: TableInfo): void {
  const from = view.state.doc.line(t.fromLine).from;
  const to = view.state.doc.line(t.toLine).to;
  const text = formatTable(t.rows, t.aligns);
  const at = from + cellOffset(text, Math.max(0, t.row), Math.max(0, t.col));
  view.dispatch({
    changes: { from, to, insert: text },
    // 표가 짧아졌을 수 있으니 문서 길이로 한 번 더 막는다
    selection: { anchor: Math.min(at, from + text.length) },
    scrollIntoView: true,
  });
  view.focus();
}

/** 표 전체를 다시 써 파이프 폭을 맞춘다(내용은 그대로). */
function reformat(view: EditorView): boolean {
  const t = tableAt(view.state);
  if (!t) return false;
  applyTable(view, t);
  return true;
}

type Cmd = (view: EditorView) => boolean;

const withTable = (fn: (t: TableInfo) => TableInfo | null): Cmd => (view) => {
  const t = tableAt(view.state);
  if (!t) return false;
  const next = fn(t);
  if (!next) return false;
  applyTable(view, next);
  return true;
};

const cmds = {
  rowAbove: withTable((t) => insertRow(t, Math.max(1, t.row))),
  rowBelow: withTable((t) => insertRow(t, t.row + 1)),
  rowDelete: withTable((t) => deleteRow(t, t.row)),
  colLeft: withTable((t) => insertCol(t, t.col)),
  colRight: withTable((t) => insertCol(t, t.col + 1)),
  colDelete: withTable((t) => deleteCol(t, t.col)),
  alignLeft: withTable((t) => setAlign(t, t.col, "left")),
  alignCenter: withTable((t) => setAlign(t, t.col, "center")),
  alignRight: withTable((t) => setAlign(t, t.col, "right")),
  next: withTable((t) => nextCell(t, 1)),
  prev: withTable((t) => nextCell(t, -1)),
};

const ICON = {
  rowAbove: "위에 행",
  rowBelow: "아래 행",
  rowDelete: "행 삭제",
  colLeft: "왼쪽 열",
  colRight: "오른쪽 열",
  colDelete: "열 삭제",
};

const ALIGN_LABEL: Record<Exclude<Align, "none">, string> = {
  left: "왼쪽",
  center: "가운데",
  right: "오른쪽",
};

function button(text: string, title: string, onClick: () => void, active = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-tbl-btn" + (active ? " is-on" : "");
  b.textContent = text;
  b.title = title;
  // mousedown 을 막아야 에디터가 포커스를 잃지 않는다(잃으면 커서 위치가 사라져
  // 어느 칸을 고칠지 알 수 없게 된다).
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = (e) => {
    e.preventDefault();
    onClick();
  };
  return b;
}

function toolbarDOM(view: EditorView, t: TableInfo): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-tbl-bar";
  const run = (c: Cmd) => () => c(view);

  (["rowAbove", "rowBelow", "rowDelete"] as const).forEach((k) =>
    wrap.appendChild(button(ICON[k], ICON[k], run(cmds[k]))),
  );
  wrap.appendChild(Object.assign(document.createElement("span"), { className: "cm-tbl-sep" }));
  (["colLeft", "colRight", "colDelete"] as const).forEach((k) =>
    wrap.appendChild(button(ICON[k], ICON[k], run(cmds[k]))),
  );
  wrap.appendChild(Object.assign(document.createElement("span"), { className: "cm-tbl-sep" }));
  const cur = t.aligns[t.col] ?? "none";
  wrap.appendChild(button("⇤", `${ALIGN_LABEL.left} 정렬`, run(cmds.alignLeft), cur === "left"));
  wrap.appendChild(button("↔", `${ALIGN_LABEL.center} 정렬`, run(cmds.alignCenter), cur === "center"));
  wrap.appendChild(button("⇥", `${ALIGN_LABEL.right} 정렬`, run(cmds.alignRight), cur === "right"));
  return wrap;
}

/** 커서가 표 안일 때 표 첫 줄 위에 툴바를 띄운다. */
const tableTooltip = StateField.define<readonly Tooltip[]>({
  create: (state) => build(state),
  update: (v, tr) => (tr.docChanged || tr.selection ? build(tr.state) : v),
  provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

function build(state: EditorState): readonly Tooltip[] {
  const t = tableAt(state);
  if (!t) return [];
  const pos = state.doc.line(t.fromLine).from;
  return [{
    pos,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view) => ({ dom: toolbarDOM(view, t) }),
  }];
}

const tableKeymap = keymap.of([
  // Tab 은 표 안에서만 가로챈다 — 밖에서는 기본 동작(들여쓰기)을 그대로 둔다.
  { key: "Tab", run: cmds.next },
  { key: "Shift-Tab", run: cmds.prev },
  // 폭이 흐트러졌을 때 손으로 다시 맞추는 단축키
  { key: "Mod-Shift-f", run: reformat },
]);

const tableTheme = EditorView.theme({
  ".cm-tbl-bar": {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "3px 4px",
    borderRadius: "8px",
    border: "1px solid rgb(var(--line))",
    backgroundColor: "rgb(var(--bg-elevated))",
    boxShadow: "0 2px 8px rgb(0 0 0 / 0.12)",
    fontFamily: "Pretendard, sans-serif",
  },
  ".cm-tbl-btn": {
    padding: "2px 6px",
    fontSize: "11px",
    lineHeight: "1.5",
    borderRadius: "5px",
    border: "1px solid transparent",
    background: "transparent",
    color: "rgb(var(--fg-muted))",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  ".cm-tbl-btn:hover": {
    backgroundColor: "rgb(var(--fg) / 0.07)",
    color: "rgb(var(--fg))",
  },
  ".cm-tbl-btn.is-on": {
    backgroundColor: "rgb(var(--accent) / 0.18)",
    color: "rgb(var(--accent-fg))",
    borderColor: "rgb(var(--accent) / 0.4)",
  },
  ".cm-tbl-sep": {
    width: "1px",
    height: "14px",
    margin: "0 3px",
    backgroundColor: "rgb(var(--line))",
  },
});

/** 편집기에 꽂을 확장 묶음. */
export function tableTools(): Extension {
  return [tableTooltip, tableKeymap, tableTheme];
}
