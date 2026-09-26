import { create } from "zustand";
import { api, ApiError, setUnauthorizedHandler, type SessionInfo } from "../lib/api";
import { toast } from "./toast";

interface AuthState {
  session: SessionInfo | null;
  loading: boolean; // 초기 세션 확인 중
  /** 로그아웃된 게 아니라 **서버에 닿지 못했다**. 로그인 화면 대신 이걸 보여 준다. */
  offline: boolean;
  error: string | null;
  remaining: number; // 남은 초 (1초마다 감소)
  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  clearError: () => void;
  tick: () => void; // 1초 카운트다운
  refresh: () => Promise<void>; // 서버 기준 남은시간 재동기화
  retryInit: () => Promise<void>;   // "다시 시도" — 서버가 살아났는지 본다
}

export const useAuth = create<AuthState>((set, get) => ({
  session: null,
  loading: true,
  offline: false,
  error: null,
  remaining: 0,

  init: async () => {
    try {
      const s = await api.session();
      set({ session: s, remaining: s.remaining, loading: false, error: null, offline: false });
    } catch (e) {
      // **로그인이 끊긴 것과 서버에 닿지 못한 것은 다르다**(refresh 와 같은 규칙).
      // 여기서 뭉뚱그리면 서버가 잠깐 내려간 사이에 새로 고친 사람에게 로그인
      // 화면이 뜬다 — 쿠키는 멀쩡한데 비밀번호를 다시 치고, 그것도 실패하니
      // 계정이 잘못된 줄 안다. 배포할 때마다 컨테이너가 재시작하므로 드문 일도 아니다.
      const status = e instanceof ApiError ? e.status : 0;
      set({ session: null, loading: false, offline: status !== 401 && status !== 403 });
    }
  },

  retryInit: async () => {
    set({ loading: true });
    await get().init();
  },

  login: async (username, password) => {
    try {
      const s = await api.login(username, password);
      set({ session: s, remaining: s.remaining, error: null, offline: false });
      return true;
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "로그인 실패";
      set({ error: msg });
      return false;
    }
  },

  clearError: () => set({ error: null }),

  logout: async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    set({ session: null, remaining: 0 });
  },

  tick: () => {
    const { session, remaining } = get();
    if (!session) return;
    const next = remaining - 1;
    if (next <= 0) {
      // 만료 → 자동 로그아웃 (사용자에게 안내)
      set({ session: null, remaining: 0 });
      toast.error("세션이 만료되어 로그아웃되었습니다. 다시 로그인해주세요.");
    } else {
      set({ remaining: next });
    }
  },

  refresh: async () => {
    try {
      const s = await api.session();
      set({ session: s, remaining: s.remaining });
    } catch (e) {
      // **로그인이 끊긴 것과 네트워크가 잠깐 끊긴 것은 다르다.** 이 함수는 60초마다
      // 도는데, 예전에는 5xx·연결 실패에도 세션을 지워서 쿠키가 멀쩡한데도
      // 로그인 화면으로 튕기고 쓰던 화면(편집 중인 글 포함)을 잃었다.
      const status = e instanceof ApiError ? e.status : 0;
      if ((status === 401 || status === 403) && get().session) {
        set({ session: null, remaining: 0 });
        // 쓰던 글은 이 브라우저에 밑글로 남아 있다 — 다시 로그인해 그 문서를 열면 되살리기 띠가 뜬다
        toast.error("세션이 끝났습니다(다른 곳에서 로그아웃했거나 비밀번호가 바뀌었을 수 있습니다). 다시 로그인하면 쓰던 글을 되살릴 수 있습니다.");
      }
    }
  },
}));

// 어떤 요청이든 401 을 받으면 60초를 기다리지 않고 곧바로 세션을 다시 본다(76차 — api.setUnauthorizedHandler).
// 한꺼번에 여럿이 401 을 받아도 확인은 한 번만.
let checking = false;
setUnauthorizedHandler(() => {
  if (checking || !useAuth.getState().session) return;
  checking = true;
  void useAuth.getState().refresh().finally(() => { checking = false; });
});
