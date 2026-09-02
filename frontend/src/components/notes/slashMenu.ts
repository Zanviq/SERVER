/**
 * `/` 슬래시 메뉴 — 노션처럼 빈 줄에서 `/`를 치면 넣을 블록을 고른다.
 *
 * CodeMirror의 자동완성 위에 얹었다. 별도 팝업을 띄우면 키보드 조작(위/아래,
 * Enter, Esc)과 화면 밖으로 나갈 때의 위치 보정을 다시 만들어야 하는데,
 * 자동완성은 그걸 이미 다 한다.
 *
 * 규칙: **줄 맨 앞의 `/` 에서만** 뜬다. 문장 중간의 `and/or` 같은 데서 뜨면
 * 글쓰기를 방해한다(경로를 적을 때도 마찬가지다).
 */
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

export interface SlashActions {
  /** 파일 선택 창을 열어 업로드 → 커서 위치에 삽입 */
  attachImage?: () => void;
  /** 새 문서를 만들고 `[[링크]]` 까지 넣는다.
   *
   *  넣는 일을 여기서 하지 않는 이유: 제목을 묻는 동안 사용자가 다른 문서로
   *  옮겨 갈 수 있다. 그러면 편집기가 새로 만들어져 이 view 는 죽은 것이고,
   *  링크는 아무 안내 없이 사라진다. 업로드 삽입과 같은 대조가 필요하므로
   *  그 대조를 아는 편집기가 맡는다. */
  createDocLink?: (view: EditorView, at: number) => void;
}

/**
 * 커서를 둘 자리 표시.
 *
 * 처음엔 `|` 를 썼는데 **표 문법과 충돌했다** — 표 조각의 첫 칸 구분자가
 * 커서 표시로 먹혀 `| 항목 |` 이 ` 항목 |` 로 들어갔다. 문서에 나올 일이 없는
 * 제어문자를 쓴다.
 */
const CURSOR = "\u0001";

/** 삽입할 조각. */
interface Snippet {
  label: string;
  detail: string;
  /** 넣을 텍스트. CURSOR 가 있으면 그 자리에 커서를 둔다. */
  text: string;
  /** 검색어(한글 라벨만으로는 영문 입력에 안 걸린다) */
  keywords?: string;
  boost?: number;
}

const SNIPPETS: Snippet[] = [
  { label: "제목 1", detail: "# 큰 제목", text: `# ${CURSOR}`, keywords: "h1 heading title 제목", boost: 9 },
  { label: "제목 2", detail: "## 중간 제목", text: `## ${CURSOR}`, keywords: "h2 heading 제목", boost: 8 },
  { label: "제목 3", detail: "### 작은 제목", text: `### ${CURSOR}`, keywords: "h3 heading 제목", boost: 7 },
  { label: "글머리 기호", detail: "- 목록", text: `- ${CURSOR}`, keywords: "bullet list ul 목록" },
  { label: "번호 목록", detail: "1. 목록", text: `1. ${CURSOR}`, keywords: "ordered list ol 번호" },
  { label: "체크박스", detail: "- [ ] 할 일", text: `- [ ] ${CURSOR}`, keywords: "todo task checkbox 체크 할일" },
  { label: "인용", detail: "> 인용문", text: `> ${CURSOR}`, keywords: "quote blockquote 인용" },
  // 크기를 고를 수 있게 여러 개 둔다("어떤 표를 넣을지" 고르는 게 요점이다).
  // 넣은 뒤에도 툴바로 행·열을 더할 수 있으니 흔한 크기만 준비한다.
  ...tableSnippets(),
  {
    label: "코드 블록",
    detail: "``` 코드 ```",
    text: `\`\`\`\n${CURSOR}\n\`\`\``,
    keywords: "code block 코드",
  },
  { label: "구분선", detail: "가로줄", text: `---\n${CURSOR}`, keywords: "hr divider 구분선" },
  { label: "형광펜", detail: "==강조==", text: `==${CURSOR}==`, keywords: "highlight mark 형광펜 강조" },
  {
    label: "콜아웃(참고)",
    detail: "> [!NOTE] 강조 상자",
    text: `> [!NOTE] ${CURSOR}`,
    keywords: "callout note info 콜아웃 참고 정보 상자",
    boost: 4,
  },
  {
    label: "콜아웃(팁)",
    detail: "> [!TIP]",
    text: `> [!TIP] ${CURSOR}`,
    keywords: "callout tip 콜아웃 팁",
  },
  {
    label: "콜아웃(주의)",
    detail: "> [!WARNING]",
    text: `> [!WARNING] ${CURSOR}`,
    keywords: "callout warning 콜아웃 주의 경고",
  },
  {
    label: "토글",
    detail: "접었다 펴는 블록",
    text: `<details>\n<summary>${CURSOR}</summary>\n\n내용\n\n</details>`,
    keywords: "toggle details fold 토글 접기 펼치기",
    boost: 4,
  },
  { label: "문서 링크", detail: "[[다른 문서]]", text: `[[${CURSOR}`, keywords: "link wiki 링크 문서" },
];

/**
 * 표 조각 만들기.
 *
 * 머리글 첫 칸에 커서를 둔다 — 넣자마자 바로 항목 이름을 칠 수 있게.
 * 빈 칸은 공백 하나로 둔다(칸이 아예 비면 일부 렌더러가 열을 지운다).
 */
