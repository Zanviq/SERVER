import { create } from "zustand";
import { api, ApiError, SessionInfo } from "../lib/api";
import { toast } from "./toast";

interface AuthState {
  session: SessionInfo | null;
  loading: boolean; // 초기 세션 확인 중
  error: string | null;
  remaining: number; // 남은 초 (1초마다 감소)
  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  clearError: () => void;
  tick: () => void; // 1초 카운트다운
  refresh: () => Promise<void>; // 서버 기준 남은시간 재동기화
}

export const useAuth = create<AuthState>((set, get) => ({
  session: null,
  loading: true,
  error: null,
  remaining: 0,

  init: async () => {
    try {
      const s = await api.session();
      set({ session: s, remaining: s.remaining, loading: false, error: null });
    } catch {
      set({ session: null, loading: false });
    }
  },

  login: async (username, password) => {
    try {
      const s = await api.login(username, password);
      set({ session: s, remaining: s.remaining, error: null });
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
