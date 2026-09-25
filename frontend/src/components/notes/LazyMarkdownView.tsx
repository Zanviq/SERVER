import { Suspense, memo } from "react";
import { lazyChunk } from "../../lib/lazyChunk";
import type { MarkdownViewProps } from "./MarkdownView";

/**
 * 마크다운 렌더러(react-markdown + remark/rehype 체인)를 지연 로딩한다.
 * 노트 읽기 모드·AI 답변처럼 실제로 표시할 때만 필요한데, 정적 import면
 * 노트·캘린더·비서 세 화면 진입 시 항상 함께 받게 된다.
 */
const Inner = lazyChunk(() =>
  import("./MarkdownView").then((m) => ({ default: m.MarkdownView })),
);

/**
 * 받은 값이 그대로면 다시 그리지 않는다(memo). 마크다운 풀이는 비싸다 — 대화 화면은 입력칸에
 * 한 글자 칠 때마다 다시 그려지는데, 그때마다 보이는 말풍선 전부를 다시 풀었다(15차 실측:
 * 300차례 대화에서 한 글자에 중앙 170ms). 넘기는 쪽은 onWikiClick 같은 함수를 useCallback
 * 으로 고정해 두어야 이 덕을 본다.
 */
export const MarkdownView = memo(function MarkdownView(props: MarkdownViewProps) {
  return (
    <Suspense fallback={<div className="p-4 text-[13px] text-fg-muted">불러오는 중…</div>}>
      <Inner {...props} />
    </Suspense>
  );
});
