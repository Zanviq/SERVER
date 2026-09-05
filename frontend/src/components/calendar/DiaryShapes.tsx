import type { DiaryAxis, DiaryShape } from "../../lib/api";

/** 상태 도형 — 좋은 순서. 캘린더 칸과 기록 패널이 같은 그림을 쓴다. */
export const SHAPES: Exclude<DiaryShape, "">[] = ["star", "circle", "triangle", "square", "pentagon"];

export const SHAPE_LABEL: Record<Exclude<DiaryShape, "">, string> = {
  star: "매우 좋음",
  circle: "좋음",
  triangle: "보통",
  square: "힘듦",
  pentagon: "매우 힘듦",
};

export const AXES: DiaryAxis[] = ["body", "heart", "mind"];
export const AXIS_LABEL: Record<DiaryAxis, string> = { body: "육체", heart: "마음", mind: "정신" };

// 정오각형/별은 (12,12) 중심 반지름 10 의 꼭짓점. 색은 currentColor 라 부모가 정한다.
const PENTAGON = "12,2 21.51,8.91 17.88,20.09 6.12,20.09 2.49,8.91";
const STAR =
  "12,2 14.65,8.36 21.51,8.91 16.28,13.39 17.88,20.09 12,16.5 6.12,20.09 7.72,13.39 2.49,8.91 9.35,8.36";

interface IconProps {
  shape: DiaryShape;
  size?: number;
  className?: string;
}

/** 도형 하나. shape 가 비어 있으면 '표시 안 함'을 뜻하는 짧은 선(-)을 그린다. */
export function ShapeIcon({ shape, size = 14, className = "" }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    className,
    "aria-hidden": true,
    focusable: false,
  } as const;
  switch (shape) {
    case "star":
      return <svg {...common}><polygon points={STAR} fill="currentColor" /></svg>;
    case "circle":
      return <svg {...common}><circle cx="12" cy="12" r="9.5" fill="currentColor" /></svg>;
    case "triangle":
      return <svg {...common}><polygon points="12,3 21.5,20 2.5,20" fill="currentColor" /></svg>;
    case "square":
      return <svg {...common}><rect x="3.5" y="3.5" width="17" height="17" rx="1.5" fill="currentColor" /></svg>;
    case "pentagon":
      return <svg {...common}><polygon points={PENTAGON} fill="currentColor" /></svg>;
    default:
      // 글자 "-" 는 좁은 화면 규칙(font-size:0)에 지워지므로 선으로 그린다.
      return (
        <svg {...common}>
          <line x1="6" y1="12" x2="18" y2="12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      );
  }
}

/** 캘린더 칸에 들어가는 한 줄: 육체 · 마음 · 정신. 고른 게 하나도 없으면 아무것도 안 그린다. */
export function DiaryCell({
  body, heart, mind, hasText, size = 13,
}: { body: DiaryShape; heart: DiaryShape; mind: DiaryShape; hasText: boolean; size?: number }) {
  if (!body && !heart && !mind) {
    // 도형은 없고 일기만 있는 날 — 있다는 것만 아주 작게 알린다.
    return hasText ? <span className="fc-diary-dot" aria-label="일기 있음" /> : null;
  }
  return (
    <span className="fc-diary-row" title={`육체 ${label(body)} · 마음 ${label(heart)} · 정신 ${label(mind)}`}>
      <ShapeIcon shape={body} size={size} />
      <ShapeIcon shape={heart} size={size} />
      <ShapeIcon shape={mind} size={size} />
    </span>
  );
}

function label(s: DiaryShape): string {
  return s ? SHAPE_LABEL[s] : "-";
}
