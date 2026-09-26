// 백엔드 API 클라이언트. 세션 쿠키 사용(credentials: include).
import { readSse } from "./sseStream";

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
/**
 * 서버가 이유를 적어 주지 못한 실패(응답이 JSON 이 아니다)의 말. 이런 응답은 대개 **서버에
 * 닿기 전**에 앞단(클라우드플레어·nginx)이 돌려준 HTML 이다. 예전에는 상태 번호만 남아
 * 토스트에 "413"·"502" 가 떴다 — 무엇을 해야 할지 알 수 없다(18차 실측).
 */
const NO_DETAIL: Record<number, string> = {
  413: "보내려는 것이 너무 큽니다 — 인터넷 주소로는 요청 하나에 100MB 까지입니다(Cloudflare 제한).",
  429: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  502: "서버가 잠시 응답하지 않습니다(다시 시작하는 중일 수 있습니다). 잠시 후 다시 시도해 주세요.",
  503: "서버가 잠시 응답하지 않습니다. 잠시 후 다시 시도해 주세요.",
  504: "서버의 응답이 너무 늦습니다. 잠시 후 다시 시도해 주세요.",
  520: "서버에 닿지 못했습니다(다시 시작하는 중일 수 있습니다). 잠시 후 다시 시도해 주세요.",
  522: "서버에 닿지 못했습니다(다시 시작하는 중일 수 있습니다). 잠시 후 다시 시도해 주세요.",
  524: "서버의 응답이 너무 늦습니다. 잠시 후 다시 시도해 주세요.",
};

/** 서버가 "그 사이 다른 곳에서 바뀌었다"며 덮지 않았다(409) — 문서·회의 문서·일기·논문 메모. */
export const isConflict = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409;

/** 대상이 그새 지워졌다(404·410). 모아 보내는 저장은 다시 해 봐도 영영 실패하므로 끝난 것으로 친다. */
export const isGone = (e: unknown): e is ApiError =>
  e instanceof ApiError && (e.status === 404 || e.status === 410);

