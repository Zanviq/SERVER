import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { docLinkTarget } from "../../lib/embeds";

/**
 * pos 가 든 표준 링크(`[글](대상)`)의 대상 — 적힌 그대로(꺾쇠 `<내 문서.md>` 는 벗긴다). 링크가 아니면 null.
 * 그림(`![](…)`)은 링크로 열지 않는다. 구문 나무로 보므로 코드 안의 `[글](대상)` 은 링크가 아니다.
 */
export function linkUrlAt(state: EditorState, pos: number): string | null {
  for (const side of [1, -1] as const) {
    for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent!) {
      if (n.name === "Image") return null;
      if (n.name === "Link") {
        const u = n.getChild("URL");
        return u ? state.doc.sliceString(u.from, u.to).replace(/^<(.*)>$/, "$1") : null;
      }
      if (!n.parent) break;
    }
  }
  return null;
}

/**
 * 표준 링크 Ctrl(⌘)+클릭(79차) — 전엔 아무 일도 없었다(편집기가 여는 링크는 `[[제목]]`·`[note/…]` 뿐이었다).
 * 벌트 안 문서면 openDoc(대상 — 읽기 보기와 같은 lib/embeds.docLinkTarget 기준), 웹 주소면 새 탭.
 * openDoc 이 false 를 돌려주면(문서를 열 자리가 없는 편집기) 가로채지 않는다.
 */
export function mdLinkClick(openDoc: (target: string) => boolean) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const url = linkUrlAt(view.state, pos);
      if (!url) return false;
      const doc = docLinkTarget(url);
      if (doc !== null) {
        if (!openDoc(doc)) return false;
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
