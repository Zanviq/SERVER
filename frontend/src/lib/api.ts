// 백엔드 API 클라이언트. 세션 쿠키 사용(credentials: include).

const BASE = import.meta.env.VITE_API_BASE ?? "";

export type Scope = "common" | "me";

export interface SessionInfo {
  username: string;
  display_name: string;
  expires_at: number;
  remaining: number;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
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

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
  // ── auth ──
  login: (username: string, password: string) =>
    req<SessionInfo>("/api/auth/login", jsonInit("POST", { username, password })),
  logout: () => req("/api/auth/logout", { method: "POST" }),
  session: () => req<SessionInfo>("/api/auth/session"),

  // ── system ──
  system: () => req<SystemStats>("/api/system"),
  health: () => req<{ ok: boolean }>("/api/health"),

  // ── files ──
  list: (scope: Scope, path = "") =>
    req<{ path: string; entries: FileEntry[] }>(`/api/files/list?${q({ scope, path })}`),
  mkdir: (scope: Scope, path: string) =>
    req(`/api/files/mkdir?${q({ scope })}`, jsonInit("POST", { path })),
  rename: (scope: Scope, src: string, dst: string) =>
    req(`/api/files/rename?${q({ scope })}`, jsonInit("POST", { src, dst })),
  remove: (scope: Scope, path: string) =>
    req(`/api/files/delete?${q({ scope, path })}`, { method: "DELETE" }),
  upload: (scope: Scope, path: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req(`/api/files/upload?${q({ scope, path })}`, { method: "POST", body: fd });
  },
  downloadUrl: (scope: Scope, path: string) =>
    `${BASE}/api/files/download?${q({ scope, path })}`,

  // ── notes ──
  noteList: (scope: Scope) =>
    req<NoteSummary[]>(`/api/notes/list?${q({ scope })}`),
  noteGet: (scope: Scope, path: string) =>
    req<NoteDetail>(`/api/notes/get?${q({ scope, path })}`),
  noteSave: (scope: Scope, path: string, content: string) =>
    req<NoteSummary>(`/api/notes/save?${q({ scope })}`, jsonInit("PUT", { path, content })),
  noteDelete: (scope: Scope, path: string) =>
    req(`/api/notes/delete?${q({ scope, path })}`, { method: "DELETE" }),
  noteGraph: (scope: Scope) =>
    req<NotesGraph>(`/api/notes/graph?${q({ scope })}`),

  // ── calendar ──
  calSource: () => req<{ source: string }>("/api/calendar/source"),
  calEvents: (from?: string, to?: string) => {
    const p: Record<string, string> = {};
    if (from) p.from = from;
    if (to) p.to = to;
    return req<CalEvent[]>(`/api/calendar/events?${q(p)}`);
  },
  calCreate: (e: Partial<CalEvent>) =>
    req<CalEvent>("/api/calendar/events", jsonInit("POST", e)),
  calUpdate: (id: string, e: Partial<CalEvent>) =>
    req<CalEvent>(`/api/calendar/events/${id}`, jsonInit("PUT", e)),
  calDelete: (id: string) =>
    req(`/api/calendar/events/${id}`, { method: "DELETE" }),

  // ── settings ──
  getSettings: () =>
    req<{ settings: UserSettings; defaults: UserSettings }>("/api/settings"),
  patchSettings: (changes: Record<string, unknown>) =>
    req<{ settings: UserSettings }>("/api/settings", jsonInit("PATCH", { changes })),

  // ── AI ──
  aiStatus: () => req<{ enabled: boolean; model: string }>("/api/ai/status"),
};

export interface AiEvent {
  type: "tool_call" | "tool_result" | "text" | "done" | "error";
  name?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  message?: string;
  text?: string;
}

/** AI 채팅 SSE 스트림. 이벤트마다 onEvent 호출. */
export async function aiChatStream(
  message: string,
  onEvent: (e: AiEvent) => void,
): Promise<void> {
  const res = await fetch(`${BASE}/api/ai/chat`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, "AI 요청 실패");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch {
        /* ignore */
      }
    }
  }
}

export interface UserSettings {
  ai: { tone: string; max_steps: number };
  calendar: { default_color: string; default_view: string; week_start: number };
  notes: { default_scope: string; autosave_ms: number };
  files: { default_scope: string; confirm_delete: boolean };
  display: { show_seconds_in_timer: boolean };
}

export interface CalEvent {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  color: string;
}

export interface NoteSummary {
  path: string;
  title: string;
  modified: number;
}
export interface NoteDetail {
  path: string;
  title: string;
  content: string;
  links: string[];
  backlinks: string[];
}
export interface NotesGraph {
  nodes: { id: string; title: string; path: string }[];
  links: { source: string; target: string }[];
}
