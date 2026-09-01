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
  /** 새 문서를 만들고 그 제목을 돌려준다(취소하면 null) */
  createDoc?: () => Promise<string | null>;
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
  {
    label: "표",
    detail: "3열 표",
    // 머리글 첫 칸에 커서를 둔다 — 넣자마자 바로 항목 이름을 칠 수 있게
    text: `| ${CURSOR} |  |  |\n| --- | --- | --- |\n|  |  |  |\n`,
    keywords: "table 표 테이블",
    boost: 6,
  },
  {
    label: "코드 블록",
    detail: "``` 코드 ```",
    text: `\`\`\`\n${CURSOR}\n\`\`\``,
    keywords: "code block 코드",
  },
  { label: "구분선", detail: "가로줄", text: `---\n${CURSOR}`, keywords: "hr divider 구분선" },
  { label: "형광펜", detail: "==강조==", text: `==${CURSOR}==`, keywords: "highlight mark 형광펜 강조" },
  { label: "문서 링크", detail: "[[다른 문서]]", text: `[[${CURSOR}`, keywords: "link wiki 링크 문서" },
];

/** CURSOR 자리에 커서를 두도록 텍스트와 커서 오프셋으로 나눈다. */
function place(text: string): { body: string; cursor: number } {
  const at = text.indexOf(CURSOR);
  if (at < 0) return { body: text, cursor: text.length };
  return { body: text.slice(0, at) + text.slice(at + CURSOR.length), cursor: at };
}

/** 라벨·설명·검색어 중 아무 데나 걸리면 후보로 둔다(한글 라벨 + 영문 키워드). */
function matches(sn: Snippet, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    sn.label.toLowerCase().includes(q) ||
    sn.detail.toLowerCase().includes(q) ||
    (sn.keywords ?? "").toLowerCase().includes(q)
  );
}

export function makeSlashSource(actions: () => SlashActions) {
  return (ctx: CompletionContext): CompletionResult | null => {
    // 줄 시작 또는 목록 기호 뒤의 `/` 만 인정한다
    const before = ctx.matchBefore(/(^|\n)[\s>*\-+]*\/([^\s/]*)$/);
    if (!before) return null;
    const slash = before.text.lastIndexOf("/");
    const from = before.from + slash;
    // `/` 부터가 교체 범위다. 그러면 CM6의 기본 필터가 "/제목"을 라벨과 맞춰 보고
    // 전부 떨어뜨리므로(라벨에 "/"가 없다), 거르기는 우리가 직접 한다.
    const query = before.text.slice(slash + 1);

    const apply = (snippet: Snippet) => (view: EditorView, _c: Completion, f: number, to: number) => {
      const { body, cursor } = place(snippet.text);
      view.dispatch({
        changes: { from: f, to, insert: body },
        selection: { anchor: f + cursor },
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
    if (act.createDoc && extra("새 문서 만들어 링크", "문서를 만들고 [[링크]] 삽입", "new page doc 새문서 링크")) {
      options.push({
        label: "새 문서 만들어 링크",
        detail: "문서를 만들고 [[링크]] 삽입",
        type: "keyword",
        apply: (view: EditorView, _c: Completion, f: number, to: number) => {
          view.dispatch({ changes: { from: f, to, insert: "" }, selection: { anchor: f } });
          act.createDoc?.().then((title) => {
            if (!title) return;
            const at = Math.min(view.state.selection.main.head, view.state.doc.length);
            const insert = `[[${title}]]`;
            view.dispatch({
              changes: { from: at, insert },
              selection: { anchor: at + insert.length },
            });
            view.focus();
          });
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
