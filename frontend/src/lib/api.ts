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

/** 서버가 준 detail 을 사람이 읽을 한 줄로. 형태가 셋이라 한 곳에서 정리한다.
 *
 *  - 문자열: 우리 코드가 던지는 HTTPException(detail="...")
 *  - 객체: 구조화된 오류({error, message, ...})
 *  - **배열**: FastAPI 의 검증 실패(422). 이걸 처리하지 않아서 화면에 "422"만 떴다. */
function errorMessage(status: number, detail: unknown): string {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const first = detail[0] as { loc?: unknown[]; msg?: string } | undefined;
    if (first?.msg) {
      const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : "";
      return field ? `${field}: ${first.msg}` : first.msg;
    }
  }
  const msg = (detail as { message?: string })?.message;
  if (msg) return msg;
  return status === 422 ? "입력한 값을 확인해 주세요." : `${status}`;
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
    throw new ApiError(res.status, errorMessage(res.status, detail), detail);
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
  /** baseModified 를 주면 그 사이 다른 곳에서 바뀐 문서를 덮어쓰지 않고 409 로 멈춘다. */
  noteSave: (path: string, content: string, baseModified = 0) =>
    req<NoteSummary>("/api/notes/save",
      jsonInit("PUT", { path, content, base_modified: baseModified })),
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
  /** 서버에 남는 대화 공간(영어 학습 "english" · 논문 "paper:<id>") */
  aiSpace: (space: string) =>
    req<{ messages: ChatMessage[] }>(`/api/ai/space/${encodeURIComponent(space)}`),
  aiSpaceClear: (space: string) =>
    req(`/api/ai/space/${encodeURIComponent(space)}`, { method: "DELETE" }),
  aiSpaceDelete: (space: string, mid: string) =>
    req(`/api/ai/space/${encodeURIComponent(space)}/${encodeURIComponent(mid)}`, { method: "DELETE" }),

