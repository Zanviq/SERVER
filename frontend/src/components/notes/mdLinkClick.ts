import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { docLinkTarget } from "../../lib/embeds";
import { hrefSection } from "../../lib/headings";

/**
 * pos 가 든 표준 링크(`[글](대상)`)의 대상 — 적힌 그대로(꺾쇠 `<내 문서.md>` 는 벗긴다). 링크가 아니면 null.
 * 그림(`![](…)`)은 링크로 열지 않는다. 구문 나무로 보므로 코드 안의 `[글](대상)` 은 링크가 아니다.
 * 참조식 `[글][이름]`·`[이름][]`·`[이름]` 은 정의 `[이름]: 대상` 의 대상이다(읽기 보기도 그렇게 그린다).
 */
export function linkUrlAt(state: EditorState, pos: number): string | null {
  for (const side of [1, -1] as const) {
    for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent!) {
      if (n.name === "Image") return null;
      if (n.name === "Link") {
        const u = n.getChild("URL");
        return u ? unwrap(state.doc.sliceString(u.from, u.to)) : referenceUrl(state, n);
      }
      if (!n.parent) break;
    }
  }
  return null;
}

const unwrap = (url: string) => url.replace(/^<(.*)>$/, "$1");
/** 참조 이름 맞대기 — 대소문자·띄어쓰기 차이는 같은 이름이다(CommonMark, 서버 notes_graph._label 과 같다). */
const label = (s: string) => s.replace(/^\[|\]$/g, "").trim().replace(/\s+/g, " ").toLowerCase();

/** 주소 없는 링크(참조식)의 대상 — 이름이 같은 첫 정의. 정의가 없으면(`[note/…]` 항목 링크 등) null. */
function referenceUrl(state: EditorState, link: SyntaxNode): string | null {
  const lab = link.getChild("LinkLabel");
  const marks = link.getChildren("LinkMark");
  // `[글][이름]` 은 이름 칸, `[이름][]`·`[이름]` 은 글 자체가 이름
  let name = lab ? label(state.doc.sliceString(lab.from, lab.to)) : "";
  if (!name && marks.length >= 2) name = label(state.doc.sliceString(marks[0].to, marks[1].from));
  if (!name) return null;
  let found: string | null = null;
  // 정의는 문서 끝에 모아 두기 흔하다 — 아직 안 풀린 뒤쪽까지 나무를 풀어 본다
  (ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state)).iterate({
    enter(n) {
      if (found !== null) return false;
      if (n.name !== "LinkReference") return undefined;
      const l = n.node.getChild("LinkLabel");
      const u = n.node.getChild("URL");
      if (l && u && label(state.doc.sliceString(l.from, l.to)) === name) found = unwrap(state.doc.sliceString(u.from, u.to));
      return false;
    },
  });
  return found;
}

/**
 * 표준 링크 Ctrl(⌘)+클릭(79차) — 전엔 아무 일도 없었다(편집기가 여는 링크는 `[[제목]]`·`[note/…]` 뿐이었다).
 * 벌트 안 문서면 openDoc(대상 — 읽기 보기와 같은 lib/embeds.docLinkTarget 기준, `#섹션` 은 따로), 같은 문서 안
 * 제목(`[차례](#설치-방법)`)이면 openDoc("", 섹션), 웹 주소면 새 탭.
 * openDoc 이 false 를 돌려주면(문서를 열 자리가 없는 편집기) 가로채지 않는다.
 */
export function mdLinkClick(openDoc: (target: string, section: string | null) => boolean) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const url = linkUrlAt(view.state, pos);
      if (!url) return false;
      const doc = docLinkTarget(url);
      const section = hrefSection(url);
      if (doc !== null) {
        if (!openDoc(doc, section)) return false;
      } else if (url.startsWith("#") && section) {
        if (!openDoc("", section)) return false;
      } else if (/^(https?:|mailto:)/i.test(url)) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        return false;
      }
      e.preventDefault();
      return true;
    },
  });
}