function errorMessage(status: number, detail: unknown): string {
  if (detail === undefined) return NO_DETAIL[status] ?? `요청이 실패했습니다(${status}).`;
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
    // JSON 이 아니면(앞단의 HTML) 이유가 없다 — errorMessage 가 상태로 말을 고른다
    let detail: unknown = undefined;
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

/** 일기 잠금을 푼 표. **메모리에만 둔다** — 새 탭·새로고침이면 다시 잠긴다.
 *  localStorage 에 두면 브라우저를 열어 둔 사람 누구나 계속 볼 수 있다.
 *
 *  표는 **하루짜리**다. 서버도 날짜를 함께 서명하므로, 한 날에서 얻은 표로
 *  다른 날을 열 수 없다(예전에는 한 번 맞히면 달력 전체가 열렸다). 그래서
 *  여기서도 어느 날 것인지 함께 들고 다니며 그 날 요청에만 붙인다. */
let diaryUnlock: { token: string; day: string } | null = null;
const unlockHeader = (day: string): Record<string, string> =>
  (diaryUnlock && diaryUnlock.day === day ? { "X-Diary-Unlock": diaryUnlock.token } : {});

/**
 * 인터넷 주소(클라우드플레어)로 들어오면 요청 하나가 이만큼을 넘을 수 없다. 넘는 요청은 서버에
 * 닿기도 전에 413 HTML 로 막힌다(18차 실측: 101MB 막힘, 50MB 통과). 서버는 문서 2GB·녹음
 * 300MB 까지 받는다고 말하지만, 인터넷 주소로는 거기에 닿지 못한다. 양식의 경계 글자들이
 * 조금 붙으므로 100MB 보다 조금 아래로 잡는다.
 */
export const EDGE_UPLOAD_LIMIT = 99_000_000;
let behindEdge: Promise<boolean> | null = null;

/** 이 화면이 클라우드플레어를 거쳐 서버에 닿는가 — 거치면 응답마다 cf-ray 가 붙는다. 한 번만 묻는다.
 *  집 네트워크 주소로 열었으면 거치지 않으므로 서버의 상한만 적용된다. */
function viaEdge(): Promise<boolean> {
  behindEdge ??= fetch(`${BASE}/api/health`, { credentials: "include" })
    .then((r) => r.headers.has("cf-ray"))
    .catch(() => false);
  return behindEdge;
}

/** 보내기 **전에** 크기를 본다. 몇 분을 올린 뒤에야 "413" 을 보던 것을 바로 알린다. */
async function checkUploadSize(file: File): Promise<void> {
  if (file.size <= EDGE_UPLOAD_LIMIT || !(await viaEdge())) return;
  const mb = (file.size / 1_000_000).toFixed(0);
  throw new ApiError(413,
    `'${file.name}' 은 ${mb}MB 라 인터넷 주소로는 올릴 수 없습니다 — 요청 하나에 100MB 까지입니다`
    + "(Cloudflare 제한). 집 네트워크 주소로 열어 올리거나, 파일을 나누거나 줄여 주세요.");
}

/** 파일 하나를 양식으로 보낸다 — 크기부터 본다. 올리기는 **모두 이것을 거친다**
 *  (새 올리기가 크기 확인을 빠뜨리면 인터넷 주소에서 다시 "413" 을 몇 분 뒤에 본다). */
async function uploadFile<T>(url: string, file: File,
                             fields: Record<string, string | undefined> = {}): Promise<T> {
  await checkUploadSize(file);
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v);
  return req<T>(url, { method: "POST", body: fd });
}

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
  /** 서버 주인만 — 임시 비밀번호를 새로 만들어 이 응답에서 한 번만 돌려준다(61차) */
  adminResetPassword: (username: string) =>
    req<AdminUser & { temporary_password: string }>(
      `/api/admin/users/${encodeURIComponent(username)}/password`, { method: "POST" }),
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
  /** `[[옛제목]]` 이 이름을 바꿔 간 곳(없으면 path: null) */
  noteMoved: (title: string) =>
    req<{ path: string | null }>(`/api/notes/moved?${q({ title })}`),
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
  noteUpload: (path: string, file: File) =>
    uploadFile<NoteSummary>(`/api/notes/upload?${q({ path })}`, file),
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
  /** keepalive: 페이지가 닫히는 중에 보내는 저장(치던 설명) */
  todoUpdate: (id: string, body: Partial<Todo> & { base_description?: string }, keepalive = false) =>
    req<Todo>(`/api/todo/${encodeURIComponent(id)}`, { ...jsonInit("PUT", body), keepalive }),
  todoDelete: (id: string) =>
    req<{ ok: boolean; id: string; title: string }>(
      `/api/todo/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 폴더를 zip으로 받는 URL(비어 있으면 전체). 앵커 이동으로 세션 쿠키가 실린다. */
  noteArchiveUrl: (path = "") => `${BASE}/api/notes/archive?${q({ path })}`,
  /** 계정 전체(문서·논문·회의·단어장·일정·할 일·대화)를 zip 으로 받는 URL. */
  accountArchiveUrl: () => `${BASE}/api/notes/archive/account`,

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
  /**
   * 대화 공간 = **나무 하나**. messages 는 모든 가지의 메시지이고, head 는 지금
   * 보고 있는 끝자락이다. 말풍선에 보이는 것은 head 에서 뿌리까지의 한 줄기뿐이다.
   */
  aiSpace: (space: string) =>
    req<{
      messages: ChatMessage[]; head: string; links: { from_id: string; to_id: string }[];
      sessions: ChatSession[]; active: string;
      /** 지도에서 손으로 옮겨 둔 노드 자리 `{메시지 id: [x, y]}` */
      layout: Record<string, [number, number]>;
    }>(`/api/ai/space/${encodeURIComponent(space)}`),
  /** 지도에서 옮긴 노드 자리를 저장한다. null 이면 그 자리를 지운다(자동 배치로). */
  aiSpaceLayout: (space: string, positions: Record<string, [number, number] | null>,
                  keepalive = false) =>
    req<{ ok: boolean; layout: Record<string, [number, number]> }>(
      `/api/ai/space/${encodeURIComponent(space)}/layout`,
      { ...jsonInit("POST", { positions }), keepalive }),
  /** 새 대화를 시작한다 — 가지와 달리 앞 맥락을 하나도 이어받지 않는다. */
  aiSessionNew: (space: string, title = "") =>
    req<{ ok: boolean; id: string }>(
      `/api/ai/space/${encodeURIComponent(space)}/sessions`, jsonInit("POST", { title })),
  aiSessionUse: (space: string, id: string) =>
    req<{ ok: boolean; active: string }>(
      `/api/ai/space/${encodeURIComponent(space)}/sessions/${encodeURIComponent(id)}`,
      { method: "POST" }),
  aiSessionRename: (space: string, id: string, title: string) =>
    req<{ ok: boolean }>(
      `/api/ai/space/${encodeURIComponent(space)}/sessions/${encodeURIComponent(id)}`,
      jsonInit("PATCH", { title })),
  aiSessionDrop: (space: string, id: string) =>
    req<{ ok: boolean }>(
      `/api/ai/space/${encodeURIComponent(space)}/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" }),
  /** 다른 가지로 옮겨 간다(지도에서 노드를 누른 것). */
  aiSpaceHead: (space: string, id: string) =>
    req<{ ok: boolean; head: string }>(
      `/api/ai/space/${encodeURIComponent(space)}/head`, jsonInit("POST", { id })),
  /**
   * 갈라지는 자리의 가지에 AI 가 이름을 붙인다.
   * "1번 더 자세히" 같은 질문만 보면 어느 갈래가 무슨 이야기였는지 알 수 없다.
   */
  aiSpaceNameBranches: (space: string) =>
    req<{ ok: boolean; names: Record<string, string> }>(
      `/api/ai/space/${encodeURIComponent(space)}/name-branches`, { method: "POST" }),
  /** 가지 사이 기억 연결을 걸거나 푼다. */
  aiSpaceLink: (space: string, fromId: string, toId: string, on: boolean) =>
    req<{ ok: boolean }>(`/api/ai/space/${encodeURIComponent(space)}/link`,
      jsonInit("POST", { from_id: fromId, to_id: toId, on })),
  aiSpaceClear: (space: string) =>
    req(`/api/ai/space/${encodeURIComponent(space)}`, { method: "DELETE" }),
  aiSpaceDelete: (space: string, mid: string) =>
    req(`/api/ai/space/${encodeURIComponent(space)}/${encodeURIComponent(mid)}`, { method: "DELETE" }),
  /**
   * 이 단어 후보 목록은 처리했다(닫았거나 넣었다) — 다시 뜨지 않는다.
   * 상태를 브라우저에만 두면 새로고침에 되살아나고, 되살아난 목록은 체크가
   * 풀려 있어 이미 넣은 단어를 한 번 더 넣게 만든다.
   */
  aiVocabProposalDone: (space: string, words: string[]) =>
    req(`/api/ai/space/${encodeURIComponent(space)}/vocab-proposal-done`,
      jsonInit("POST", { words })),
  /** 지금 이 화면에서 보내면 모델이 실제로 받는 것. 모델은 부르지 않는다. */
  aiPreview: (body: { message: string; mode?: string; paper_id?: string; meeting_id?: string }) =>
    req<AiPreview>("/api/ai/preview", jsonInit("POST", body)),

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
  paperUpload: (file: File) => uploadFile<Paper>("/api/papers/upload", file),
  /** PDF 원본 URL(inline). pdf.js 가 fetch 로 받는다 — 세션 쿠키가 실린다. */
  paperFileUrl: (id: string) => `${BASE}/api/papers/${encodeURIComponent(id)}/file`,
  /** keepalive: 페이지가 닫히는 중에 보내는 저장(읽던 쪽 등) */
  /** base_notes: 화면이 고치기 시작한 메모 — 그 사이 바뀌었으면 서버가 409 로 덮지 않는다 */
  paperUpdate: (id: string, body: Partial<Paper> & { base_notes?: string }, keepalive = false) =>
    req<Paper>(`/api/papers/${encodeURIComponent(id)}`, { ...jsonInit("PUT", body), keepalive }),
  paperDelete: (id: string) =>
    req<{ ok: boolean; id: string }>(`/api/papers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  paperExtract: (id: string) =>
    req<{ ok: boolean; started: boolean; status: string }>(
      `/api/papers/${encodeURIComponent(id)}/extract`, { method: "POST" }),

  // ── 기록(상태·일기) ──
  /** 달력 한 화면치. 서버가 글을 아예 안 실어 주므로 표를 붙이지 않는다. */
  diaryRange: (from: string, to: string) => req<DiaryDay[]>(`/api/diary?${q({ from, to })}`),
  diaryGet: (day: string) => req<DiaryDay>(`/api/diary/${day}`, { headers: unlockHeader(day) }),
  diarySave: async (day: string,
    body: Partial<Pick<DiaryDay, "body" | "heart" | "mind" | "text">> & { base_at?: number }) => {
    const r = await req<DiaryDay>(`/api/diary/${day}`, {
      ...jsonInit("PUT", body),
      headers: { "Content-Type": "application/json", ...unlockHeader(day) },
    });
    // 아직 글이 없던 날에 처음 쓰면 서버가 그 하루짜리 표를 함께 준다. 받아 두지
    // 않으면 **다음 자동 저장부터** 서버가 글을 버린다(그때부터는 '이미 글이
    // 있는 날'이라 잠긴 요청으로 보이기 때문이다).
    if (r.unlock) diaryUnlock = { token: r.unlock, day };
    return r;
  },
  /** 일기 잠금 풀기. 맞으면 **그 하루짜리** 표를 받아 둔다. */
  diaryUnlock: async (pin: string, day: string) => {
    const r = await req<{ token: string; date: string; ttl: number }>(
      "/api/diary/unlock", jsonInit("POST", { pin, date: day }));
    diaryUnlock = { token: r.token, day: r.date || day };
    return r;
  },
  // ── 사용량(수치만) ──
  usagePage: (body: { route: string; seconds: number; came_from: string }) =>
    req<{ ok: boolean }>("/api/usage/page", jsonInit("POST", body)),
  usageMine: (month = "") => req<UsageSummary>(`/api/usage/me?${q({ month })}`),
  /** 주인 전용. 목록에는 이번 달 토큰만 실린다. */
  usageUsers: (month = "") =>
    req<{ month: string; users: UsageUserRow[] }>(`/api/usage/users?${q({ month })}`),
  usageUser: (username: string, month = "") =>
    req<UsageSummary>(`/api/usage/user/${encodeURIComponent(username)}?${q({ month })}`),

  diaryLockState: () => req<{ is_default: boolean }>("/api/diary/lock"),
  /** 로그인 비밀번호 바꾸기 — 다른 기기의 세션은 끊기고 이 기기는 새 세션을 받는다(59차) */
  changePassword: (current: string, next: string) =>
    req<{ ok: boolean; message: string }>("/api/auth/password", jsonInit("POST", { current, new: next })),
  diaryChangePin: (current: string, next: string) =>
    req<{ ok: boolean; is_default: boolean }>("/api/diary/pin", jsonInit("PUT", { current, next })),
  diaryRelock: () => { diaryUnlock = null; },
  /** 지금 열려 있는 하루(없으면 ""). */
  diaryUnlockedDay: () => diaryUnlock?.day ?? "",

  // ── 회의 녹음 ──
  meetingList: () => req<Meeting[]>("/api/meetings"),
  meetingCategories: () => req<string[]>("/api/meetings/categories"),
  meetingGet: (id: string) => req<Meeting>(`/api/meetings/${encodeURIComponent(id)}`),
  meetingUpload: (file: File, opts: { title?: string; category?: string; day?: string } = {}) =>
    uploadFile<Meeting>("/api/meetings/upload", file, opts),
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
    req<{ hits: SearchHit[]; query: string; more?: Record<string, number>; more_at_least?: string[] }>(
      `/api/search?${q({ q: query, kinds, limit: String(limit) })}`),
  /** 입력칸의 `[` 뒤에 친 글자로 링크 후보를 받는다(이름·주소만, 본문 없음). */
  linkSuggest: (query: string, limit = 30) =>
    req<{ query: string; items: LinkItem[]; more?: number }>(
      `/api/links/suggest?${q({ q: query, limit: String(limit) })}`),
  /** 링크 → 그 항목을 여는 화면 주소. */
  linkOpen: (path: string) => req<LinkBrief>(`/api/links/open?${q({ path })}`),
};

export interface LinkItem {
  /** `note/서버/기록.md` — 대괄호 안에 그대로 들어갈 경로 */
  path: string;
  kind: string;
  label: string;
  detail: string;
  /** 폴더면 고른 뒤에도 후보가 이어진다(안으로 들어간다) */
  folder: boolean;
  href: string;
}

export interface LinkBrief {
  path: string;
  kind: string;
  title: string;
  found: boolean;
  href: string;
}

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
  /** 고르면 갈 화면. 서버가 링크와 같은 규칙(links.screen_of)으로 만든다. */
  href: string;
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

/** 이 요청을 보내면 모델이 실제로 받는 것 전부(원문). */
export interface AiPreview {
  today: string;
  mode: string;
  system: string;
  history: { role: string; text: string; chars: number }[];
  message: string;
  attachments: { label: string; mime: string; bytes: number }[];
  skills: string[];
  totals: {
    system_chars: number;
    history_turns: number;
    history_chars: number;
    message_chars: number;
    skills: number;
    chars_total: number;
  };
}

// ── 사용량 ──
/** 계정 목록 한 줄. **이번 달 토큰 말고는 아무 수치도 싣지 않는다.** */
export interface UsageUserRow {
  username: string;
  display_name: string;
  role: string;
  status: string;
  tokens: number;
}

export interface UsageTokens {
  total: number;
  prompt: number;
  output: number;
  calls: number;
}

/** 한 사용자의 사용량 — 전부 수치다. 제목·본문은 어떤 필드에도 오지 않는다. */
export interface UsageSummary {
  username: string;
  month: string;
  months: string[];
  tokens: {
    total: number; prompt: number; output: number; calls: number;
    by_model: Record<string, UsageTokens>;
    /** 화면별 AI 토큰(assistant·calendar·english·paper·meeting·기타). */
    by_mode: Record<string, UsageTokens>;
  };
  /** 화면 이름 → 머문 시간·본 횟수. 이름은 서버가 아는 라우트로 접힌 값이다. */
  pages: Record<string, { seconds: number; views: number }>;
  /** 많이 다닌 길(최대 20). */
  moves: { from: string; to: string; count: number }[];
  days: Record<string, { seconds: number; tokens: number; calls: number }>;
  total_seconds: number;
  total_views: number;
  counts: Record<string, number>;
  context: { spaces: number; turns: number; chars: number };
  generated_at: number;
}

/**
 * 한 공간 안의 대화 하나. **가지와 다르다** — 가지는 한 이야기 안에서 갈라지는
 * 것이고, 세션은 아예 다른 이야기라 앞 맥락을 하나도 쓰지 않는다.
 */
export interface ChatSession {
  id: string;
  title: string;
  turns: number;
  created_at: number;
  updated_at: number;
}

/** 서버에 남은 대화 한 줄(영어 학습·논문). */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  /** 대화 나무에서 이 메시지가 매달린 자리. 뿌리는 null. */
  parent?: string | null;
  meta: {
    /** AI 가 붙인 가지 이름 — 갈라지는 자리의 질문에만 있다. */
    branch_name?: string;
    selections?: { text: string; page: number }[];
    attachments?: { label: string; mime: string }[];
    /** 메시지에 적은 `[note/…]` 링크를 서버가 풀어 본 결과(본문은 없다) */
    links?: LinkBrief[];
    /** (질문에만) 답을 못 받은 까닭. 오류로 끝난 답은 저장되지 않으므로 까닭을 질문에 남긴다. */
    failed?: string;
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
  /**
   * 이 메시지 **뒤에** 새 가지를 낸다. 과거 질문을 고쳐 다시 묻는 것도 이것
   * 하나로 된다(그 질문의 부모를 준다).
   *
   *   없음    가지를 내지 않는다 — 지금 보고 있는 끝에 이어 붙는다
   *   null    **대화 맨 앞**에 새 가지를 낸다(첫 질문을 고쳐 다시 물을 때)
   *   "<id>"  그 메시지 뒤에 새 가지를 낸다
   *
   * 빈 문자열로 뭉뚱그리면 "맨 앞에 내기"와 "가지 안 내기"를 구별할 수 없다.
   */
  parent?: string | null;
  /** 나란히 견주어 달라고 고른 가지들(각 가지의 끝 메시지 id) */
  compare?: string[];
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
  // 끝 신호(done/error) 없이 끝나면 StreamCut — 잘린 답을 다 쓴 답처럼 보이지 않게.
  await readSse(res.body, onEvent, signal);
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
  /**
   * 목록 맨 위에 고정하고 다른 색으로 그릴 폴더(논문·회의처럼 **다른 화면이
   * 관리하는** 것). 이름을 화면에 박아 두지 않도록 서버가 알려 준다.
   */
  pinned?: string[];
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
  /** kind === "meeting_doc" 일 때만 — 어느 회의의 문서였는지 */
  meeting_title?: string;
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
  /** 잠겨 있으면 빈 문자열이다. "일기가 있는가"는 has_text 로 봐야 한다. */
  text: string;
  /** 그날 일기가 있는가. 잠긴 동안에도 온다(달력 칸의 체크 표시). */
  has_text: boolean;
  /** 서버가 글을 빼고 보냈다는 표시. */
  locked?: boolean;
  /** 아직 글이 없던 날에 처음 쓴 저장의 응답에만 온다 — 그 하루짜리 표.
   *  `diarySave` 가 받아서 보관하므로 화면이 직접 다룰 일은 없다. */
  unlock?: string;
  updated_at: string;
  /** 글이 마지막으로 바뀐 때(도형만 바꾼 것으로는 안 움직인다). 저장에 base_at 으로 돌려보내면
   *  그 사이 다른 곳에서 바뀐 글을 덮지 않고 409 가 온다. */
  text_at?: number;
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
