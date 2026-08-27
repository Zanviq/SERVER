import { Suspense } from "react";
import { lazyChunk } from "../../lib/lazyChunk";
import { Loader2 } from "lucide-react";
// 타입만 가져오므로 번들이 딸려오지 않는다. 프롭을 여기서 다시 적으면
// 새 프롭이 조용히 누락돼도 타입 오류가 안 나므로 원본을 그대로 쓴다.
import type { LiveEditorProps } from "./LiveEditor";

/** CodeMirror6 번들(에디터)을 노트 초기 로딩에서 분리 — 노트를 실제로 열 때만 받는다. */
const Inner = lazyChunk(() =>
  import("./LiveEditor").then((m) => ({ default: m.LiveEditor })),
);

export function LiveEditor(props: LiveEditorProps) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-fg-muted">
          <Loader2 size={20} className="animate-spin" />
        </div>
      }
    >
      <Inner {...props} />
    </Suspense>
  );
}
