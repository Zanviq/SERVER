// File System Access API 헬퍼 (Chromium 계열 전용).
// 타입이 표준 lib.dom에 일부만 있어 핸들은 any로 다룬다.

export const fsSupported = (): boolean =>
  typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
  "function";

export async function pickDirectory(): Promise<any> {
  return (window as any).showDirectoryPicker({ mode: "readwrite" });
}

/** 권한 상태 조회 ('granted' 이면 재요청 없이 사용 가능). */
export async function queryPerm(handle: any, write = true): Promise<string> {
  try {
    return await handle.queryPermission({ mode: write ? "readwrite" : "read" });
  } catch {
    return "denied";
  }
}

/** 사용자 제스처 안에서 권한 재요청 (true=허용). */
export async function requestPerm(handle: any, write = true): Promise<boolean> {
  try {
    return (await handle.requestPermission({ mode: write ? "readwrite" : "read" })) === "granted";
  } catch {
    return false;
  }
}

export interface LocalFile {
  rel: string;
  handle: any; // FileSystemFileHandle
}

/** 디렉토리 재귀 순회 → 파일 목록(상대경로). */
export async function walk(dir: any, prefix = ""): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith(".")) continue; // 숨김/시스템 파일 건너뜀
    const rel = prefix ? `${prefix}/${name}` : name;
    if (h.kind === "file") out.push({ rel, handle: h });
    else if (h.kind === "directory") out.push(...(await walk(h, rel)));
  }
  return out;
}

export async function readBuf(fileHandle: any): Promise<ArrayBuffer> {
  const file: File = await fileHandle.getFile();
  return file.arrayBuffer();
}

/** 로컬에 파일 기록 (중간 폴더 자동 생성). */
export async function writeLocal(dir: any, rel: string, data: ArrayBuffer): Promise<void> {
  const parts = rel.split("/");
  let cur = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = await cur.getDirectoryHandle(parts[i], { create: true });
  }
  const fh = await cur.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

export async function sha256(data: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TEXT_EXT = new Set([
  "md", "txt", "json", "csv", "log", "yaml", "yml", "xml", "html", "css",
  "js", "ts", "tsx", "jsx", "py", "java", "c", "cpp", "h", "sh", "ini", "toml", "env",
]);

export function isTextFile(rel: string): boolean {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXT.has(ext);
}

/** 줄 기반 2-way 병합: 공통 머리/꼬리는 공유, 변경부는 로컬 위 + 웹 아래. */
export function mergeLines(local: string, web: string): string {
  const a = local.split("\n");
  const b = web.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (
    s < a.length - p &&
    s < b.length - p &&
    a[a.length - 1 - s] === b[b.length - 1 - s]
  )
    s++;
  const prefix = a.slice(0, p);
  const localMid = a.slice(p, a.length - s);
  const webMid = b.slice(p, b.length - s);
  const suffix = a.slice(a.length - s);
  return [...prefix, ...localMid, ...webMid, ...suffix].join("\n");
}