function tableSnippet(cols: number, bodyRows: number): string {
  // 머리글도 본문과 같은 여백으로 — 넣자마자 원본이 들쭉날쭉하면 지저분하다
  const head = Array(cols).fill("  ");
  head[0] = ` ${CURSOR} `;
  const sep = Array(cols).fill(" --- ");
  const row = Array(cols).fill("  ");
  const line = (cells: string[]) => `|${cells.join("|")}|`;
  return [line(head), line(sep), ...Array(bodyRows).fill(line(row))].join("\n") + "\n";
}

function tableSnippets(): Snippet[] {
  return [2, 3, 4].map((cols) => ({
    label: `표 ${cols}열`,
    detail: `${cols}열 × 2행`,
    text: tableSnippet(cols, 2),
    keywords: `table 표 테이블 ${cols}열 ${cols}컬럼 column`,
    boost: cols === 3 ? 6 : 5,
  }));
}

/** CURSOR 자리에 커서를 두도록 텍스트와 커서 오프셋으로 나눈다. */
function place(text: string): { body: string; cursor: number } {
  const at = text.indexOf(CURSOR);
  if (at < 0) return { body: text, cursor: text.length };
  return { body: text.slice(0, at) + text.slice(at + CURSOR.length), cursor: at };
}

/** 라벨·설명·검색어 중 아무 데나 걸리면 후보로 둔다(한글 라벨 + 영문 키워드). */
function matches(sn: Snippet, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // 공백을 지운 형태로도 맞춰 본다 — "표2열"로 쳐도 "표 2열"이 걸리게.
  const bare = (x: string) => x.toLowerCase().replace(/\s+/g, "");
  const qb = bare(q);
  const hay = [sn.label, sn.detail, sn.keywords ?? ""];
  return hay.some((h) => h.toLowerCase().includes(q) || bare(h).includes(qb));
}

export function makeSlashSource(actions: () => SlashActions) {
  return (ctx: CompletionContext): CompletionResult | null => {
    // 줄 시작 또는 목록 기호 뒤의 `/` 만 인정한다.
    // 검색어에 **공백을 허용한다** — 라벨이 "표 2열"·"콜아웃(참고)" 처럼 띄어져
    // 있어서, 공백을 막으면 그걸 좁혀서 고를 방법이 아예 없다.
    // 대신 걸리는 게 하나도 없으면 아래에서 null 을 돌려 메뉴가 닫히므로,
    // "/" 로 시작하는 평범한 문장을 쓸 때 계속 따라붙지는 않는다.
    const before = ctx.matchBefore(/(^|\n)[\s>*\-+]*\/([^/\n]{0,30})$/);
    if (!before) return null;
    const slash = before.text.lastIndexOf("/");
    const from = before.from + slash;
    // `/` 부터가 교체 범위다. 그러면 CM6의 기본 필터가 "/제목"을 라벨과 맞춰 보고
    // 전부 떨어뜨리므로(라벨에 "/"가 없다), 거르기는 우리가 직접 한다.
    const query = before.text.slice(slash + 1);

    const apply = (snippet: Snippet) => (view: EditorView, _c: Completion, f: number, to: number) => {
      const { body, cursor } = place(snippet.text);
      // 여러 줄짜리 블록(표·코드블록·토글)은 **줄 처음부터** 갈아 끼운다.
      // 인용문(`> `)이나 목록 기호 뒤에서 넣으면 그 기호가 블록 안으로 빨려
      // 들어간다 — 실측에서 `> ` 뒤에 표를 넣었더니 첫 칸이 `| > |` 가 됐다.
      const line = view.state.doc.lineAt(f);
      const multiline = body.includes("\n");
      const prefixOnly = /^[\s>*\-+]*$/.test(view.state.sliceDoc(line.from, f));
      const start = multiline && prefixOnly ? line.from : f;
      view.dispatch({
        changes: { from: start, to, insert: body },
        selection: { anchor: start + cursor },
      });
    };

    const options: Completion[] = SNIPPETS.filter((sn) => matches(sn, query)).map((sn) => ({
      label: sn.label,
      detail: sn.detail,
      type: "keyword",
      boost: sn.boost,
      apply: apply(sn),
    }));

    const act = actions();
    const extra = (label: string, detail: string, keywords: string) =>
      matches({ label, detail, text: "", keywords }, query);

    if (act.attachImage && extra("이미지", "파일에서 고르기", "image photo picture 이미지 사진")) {
      options.push({
        label: "이미지",
        detail: "파일에서 고르기",
        type: "keyword",
        boost: 5,
        apply: (view: EditorView, _c: Completion, f: number, to: number) => {
          // 먼저 `/이미지` 글자를 지우고 파일 선택을 연다 — 안 지우면
          // 업로드가 끝난 뒤 삽입될 때 그 글자가 그대로 남는다.
          view.dispatch({ changes: { from: f, to, insert: "" }, selection: { anchor: f } });
          act.attachImage?.();
        },
      });
    }
    if (act.createDocLink && extra("새 문서 만들어 링크", "문서를 만들고 [[링크]] 삽입", "new page doc 새문서 링크")) {
      options.push({
        label: "새 문서 만들어 링크",
        detail: "문서를 만들고 [[링크]] 삽입",
        type: "keyword",
        apply: (view: EditorView, _c: Completion, f: number, to: number) => {
          // 먼저 `/새 문서...` 글자를 지운다 — 안 지우면 링크와 함께 남는다.
          view.dispatch({ changes: { from: f, to, insert: "" }, selection: { anchor: f } });
          act.createDocLink?.(view, f);
        },
      });
    }

    if (!options.length) return null;
    return {
      from,
      options,
      // 기본 필터는 "/제목"을 라벨과 맞춰 보고 전부 떨어뜨린다 — 위에서 직접 걸렀다
      filter: false,
    };
  };
}
