import { ReactNode } from "react";

/**
 * 강조색 바탕의 내 말풍선 — 안에 마크다운(MarkdownView)을 그린다.
 *
 * md-on-accent 가 있어야 제목·표·인용·코드·링크 칩이 보라 바탕에 묻히지 않는다(index.css 의
 * `.md-on-accent` 규칙들 — 표 제목·글머리·코드 칠이 차례로 바탕과 같은 색이 되어 보이지 않았던
 * 것을 하나씩 고친 자리다). 채팅·대화 기록이 말풍선을 따로 적으면 새 말풍선이 그 클래스를 빠뜨린다.
 * 크기·안쪽 여백만 부르는 쪽이 정한다.
 */
export function AccentBubble({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`md-on-accent max-w-[80%] rounded-lg rounded-br-sm bg-accent text-accent-contrast ${className}`}>
      {children}
    </div>
  );
}
