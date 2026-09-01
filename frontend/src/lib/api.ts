// 백엔드 API 클라이언트. 세션 쿠키 사용(credentials: include).

const BASE = import.meta.env.VITE_API_BASE ?? "";


export interface SessionInfo {
  username: string;
  display_name: string;
  expires_at: number;
  remaining: number;
  role: "admin" | "user";
  /** bootstrap = .env로 만들어진 서버 주인. 관리 화면·Google 연동 전용 판정에 쓴다. */
  origin: "bootstrap" | "signup";
}

export interface GoogleStatus {
  server_ready: boolean;
  owner_only?: boolean;
  connected: boolean;
  via: "oauth" | "env" | null;
  email: string;
  calendar_id: string;
  connected_at: number | null;
}

export interface AdminUser {
  username: string;
  display_name: string;
  role: "admin" | "user";
  origin: "bootstrap" | "signup";
  status: "pending" | "active" | "rejected" | "disabled";
  created_at: number;
  approved_at: number | null;
  approved_by: string | null;
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
  signup: (username: string, password: string, display_name: string) =>
    req<{ ok: boolean; status: string; message: string }>(
      "/api/auth/signup",
      jsonInit("POST", { username, password, display_name }),
    ),

  // ── Google 연동 ──
  googleStatus: () => req<GoogleStatus>("/api/google/status"),
  googleAuthUrl: () => req<{ url: string }>("/api/google/auth-url"),
  googleDisconnect: () => req("/api/google/disconnect", { method: "POST" }),

  // ── 관리자(계정 승인) ──
  adminUsers: () =>
    req<{ pending: AdminUser[]; users: AdminUser[] }>("/api/admin/users"),
  adminApprove: (username: string) =>
    req<AdminUser>(`/api/admin/users/${encodeURIComponent(username)}/approve`, { method: "POST" }),
  adminReject: (username: string) =>
    req<AdminUser>(`/api/admin/users/${encodeURIComponent(username)}/reject`, { method: "POST" }),
  adminDisable: (username: string) =>
    req<AdminUser>(`/api/admin/users/${encodeURIComponent(username)}/disable`, { method: "POST" }),
  adminDelete: (username: string) =>
    req(`/api/admin/users/${encodeURIComponent(username)}`, { method: "DELETE" }),
  session: () => req<SessionInfo>("/api/auth/session"),

  // ── system ──
  system: () => req<SystemStats>("/api/system"),
  health: () => req<{ ok: boolean }>("/api/health"),

  // ── 문서(파일·노트 통합) ──
  // 저장 공간은 사용자당 하나뿐이라 scope/base 인자가 없다.
  noteList: () => req<NoteSummary[]>("/api/notes/list"),
  noteGet: (path: string) => req<NoteDetail>(`/api/notes/get?${q({ path })}`),
  noteSave: (path: string, content: string) =>
    req<NoteSummary>("/api/notes/save", jsonInit("PUT", { path, content })),
  noteDelete: (path: string) =>
    req(`/api/notes/delete?${q({ path })}`, { method: "DELETE" }),
  noteRename: (path: string, new_name: string) =>
    req<NoteSummary>("/api/notes/rename", jsonInit("POST", { path, new_name })),
  noteMove: (path: string, target_folder: string) =>
    req<NoteSummary>("/api/notes/move", jsonInit("POST", { path, target_folder })),
  noteGraph: (folder = "", mode: "links" | "folders" = "links") =>
    req<NotesGraph>(`/api/notes/graph?${q({ folder, mode })}`),
  noteSearch: (query: string) =>
    req<NoteSearchHit[]>(`/api/notes/search?${q({ q: query })}`),
  noteTree: () => req<NotesTree>("/api/notes/tree"),
  noteFolderCreate: (path: string) =>
    req("/api/notes/folder", jsonInit("POST", { path })),
  noteFolderDelete: (path: string) =>
    req(`/api/notes/folder?${q({ path })}`, { method: "DELETE" }),
  noteUpload: (path: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<NoteSummary>(`/api/notes/upload?${q({ path })}`, { method: "POST", body: fd });
  },
  /** 원본 바이트 URL — 이미지·PDF·미디어는 인라인, download=true면 첨부 */
  noteRawUrl: (path: string, download = false) =>
    `${BASE}/api/notes/raw?${q({ path, ...(download ? { download: "true" } : {}) })}`,

  // ── 휴지통 ──
  trashList: (kind = "") => req<TrashEntry[]>(`/api/trash/list?${q({ kind })}`),
  trashCounts: () => req<Record<string, number>>("/api/trash/counts"),
  trashRestore: (id: string) =>
    req(`/api/trash/restore?${q({ id })}`, { method: "POST" }),
  trashPurge: (id: string) => req(`/api/trash/purge?${q({ id })}`, { method: "DELETE" }),
  trashEmpty: () => req("/api/trash/empty", { method: "DELETE" }),

