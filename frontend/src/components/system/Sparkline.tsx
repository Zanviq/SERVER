interface SparklineProps {
  data: number[];
  color?: string;
  height?: number;
  max?: number;
}

/** 의존성 없는 SVG 스파크라인 (면적 + 라인). */
export function Sparkline({
  data,
  color = "#c6f432",
  height = 40,
  max = 100,
}: SparklineProps) {
  const w = 100; // viewBox 폭 (퍼센트 스케일)
  if (data.length < 2) {
    return <svg viewBox={`0 0 ${w} ${height}`} className="w-full" />;
  }
  const step = w / (data.length - 1);
  const pts = data.map((d, i) => {
    const x = i * step;
    const y = height - (Math.max(0, Math.min(max, d)) / max) * height;
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `0,${height} ${line} ${w},${height}`;
  const gid = `sp-${color.replace("#", "")}`;

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
