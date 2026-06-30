import { create } from "zustand";
import { api, UserSettings } from "../lib/api";

interface SettingsState {
  settings: UserSettings | null;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  patch: (changes: Record<string, unknown>) => Promise<void>;
}

export const useSettings = create<SettingsState>((set) => ({
  settings: null,
  loaded: false,
  error: null,
  load: async () => {
    try {
      const r = await api.getSettings();
      set({ settings: r.settings, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: e instanceof Error ? e.message : "설정 로드 실패" });
    }
  },
  patch: async (changes) => {
    const r = await api.patchSettings(changes);
    set({ settings: r.settings });
  },
}));
