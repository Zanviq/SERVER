import { RotateCcw } from "lucide-react";

/**
 * 목록이 비었을 때 한 줄.
 *
 * **못 불러온 것과 비어 있는 것은 다르다.** 실패를 "없습니다"로 보여 주면
 * 사용자는 데이터가 사라진 줄 안다(토스트는 몇 초 뒤 사라지고 거짓말만 남는다).
 * 이 저장소가 노트 검색에서 이미 내린 결론을 목록 화면에도 같은 모양으로 쓴다.
 */
export function ListState({
  failed,
  onRetry,
  children,
  className = "",
}: {
  failed?: boolean;
  onRetry?: () => void;
  children: React.ReactNode;   // 비어 있을 때 할 말
  className?: string;
}) {
  if (!failed) {
    return <p className={`px-3 py-8 text-center text-[12.5px] text-fg-muted ${className}`}>{children}</p>;
  }
  return (
    <p className={`flex flex-col items-center gap-2 px-3 py-8 text-center text-[12.5px] text-danger ${className}`}>
      불러오지 못했습니다
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn btn-ghost h-7 gap-1 px-2 text-[12px]">
          <RotateCcw size={12} /> 다시 시도
        </button>
      )}
    </p>
  );
}