  // ── 할 일 ──
  todoCategories: () => req<TodoCategory[]>("/api/todo/categories"),
  todoCategoryCreate: (body: { name: string; color?: string; parent_id?: string }) =>
    req<TodoCategory>("/api/todo/categories", jsonInit("POST", body)),
  todoCategoryUpdate: (id: string, body: Partial<TodoCategory>) =>
    req<TodoCategory>(`/api/todo/categories/${encodeURIComponent(id)}`, jsonInit("PUT", body)),
  todoCategoryDelete: (id: string) =>
    req(`/api/todo/categories/${encodeURIComponent(id)}`, { method: "DELETE" }),
  todoList: (p: {
    category_id?: string;
    include_done?: boolean;
    from?: string;
    to?: string;
    include_undated?: boolean;
  } = {}) => {
    const s: Record<string, string> = {};
    if (p.category_id !== undefined) s.category_id = p.category_id;
    if (p.include_done !== undefined) s.include_done = String(p.include_done);
    if (p.from) s.from = p.from;
    if (p.to) s.to = p.to;
    if (p.include_undated !== undefined) s.include_undated = String(p.include_undated);
    const qs = q(s);
    return req<Todo[]>(`/api/todo/list${qs ? `?${qs}` : ""}`);
  },
  todoCounts: () => req<TodoCounts>("/api/todo/counts"),
  /** 할 일 화면 최초 로드 — 셋을 따로 부르면 서버가 같은 파일을 세 번 읽는다. */
  todoBoard: () =>
    req<{ categories: TodoCategory[]; todos: Todo[]; counts: TodoCounts }>("/api/todo/board"),
  todoCreate: (body: Partial<Todo>) => req<Todo>("/api/todo/create", jsonInit("POST", body)),
  todoUpdate: (id: string, body: Partial<Todo>) =>
    req<Todo>(`/api/todo/${encodeURIComponent(id)}`, jsonInit("PUT", body)),
  todoDelete: (id: string) =>
    req<{ ok: boolean; id: string; title: string }>(
      `/api/todo/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 폴더를 zip으로 받는 URL(비어 있으면 전체). 앵커 이동으로 세션 쿠키가 실린다. */
  noteArchiveUrl: (path = "") => `${BASE}/api/notes/archive?${q({ path })}`,

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
  /** 설정 드롭다운용 — 비서로 쓸 수 있는 Gemini 모델 목록 */
  aiModels: () =>
    req<{ models: { id: string; label: string }[]; server_default: string }>("/api/ai/models"),

};

export interface AiEvent {
  type: "tool_call" | "tool_result" | "text" | "done" | "error";
  name?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  message?: string;
  text?: string;
  /** 이 스킬이 성공하면 바뀌는 대상("calendar" | "documents"). 조회면 빈 값. */
  mutates?: string;
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
  ai: { tone: string; max_steps: number; model: string };
  calendar: { default_color: string; default_view: string; week_start: number; default_remind: number; ai_rules: string };
  notes: { autosave_ms: number; confirm_delete: boolean };
  display: { show_seconds_in_timer: boolean };
  security: { session_ttl_minutes: number };
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

/** 할 일 — 캘린더와 별개 저장소(구글 동기화 없음). */
export interface Todo {
  id: string;
  title: string;
  description: string;
  category_id: string;
  /** "" = 기한 없음. 날짜만이면 all_day. */
  due: string;
  all_day: boolean;
  /** "" 이면 카테고리 색을 따른다. */
  color: string;
  done: boolean;
  done_at: number;
  order: number;
  created_at?: number;
  updated_at?: number;
}

export interface TodoCategory {
  id: string;
  name: string;
  color: string;
  parent_id: string;
  order: number;
}

/** 카테고리별 개수(키 ""는 미분류). */
export type TodoCounts = Record<string, { total: number; done: number }>;

/** 문서 종류 — 프런트가 어떤 뷰어를 쓸지 정하는 기준(백엔드가 내려준다). */
export type DocKind = "md" | "text" | "image" | "pdf" | "video" | "audio" | "other";

export interface NoteSummary {
  path: string;
  title: string;
  modified: number;
  kind: DocKind;
  size: number;
  editable: boolean;
}
export interface NoteDetail {
  path: string;
  title: string;
  content: string;
  links: string[];
  backlinks: string[];
  kind: DocKind;
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
  /** "document" | "event" | "todo". 예전 엔트리는 서버가 document로 채워 준다. */
  kind: string;
  orig_rel: string;
  name: string;
  is_dir: boolean;
  deleted_at: number;
  /** kind === "event" 일 때만 */
  event_start?: string;
  event_color?: string;
}
export interface NoteSearchHit {
  path: string;
  title: string;
  snippet: string;
}
