// 백엔드 FastAPI 클라이언트. 개발 시 Vite 프록시(/api -> :8000) 사용.

const BASE = import.meta.env.VITE_API_BASE ?? "";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

export interface ListResponse {
  path: string;
  entries: FileEntry[];
}

export interface SystemStats {
  cpu_percent: number;
  cpu_count: number;
  mem_total: number;
  mem_used: number;
  mem_percent: number;
  disk_total: number;
  disk_used: number;
  disk_percent: number;
  temperature_c: number | null;
  uptime_seconds: number;
  load_avg: number[] | null;
}

export interface SearchHit {
  path: string;
  reason: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ ok: boolean; storage_root: string }>("/api/health"),

  system: () => req<SystemStats>("/api/system"),

  list: (path = "") =>
    req<ListResponse>(`/api/files/list?path=${encodeURIComponent(path)}`),

  mkdir: (path: string) =>
    req("/api/files/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),

  rename: (src: string, dst: string) =>
    req("/api/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ src, dst }),
    }),

  remove: (path: string) =>
    req(`/api/files/delete?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),

  upload: (path: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req(`/api/files/upload?path=${encodeURIComponent(path)}`, {
      method: "POST",
      body: fd,
    });
  },

  downloadUrl: (path: string) =>
    `${BASE}/api/files/download?path=${encodeURIComponent(path)}`,

  summarize: (path: string) =>
    req<{ result: string }>("/api/ai/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),

  chat: (path: string, question: string) =>
    req<{ result: string }>("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, question }),
    }),

  search: (query: string) =>
    req<{ query: string; hits: SearchHit[] }>("/api/ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),
};
