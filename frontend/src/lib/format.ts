export function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  const v = n / Math.pow(1024, i);
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 때(초 단위 유닉스 시각)를 `09.26 17:43` 으로 — **올해면 해를 뺀다**(다른 해면 `2025.09.26 17:43`).
 * 휴지통 줄에서 해까지 적으면 휴대폰 한 줄의 대부분을 먹어 앞의 설명(어디에 있던 무엇인지)이 잘렸다(디자인 5차).
 */
export function formatStamp(ts: number, now = new Date()): string {
  const d = new Date(ts * 1000);
  const day = `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.getFullYear() === now.getFullYear() ? day : `${d.getFullYear()}.${day}`;
}

/** 날짜 글(`2026-09-27`·`2026-09-27T10:00…`)을 formatStamp 와 같은 꼴로 — 올해면 해를 뺀다. 날짜가 아니면 빈 글. */
export function formatIsoDay(s: string | undefined | null, now = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(s ?? "");
  if (!m) return "";
  const day = `${m[2]}.${m[3]}${m[4] ? ` ${m[4]}` : ""}`;
  return Number(m[1]) === now.getFullYear() ? day : `${m[1]}.${day}`;
}
