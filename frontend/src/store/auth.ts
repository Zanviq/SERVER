import { create } from "zustand";
import { api, ApiError, SessionInfo } from "../lib/api";
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
      if (status === 401 || status === 403) set({ session: null, remaining: 0 });
    }
  },
}));
