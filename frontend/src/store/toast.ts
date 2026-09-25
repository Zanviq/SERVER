import { create } from "zustand";

export interface Toast {
  id: number;
  msg: string;
  kind: "ok" | "error";
}

interface ToastState {
  toasts: Toast[];
  push: (msg: string, kind: "ok" | "error") => void;
  remove: (id: number) => void;
}

let nextId = 1;

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  push: (msg, kind) => {
    // 같은 말이 아직 떠 있으면 또 띄우지 않는다. 자동 저장이 서버가 돌아오기를 기다리며 다시 해
    // 볼 때마다(lib/pendingSave RETRY_MS) 같은 "저장 실패"가 쌓였다.
    if (get().toasts.some((t) => t.msg === msg && t.kind === kind)) return;
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3800);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  ok: (m: string) => useToast.getState().push(m, "ok"),
  error: (m: string) => useToast.getState().push(m, "error"),
};
