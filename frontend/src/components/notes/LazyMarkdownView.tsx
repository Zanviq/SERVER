import { lazy, Suspense } from "react";
import type { MarkdownViewProps } from "./MarkdownView";

/**
 * 마크다운 렌더러(react-markdown + remark/rehype 체인)를 지연 로딩한다.
 * 노트 읽기 모드·AI 답변처럼 실제로 표시할 때만 필요한데, 정적 import면
 * 노트·캘린더·비서 세 화면 진입 시 항상 함께 받게 된다.
 */
const Inner = lazy(() =>
  import("./MarkdownView").then((m) => ({ default: m.MarkdownView })),
);

export function MarkdownView(props: MarkdownViewProps) {
  return (
    <Suspense fallback={<div className="p-4 text-[13px] text-fg-muted">불러오는 중…</div>}>
      <Inner {...props} />
    </Suspense>
  );
}
