// 백엔드 API 클라이언트. 세션 쿠키 사용(credentials: include).

const BASE = import.meta.env.VITE_API_BASE ?? "";

export type Scope = "common" | "me" | "notes";
export type NoteBase = "notes" | "files";

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
  // 문자열 detail 또는 구조화된 오류({error,message,...}) 원본. 409 충돌 등에서 사용.
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail ?? message;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    let detail: unknown = `${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail ?? body;
    } catch {
      /* ignore */
    }
    const msg =
      typeof detail === "string"
        ? detail
        : (detail as { message?: string })?.message ?? `${res.status}`;
    throw new ApiError(res.status, msg, detail);
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

  // ── notes ── (base="notes": 노트 폴더 / base="files": 파일 저장소의 .md 편집)
  noteList: (scope: Scope, base: NoteBase = "notes") =>
    req<NoteSummary[]>(`/api/notes/list?${q({ scope, base })}`),
  noteGet: (scope: Scope, path: string, base: NoteBase = "notes") =>
    req<NoteDetail>(`/api/notes/get?${q({ scope, path, base })}`),
  noteSave: (scope: Scope, path: string, content: string, base: NoteBase = "notes") =>
    req<NoteSummary>(`/api/notes/save?${q({ scope, base })}`, jsonInit("PUT", { path, content })),
  noteDelete: (scope: Scope, path: string, base: NoteBase = "notes") =>
    req(`/api/notes/delete?${q({ scope, path, base })}`, { method: "DELETE" }),
  noteGraph: (scope: Scope, folder = "", mode: "links" | "folders" = "links", base: NoteBase = "notes") =>
    req<NotesGraph>(`/api/notes/graph?${q({ scope, folder, mode, base })}`),
  noteSearch: (scope: Scope, query: string, base: NoteBase = "notes") =>
    req<NoteSearchHit[]>(`/api/notes/search?${q({ scope, q: query, base })}`),
  noteTree: (scope: Scope, base: NoteBase = "notes") =>
    req<NotesTree>(`/api/notes/tree?${q({ scope, base })}`),
  noteFolderCreate: (scope: Scope, path: string, base: NoteBase = "notes") =>
    req(`/api/notes/folder?${q({ scope, base })}`, jsonInit("POST", { path })),
  noteFolderDelete: (scope: Scope, path: string, base: NoteBase = "notes") =>
    req(`/api/notes/folder?${q({ scope, path, base })}`, { method: "DELETE" }),

  // ── 휴지통 ──
  trashList: () => req<TrashEntry[]>("/api/trash/list"),
  trashRestore: (id: string) =>
    req(`/api/trash/restore?${q({ id })}`, { method: "POST" }),
  trashPurge: (id: string) => req(`/api/trash/purge?${q({ id })}`, { method: "DELETE" }),
  trashEmpty: () => req("/api/trash/empty", { method: "DELETE" }),

  // ── 로컬 연동(sync) ──
  syncManifest: (scope: Scope, path: string) =>
    req<SyncManifest>(`/api/sync/manifest?${q({ scope, path })}`),
  syncUpload: (scope: Scope, path: string, rel: string, data: ArrayBuffer | Uint8Array) =>
    req<{ ok: boolean; rel: string; hash: string }>(
      `/api/sync/upload?${q({ scope, path, rel })}`,
      { method: "POST", body: data as BodyInit },
    ),
  syncDownloadUrl: (scope: Scope, path: string, rel: string) =>
    `${BASE}/api/sync/download?${q({ scope, path, rel })}`,

  // ── 터미널 ──
  terminalStatus: () =>
    req<{ enabled: boolean; is_admin: boolean; available: boolean }>("/api/terminal/status"),

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
    req(`/api/calendar/events/${encodeURIComponent(id)}`, { method: "DELETE" }),
  calReminders: (within = 1440) =>
    req<CalEvent[]>(`/api/calendar/reminders?within=${within}`),

  // ── settings ──
  getSettings: () =>
    req<{ settings: UserSettings; defaults: UserSettings }>("/api/settings"),
  patchSettings: (changes: Record<string, unknown>) =>
    req<{ settings: UserSettings }>("/api/settings", jsonInit("PATCH", { changes })),

  // ── AI ──
  aiStatus: () => req<{ enabled: boolean; model: string }>("/api/ai/status"),

  // ── AI 문서(aidoc) ── 세션(웹) 경로. 문서 API 경유(버전·감사·낙관적 잠금).
  aidocList: (opts?: { project?: string; include_trashed?: boolean }) => {
    const p: Record<string, string> = {};
    if (opts?.project) p.project = opts.project;
    if (opts?.include_trashed) p.include_trashed = "true";
    return req<AidocMeta[]>(`/api/aidoc/documents?${q(p)}`);
  },
  aidocGet: (id: string) => req<AidocDetail>(`/api/aidoc/documents/${id}`),
  aidocSearch: (query: string) =>
    req<AidocSearchHit[]>(`/api/aidoc/documents/search?${q({ q: query })}`),
  aidocCreate: (body: { title: string; content?: string; project?: string | null; tags?: string[]; folder?: string | null }) =>
    req<AidocDetail>("/api/aidoc/documents", jsonInit("POST", body)),
  aidocFolders: (project?: string) => {
    const p: Record<string, string> = {};
    if (project) p.project = project;
    return req<string[]>(`/api/aidoc/folders?${q(p)}`);
  },
  aidocCreateFolder: (body: { project?: string | null; path: string }) =>
    req<{ folder: string }>("/api/aidoc/folders", jsonInit("POST", body)),
  aidocUpdate: (
    id: string,
    body: { expected_version: number; content?: string; title?: string; change_summary?: string },
  ) => req<AidocDetail>(`/api/aidoc/documents/${id}`, jsonInit("PUT", body)),
  aidocMove: (id: string, body: { target_project?: string | null; target_folder?: string | null }) =>
    req<AidocDetail>(`/api/aidoc/documents/${id}/move`, jsonInit("POST", body)),
  aidocTrash: (id: string) => req<AidocMeta>(`/api/aidoc/documents/${id}/trash`, { method: "POST" }),
  aidocRestore: (id: string, version?: number | null) =>
    req<AidocMeta>(`/api/aidoc/documents/${id}/restore`, jsonInit("POST", { version: version ?? null })),
  aidocHistory: (id: string) => req<AidocVersion[]>(`/api/aidoc/documents/${id}/history`),
  aidocProjects: () => req<string[]>("/api/aidoc/projects"),
  aidocAudit: () => req<AidocAuditLog[]>("/api/aidoc/audit-logs"),
  aidocSemantic: (query: string, project?: string, limit = 10) => {
    const p: Record<string, string> = { q: query, limit: String(limit) };
    if (project) p.project = project;
    return req<AidocSearchHit[]>(`/api/aidoc/documents/semantic-search?${q(p)}`);
  },
  aidocGraph: (project?: string) => {
    const p: Record<string, string> = {};
    if (project) p.project = project;
    return req<AidocGraph>(`/api/aidoc/graph?${q(p)}`);
  },
};

export interface AiEvent {
  type: "tool_call" | "tool_result" | "text" | "done" | "error";
  name?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  message?: string;
  text?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** AI 채팅 SSE 스트림. history로 이전 대화(멀티턴) 전달. */
export async function aiChatStream(
  message: string,
  history: ChatTurn[],
  onEvent: (e: AiEvent) => void,
): Promise<void> {
  const res = await fetch(`${BASE}/api/ai/chat`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
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
  calendar: { default_color: string; default_view: string; week_start: number; default_remind: number; ai_rules: string };
  notes: { default_scope: string; autosave_ms: number };
  files: { default_scope: string; confirm_delete: boolean };
  sync: { text_conflict: string; binary_policy: string };
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
  recurrence?: string;
  interval?: number;
  recur_until?: string;
  remind_minutes?: number;
  remind_at?: string;
  is_recurring?: boolean;
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
  nodes: { id: string; title: string; path: string; type?: string; count?: number }[];
  links: { source: string; target: string }[];
}
export interface NotesTree {
  folders: string[];
  notes: NoteSummary[];
}
export interface TrashEntry {
  id: string;
  kind: string;
  scope: string;
  orig_rel: string;
  name: string;
  is_dir: boolean;
  deleted_at: number;
}
export interface SyncManifest {
  scope: string;
  path: string;
  files: { rel: string; size: number; mtime: number; hash: string }[];
}
export interface NoteSearchHit {
  path: string;
  title: string;
  snippet: string;
}

// ── AI 문서(aidoc) ──
export interface AidocMeta {
  id: string;
  title: string;
  project: string | null;
  category: string | null;
  tags: string[];
  status: string;
  version: number;
  storage_path?: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  trashed: boolean;
}
export interface AidocDetail extends AidocMeta {
  content: string;
}
export interface AidocSearchHit extends AidocMeta {
  snippet: string;
}
export interface AidocVersion {
  doc_id: string;
  version: number;
  actor: string | null;
  change_summary: string | null;
  prev_hash: string | null;
  new_hash: string | null;
  history_path: string | null;
  created_at: string;
}
export interface AidocAuditLog {
  id: number;
  actor: string | null;
  action: string;
  doc_id: string | null;
  project: string | null;
  from_version: number | null;
  to_version: number | null;
  change_summary: string | null;
  ok: number;
  detail: string | null;
  timestamp: string;
}
export interface AidocConflict {
  error: string;
  message: string;
  expected_version: number;
  current_version: number;
}
export interface AidocGraphNode {
  id: string;
  title: string;
  project: string | null;
  tags: string[];
  version: number;
}
export interface AidocGraphLink {
  source: string;
  target: string;
  weight: number;
  kind: "similar" | "link";
}
export interface AidocGraph {
  nodes: AidocGraphNode[];
  links: AidocGraphLink[];
}
