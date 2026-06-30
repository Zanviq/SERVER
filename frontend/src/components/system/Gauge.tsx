interface GaugeProps {
  value: number; // 0-100
  label: string;
  sub?: string;
  /** 최대 픽셀 크기. 좁은 컨테이너에선 자동 축소된다. */
  max?: number;
}

/** 270도 아크 라디얼 게이지. 컨테이너 폭에 맞춰 유동 스케일. */
export function Gauge({ value, label, sub, max = 132 }: GaugeProps) {
  const v = Math.max(0, Math.min(100, value));
  const VB = 132; // 내부 좌표계 (viewBox)
  const stroke = 9;
  const r = (VB - stroke) / 2;
  const c = VB / 2;
  const arc = 270;
  const circ = 2 * Math.PI * r;
  const dash = (arc / 360) * circ;
  const offset = dash - (v / 100) * dash;

  const color = v >= 85 ? "#ff5d5d" : v >= 65 ? "#ffb84d" : "#c6f432";

  return (
    <div className="flex w-full flex-col items-center">
      <div
        className="relative aspect-square w-full"
        style={{ maxWidth: max, containerType: "inline-size" }}
      >
        <svg
          viewBox={`0 0 ${VB} ${VB}`}
          className="h-full w-full"
          style={{ transform: "rotate(135deg)" }}
        >
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={stroke}
            strokeDasharray={`${dash} ${circ}`}
            strokeLinecap="round"
          />
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={`${dash} ${circ}`}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{
              transition:
                "stroke-dashoffset 0.7s cubic-bezier(0.16,1,0.3,1), stroke 0.4s",
              filter: `drop-shadow(0 0 6px ${color}55)`,
            }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="font-mono font-semibold leading-none tabular-nums"
            style={{ color, fontSize: "clamp(1.1rem, 14cqi, 1.55rem)" }}
          >
            {Math.round(v)}
            <span className="text-[0.6em] text-ash-500">%</span>
          </span>
          {sub && (
            <span className="mt-0.5 font-mono text-[0.62rem] text-ash-500">{sub}</span>
          )}
        </div>
      </div>
      <span className="label-mono mt-1.5">{label}</span>
    </div>
  );
}