// ── 단어장 ──
  vocabBoard: () => req<VocabBoard>("/api/vocab/board"),
  vocabWords: (p: { tag?: string; q?: string; due?: boolean; limit?: number } = {}) => {
    const s: Record<string, string> = {};
    if (p.tag) s.tag = p.tag;
    if (p.q) s.q = p.q;
    if (p.due) s.due = "true";
    if (p.limit) s.limit = String(p.limit);
    const qs = q(s);
    return req<VocabWord[]>(`/api/vocab/words${qs ? `?${qs}` : ""}`);
  },
  vocabTags: () => req<VocabTag[]>("/api/vocab/tags"),
  vocabCreate: (body: VocabInput) =>
    req<{ word: VocabWord; merged: boolean }>("/api/vocab/words", jsonInit("POST", body)),
  vocabBulk: (words: VocabInput[], tags: string[] = []) =>
    req<{ added: VocabWord[]; merged: VocabWord[]; failed: { word: string; reason: string }[] }>(
      "/api/vocab/words/bulk", jsonInit("POST", { words, tags })),
  vocabUpdate: (id: string, body: Partial<VocabInput>) =>
    req<VocabWord>(`/api/vocab/words/${encodeURIComponent(id)}`, jsonInit("PUT", body)),
  vocabDelete: (id: string) =>
    req<{ ok: boolean; id: string; word: string }>(
      `/api/vocab/words/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** 고른 항목만 백그라운드에서 채워 넣는다(모델을 다시 거치지 않는다). */
  vocabFill: (words: VocabFillItem[], p: { tags?: string[]; context?: string } = {}) =>
    req<VocabJob>("/api/vocab/fill",
      jsonInit("POST", { words, tags: p.tags ?? [], context: p.context ?? "" })),
  /** 단어·문장·문법을 뒤섞어 적은 글을 AI 가 갈래로 나눠 넣는다(백그라운드). */
  vocabCollect: (text: string, tags: string[] = []) =>
    req<VocabJob>("/api/vocab/collect", jsonInit("POST", { text, tags })),
  vocabJobs: () => req<{ jobs: VocabJob[] }>("/api/vocab/jobs"),
  vocabRenameTag: (old: string, next: string) =>
    req<{ ok: boolean; changed: number }>("/api/vocab/tags/rename", jsonInit("POST", { old, new: next })),
  vocabReviewQueue: (tag = "", limit = 20) =>
    req<VocabWord[]>(`/api/vocab/review?${q({ tag, limit: String(limit) })}`),
  vocabReview: (id: string, ok: boolean) =>
    req<VocabWord>(`/api/vocab/words/${encodeURIComponent(id)}/review`, jsonInit("POST", { ok })),

  // ── 논문 ──
  paperList: () => req<Paper[]>("/api/papers"),
  paperCategories: () => req<{ categories: string[] }>("/api/papers/categories"),
  paperGet: (id: string) => req<Paper>(`/api/papers/${encodeURIComponent(id)}`),
  paperUpload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<Paper>("/api/papers/upload", { method: "POST", body: fd });
  },
  /** PDF 원본 URL(inline). pdf.js 가 fetch 로 받는다 — 세션 쿠키가 실린다. */
  paperFileUrl: (id: string) => `${BASE}/api/papers/${encodeURIComponent(id)}/file`,
  paperUpdate: (id: string, body: Partial<Paper>) =>
    req<Paper>(`/api/papers/${encodeURIComponent(id)}`, jsonInit("PUT", body)),
  paperDelete: (id: string) =>
    req<{ ok: boolean; id: string }>(`/api/papers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  paperExtract: (id: string) =>
    req<{ ok: boolean; started: boolean; status: string }>(
      `/api/papers/${encodeURIComponent(id)}/extract`, { method: "POST" }),

  // ── 기록(상태·일기) ──
  diaryRange: (from: string, to: string) => req<DiaryDay[]>(`/api/diary?${q({ from, to })}`),
  diaryGet: (day: string) => req<DiaryDay>(`/api/diary/${day}`),
  diarySave: (day: string, body: Partial<Pick<DiaryDay, "body" | "heart" | "mind" | "text">>) =>
    req<DiaryDay>(`/api/diary/${day}`, jsonInit("PUT", body)),

  // ── 회의 녹음 ──
  meetingList: () => req<Meeting[]>("/api/meetings"),
  meetingCategories: () => req<string[]>("/api/meetings/categories"),
  meetingGet: (id: string) => req<Meeting>(`/api/meetings/${encodeURIComponent(id)}`),
  meetingUpload: (file: File, opts: { title?: string; category?: string; day?: string } = {}) => {
    const fd = new FormData();
    fd.append("file", file);
    if (opts.title) fd.append("title", opts.title);
    if (opts.category) fd.append("category", opts.category);
    if (opts.day) fd.append("day", opts.day);
    return req<Meeting>("/api/meetings/upload", { method: "POST", body: fd });
  },
  /** 원본 녹음 URL(inline, Range 지원) — <audio> 가 그대로 쓴다. */
  meetingAudioUrl: (id: string) => `${BASE}/api/meetings/${encodeURIComponent(id)}/audio`,
  meetingTranscript: (id: string) => req<Transcript>(`/api/meetings/${encodeURIComponent(id)}/transcript`),
  meetingUpdate: (id: string, body: Partial<Pick<Meeting, "title" | "category" | "date" | "summary" | "speakers">>) =>
    req<Meeting>(`/api/meetings/${encodeURIComponent(id)}`, jsonInit("PUT", body)),
  meetingDelete: (id: string) =>
    req<{ ok: boolean; id: string }>(`/api/meetings/${encodeURIComponent(id)}`, { method: "DELETE" }),
  meetingTranscribe: (id: string) =>
    req<{ ok: boolean; started: boolean; status: string }>(
      `/api/meetings/${encodeURIComponent(id)}/transcribe`, { method: "POST" }),
  meetingDocs: (id: string) => req<MeetingDocSummary[]>(`/api/meetings/${encodeURIComponent(id)}/docs`),
  meetingDocRead: (id: string, name: string) =>
    req<MeetingDoc>(`/api/meetings/${encodeURIComponent(id)}/docs/${encodeURIComponent(name)}`),
  /** baseModified 를 주면 그 사이 바뀐 문서를 덮어쓰지 않고 409 로 멈춘다. */
  meetingDocWrite: (id: string, name: string, content: string, baseModified = 0) =>
    req<MeetingDoc>(`/api/meetings/${encodeURIComponent(id)}/docs/${encodeURIComponent(name)}`,
      jsonInit("PUT", { content, base_modified: baseModified })),
  meetingDocRename: (id: string, name: string, next: string) =>
    req<{ name: string }>(`/api/meetings/${encodeURIComponent(id)}/docs/${encodeURIComponent(name)}/rename`, jsonInit("POST", { name: next })),
  meetingDocDelete: (id: string, name: string) =>
    req<{ ok: boolean }>(`/api/meetings/${encodeURIComponent(id)}/docs/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // ── 외부 SSH(주인 전용) ──
  sshAccess: () => req<SshAccess>("/api/system/ssh"),

  // ── 컨텍스트(지난 대화) ──
  contextSpaces: () => req<{ spaces: ContextSpace[] }>("/api/context/spaces"),
  contextSessions: (space: string) =>
    req<{ space: string; label: string; sessions: ContextSession[] }>(
      `/api/context/sessions?${q({ space })}`),
  contextMessages: (space: string, session = "") =>
    req<{ space: string; label: string; messages: ChatMessage[] }>(
      `/api/context/messages?${q({ space, session })}`),
  contextSearch: (query: string, space = "") =>
    req<{ hits: ContextHit[]; query: string }>(`/api/context/search?${q({ q: query, space })}`),
  /** 화면을 가로지르는 검색. kinds 를 비우면 전부 뒤진다. */
  searchAll: (query: string, kinds = "", limit = 40) =>
    req<{ hits: SearchHit[]; query: string }>(
      `/api/search?${q({ q: query, kinds, limit: String(limit) })}`),
};

export type SearchKind = "note" | "paper" | "meeting" | "vocab" | "todo" | "event" | "chat";

export interface SearchHit {
  kind: SearchKind;
  /** 갈래마다 뜻이 다르다 — 노트는 상대경로, 대화는 "<space>|<session>", 나머지는 id. */
  id: string;
  title: string;
  snippet: string;
  when: string;
  where: string;
  score: number;
}

export interface AiEvent {
  /** `text_delta` 는 만들어지는 중인 답의 조각이다. 마지막에 오는 `text` 가
   *  최종본이며(경고 문구가 덧붙기도 한다) 화면은 그것으로 갈아끼운다. */
  type: "tool_call" | "tool_result" | "text_delta" | "text" | "done" | "error";
  name?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  message?: string;
  text?: string;
  /** 이 스킬이 성공하면 바뀌는 대상("calendar" | "documents" | "vocab" | "papers"). 조회면 빈 값. */
  mutates?: string;
  /** 화면이 그려야 하는 스킬 결과(단어 후보 목록 등). 그런 스킬만 보낸다. */
  data?: Record<string, unknown>;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** 서버에 남은 대화 한 줄(영어 학습·논문). */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  meta: {
    selections?: { text: string; page: number }[];
    attachments?: { label: string; mime: string }[];
    /** 스킬 호출 기록. args·result 는 감사용 원문(길면 서버가 자른다). */
    tools?: {
      name: string; ok: boolean; message: string;
      args?: string; result?: string;
      data?: Record<string, unknown>;
    }[];
  };
}

/** 논문 화면에서 드래그한 영역 이미지 — data 는 data URL 또는 base64. */
export interface AiAttachment {
  mime: string;
  data: string;
  label?: string;
}
export interface AiSelection {
  text: string;
  page?: number;
}
export interface AiChatOptions {
  mode?: "" | "assistant" | "calendar" | "english" | "paper" | "meeting";
  paper_id?: string;
  meeting_id?: string;
  attachments?: AiAttachment[];
  selections?: AiSelection[];
  /** 중단 버튼용. 끊으면 서버도 스트림을 닫고, 여기까지 흘러온 답을 기록에 남긴다. */
  signal?: AbortSignal;
}

/** AI 채팅 SSE 스트림. history로 이전 대화(멀티턴) 전달.
 *  모드가 있으면 서버가 기록을 들고 있으므로 history 는 무시된다. */
export async function aiChatStream(
  message: string,
  history: ChatTurn[],
  onEvent: (e: AiEvent) => void,
  opts: AiChatOptions = {},
): Promise<void> {
  const { signal, ...payload } = opts;
  const res = await fetch(`${BASE}/api/ai/chat`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history, ...payload }),
    signal,
  });
  if (!res.ok || !res.body) {
    // 415(이미지 형식)·413(크기)·400(모드) 같은 거절은 이유를 그대로 보여 준다
    let detail: unknown = "AI 요청 실패";
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, errorMessage(res.status, detail), detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
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
  } catch (e) {
    // 중단 버튼을 눌렀으면 오류가 아니다 — 여기까지 받은 것으로 끝낸다.
    if (!signal?.aborted) throw e;
  } finally {
    void reader.cancel().catch(() => {});
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
  /** 이 내용을 읽은 시점의 수정시각. 저장할 때 되돌려 보내 충돌을 잡는다. */
  modified: number;
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
  /** "document" | "event" | "todo" | "vocab" | "paper" | "meeting". 예전 엔트리는 서버가 document로 채워 준다. */
  kind: string;
  orig_rel: string;
  name: string;
  is_dir: boolean;
  deleted_at: number;
  /** kind === "event" 일 때만 */
  event_start?: string;
  event_color?: string;
  /** kind === "todo" 일 때만 */
  todo_due?: string;
  todo_done?: boolean;
  /** kind === "vocab" 일 때만 */
  vocab_tags?: string[];
  vocab_meaning?: string;
  /** kind === "paper" 일 때만 */
  paper_id?: string;
  paper_filename?: string;
  /** kind === "meeting" 일 때만 */
  meeting_id?: string;
  meeting_date?: string;
  meeting_category?: string;
}

// ── 기록(상태·일기) ──
/** 하루의 상태 도형. 빈 문자열은 '표시 안 함'. */
export type DiaryShape = "" | "star" | "circle" | "triangle" | "square" | "pentagon";
export type DiaryAxis = "body" | "heart" | "mind";
export interface DiaryDay {
  date: string;
  body: DiaryShape;
  heart: DiaryShape;
  mind: DiaryShape;
  text: string;
  updated_at: string;
}

// ── 회의 녹음 ──
export type MeetingStatus = "pending" | "ready" | "failed";
export interface Meeting {
  id: string;
  title: string;
  date: string;
  category: string;
  filename: string;
  mime: string;
  ext: string;
  size: number;
  duration: number;
  created_at: string;
  updated_at: string;
  status: MeetingStatus;
  error: string;
  transcribed_at: string;
  /** 화자 라벨("화자 1") → 사용자가 붙인 이름 */
  speakers: Record<string, string>;
  summary: string;
  segments: number;
  docs: number;
}
export interface TranscriptSegment {
  start: string;
  end: string;
  speaker: string;
  text: string;
}
export interface Transcript {
  segments: TranscriptSegment[];
  text: string;
}
export interface MeetingDocSummary {
  name: string;
  size: number;
  /** 파일 수정시각(unix 초). 서버는 st_mtime 을 그대로 준다. */
  updated_at: number;
}
export interface MeetingDoc {
  name: string;
  content: string;
  updated_at: number;
  created?: boolean;
}

// ── 외부 SSH(주인 전용) ──
export interface SshAccess {
  configured: boolean;
  hostname: string;
  user: string;
  service: string;
  ssh_config: string;
  command: string;
}

/** 컨텍스트 화면의 왼쪽 폴더 하나 = 화면 하나. */
export interface ContextSpace {
  space: string;
  kind: string;
  label: string;
  messages: number;
  sessions: number;
  last_at: number;
}
/** 30분 이상 말이 없으면 다음 메시지부터 새 세션이다(서버가 읽을 때 나눈다). */
export interface ContextSession {
  id: string;
  started_at: number;
  ended_at: number;
  messages: number;
  tools: number;
  preview: string;
}
export interface ContextHit {
  space: string;
  label: string;
  session: string;
  id: string;
  role: string;
  ts: number;
  score: number;
  snippet: string;
}

// ── 단어장 ──
export interface VocabExample {
  en: string;
  ko: string;
  grammar: string;
}
/** 항목의 갈래. 단어장은 영어 단어 전용이 아니다 — 문장·문법·전문 용어도 들어온다. */
export type VocabKind = "" | "word" | "phrase" | "sentence" | "grammar" | "term";
/** 단어장 항목. 영어학습예시 형식(뜻/비슷한 단어/영어 해설/예문/변화/포인트)을 그대로 담는다. */
export interface VocabWord {
  id: string;
  word: string;
  kind: VocabKind;
  pos: string;
  pronunciation: string;
  meanings: string[];
  english_def: string;
  synonyms: string[];
  antonyms: string[];
  examples: VocabExample[];
  forms: string;
  notes: string;
  /** 출처(논문 제목·주제). 같은 단어를 여러 곳에서 만나면 다 붙는다. */
  tags: string[];
  context: string;
  source: string;
  /** 간격 반복 단계. 0 = 아직 안 봄. */
  level: number;
  /** YYYY-MM-DD. 비어 있거나 오늘 이전이면 복습 대상. */
  next_review: string;
  review_ok: number;
  review_ng: number;
  last_reviewed: number;
  created_at: number;
  updated_at: number;
}
export type VocabInput = Partial<Omit<VocabWord, "id" | "meanings" | "synonyms" | "antonyms" | "tags" | "examples">> & {
  word: string;
  meanings?: string[] | string;
  synonyms?: string[] | string;
  antonyms?: string[] | string;
  tags?: string[] | string;
  examples?: (VocabExample | string)[];
};
export interface VocabTag {
  tag: string;
  count: number;
}
export interface VocabStats {
  total: number;
  due: number;
  learned: number;
  tags: number;
}
export interface VocabBoard {
  words: VocabWord[];
  tags: VocabTag[];
  stats: VocabStats;
}
/** 후보 목록에서 고른 항목. 사전 내용은 서버가 백그라운드에서 채운다. */
export interface VocabFillItem {
  word: string;
  meaning?: string;
  kind?: VocabKind;
}
/** 백그라운드 정리 작업. 화면은 진행 표시와 완료 알림에만 쓴다. */
export interface VocabJob {
  id: string;
  kind: "fill" | "collect";
  status: "pending" | "done" | "failed";
  words: string[];
  tags: string[];
  added: string[];
  merged: string[];
  failed: { word: string; reason: string }[];
  error: string;
  created_at: number;
  done_at: number;
}

// ── 논문 ──
export type PaperStatus = "pending" | "ready" | "failed";
export interface Paper {
  id: string;
  filename: string;
  size: number;
  pages: number;
  created_at: number;
  updated_at: number;
  /** 정보 추출 상태. pending 이면 백그라운드에서 모델이 읽는 중. */
  status: PaperStatus;
  error: string;
  extracted_at: number;
  title: string;
  /** 폴더처럼 쓰는 분류. 빈 문자열이면 '분류 없음'으로 묶인다. */
  category: string;
  authors: string[];
  year: string;
  venue: string;
  abstract: string;
  summary: string;
  key_findings: string[];
  methods: string;
  limitations: string;
  keywords: string[];
  sections: string[];
  starred: boolean;
  notes: string;
  /** 마지막으로 보던 쪽 — 다시 열면 여기서 시작 */
  read_page: number;
  tags: string[];
}
export interface NoteSearchHit {
  path: string;
  title: string;
  snippet: string;
}
