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

/**
 * 알림이 떠 있는 시간 — **글 길이에 맞춘다**(디자인 18차). 모두 3.8초이던 때는 긴 오류("이름에 쓸 수 없는 글자(< > : " | ?
 * *)가 있습니다 — 다른 글자로 바꿔 주세요.")가 다 읽기 전에 사라졌고, 알림은 누를 수 없게(pointer-events-none — 탭을
 * 삼키지 않게) 해 두어 붙잡아 둘 길도 없다. 2초 + 한 글자에 80ms, 짧아도 3.8초(오류는 5초), 길어도 10초.
 */
export function toastMs(msg: string, kind: "ok" | "error"): number {
  const min = kind === "error" ? 5000 : 3800;
  return Math.min(10000, Math.max(min, 2000 + [...msg].length * 80));
}

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  push: (msg, kind) => {
    // 같은 말이 아직 떠 있으면 또 띄우지 않는다. 자동 저장이 서버가 돌아오기를 기다리며 다시 해
    // 볼 때마다(lib/pendingSave RETRY_MS) 같은 "저장 실패"가 쌓였다.
    if (get().toasts.some((t) => t.msg === msg && t.kind === kind)) return;
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), toastMs(msg, kind));
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  ok: (m: string) => useToast.getState().push(m, "ok"),
  error: (m: string) => useToast.getState().push(m, "error"),
};
