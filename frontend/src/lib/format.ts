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

export function formatTime(epoch: number): string {
  const d = new Date(epoch * 1000);
  return d.toLocaleString("ko-KR", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const EXT_KIND: Record<string, string> = {
  txt: "doc", md: "doc", pdf: "doc", doc: "doc", docx: "doc",
  png: "img", jpg: "img", jpeg: "img", gif: "img", webp: "img", svg: "img",
  mp4: "vid", mov: "vid", mkv: "vid", webm: "vid",
  mp3: "aud", wav: "aud", flac: "aud",
  zip: "arc", tar: "arc", gz: "arc", "7z": "arc", rar: "arc",
  py: "code", js: "code", ts: "code", tsx: "code", json: "code",
  html: "code", css: "code", sh: "code", c: "code", cpp: "code",
};

export function fileKind(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? "file";
}

const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "py", "js", "ts", "tsx", "jsx", "json",
  "yaml", "yml", "toml", "ini", "cfg", "csv", "log", "html", "css",
  "xml", "sh", "c", "cpp", "h", "java", "go", "rs", "sql", "env",
]);

export function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTS.has(ext);
}
