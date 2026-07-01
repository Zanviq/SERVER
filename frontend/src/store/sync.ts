import { create } from "zustand";
import { api, Scope } from "../lib/api";
import {
  fsSupported, pickDirectory, queryPerm, requestPerm, walk, readBuf, writeLocal,
  sha256, isTextFile, mergeLines,
} from "../lib/fsAccess";
import { getMapping, saveMapping, clearMapping } from "../lib/syncDb";
import { useSettings } from "./settings";

export type SyncStatus =
  | "unsupported" // 브라우저 미지원
  | "unsynced" // 연동 안됨
  | "resume" // 매핑 있으나 권한 재요청 필요(클릭)
  | "syncing" // 동기화 중
  | "idle" // 연동됨(대기)
  | "conflict" // 충돌 대기(사용자 선택 필요)
  | "error";

export interface Conflict {
  rel: string;
  localText: string;
  webText: string;
}

interface SyncState {
  status: SyncStatus;
  userId: string | null;
  handle: any | null;
  scope: Scope;
  path: string;
  localName: string;
  conflicts: Conflict[];
  stats: { up: number; down: number } | null;
  error: string | null;

  init: (userId: string) => Promise<void>;
  connect: (scope: Scope, path: string) => Promise<void>;
  resume: () => Promise<void>;
  runSync: () => Promise<void>;
  resolveConflict: (rel: string, choice: "local" | "web" | "merge") => Promise<void>;
  disconnect: () => Promise<void>;
}

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

async function fetchWebBuf(scope: Scope, path: string, rel: string): Promise<ArrayBuffer> {
  const res = await fetch(api.syncDownloadUrl(scope, path, rel), { credentials: "include" });
  if (!res.ok) throw new Error(`다운로드 실패: ${rel}`);
  return res.arrayBuffer();
}

export const useSync = create<SyncState>((set, get) => ({
  status: fsSupported() ? "unsynced" : "unsupported",
  userId: null,
  handle: null,
  scope: "me",
  path: "",
  localName: "",
  conflicts: [],
  stats: null,
  error: null,

  // 로그인 직후 자동 시도
  init: async (userId) => {
    if (!fsSupported()) {
      set({ status: "unsupported", userId });
      return;
    }
    set({ userId });
    const m = await getMapping(userId).catch(() => undefined);
    if (!m) {
      set({ status: "unsynced", handle: null, localName: "" });
      return;
    }
    set({ handle: m.handle, scope: m.scope, path: m.path, localName: m.handle?.name ?? "" });
    const perm = await queryPerm(m.handle);
    if (perm === "granted") {
      await get().runSync();
    } else {
      set({ status: "resume" }); // 권한 재요청(클릭) 필요
    }
  },

  connect: async (scope, path) => {
    const userId = get().userId;
    if (!userId) return;
    const handle = await pickDirectory(); // 사용자 제스처
    await saveMapping({ userId, handle, scope, path });
    set({ handle, scope, path, localName: handle.name });
    await get().runSync();
  },

  resume: async () => {
    const h = get().handle;
    if (!h) return;
    const ok = await requestPerm(h); // 사용자 제스처 안에서 호출되어야 함
    if (!ok) {
      set({ status: "resume", error: "폴더 접근 권한이 거부되었습니다." });
      return;
    }
    await get().runSync();
  },

  runSync: async () => {
    const { handle, scope, path } = get();
    if (!handle) return;
    set({ status: "syncing", error: null, conflicts: [] });
    const sync = useSettings.getState().settings?.sync;
    const textPolicy = sync?.text_conflict ?? "ask";
    const binaryPolicy = sync?.binary_policy ?? "local";
    try {
      // 1) 로컬 파일 해시
      const localFiles = await walk(handle);
      const localMap = new Map<string, { handle: any; hash: string; buf: ArrayBuffer }>();
      for (const f of localFiles) {
        const buf = await readBuf(f.handle);
        localMap.set(f.rel, { handle: f.handle, hash: await sha256(buf), buf });
      }
      // 2) 웹 매니페스트
      const manifest = await api.syncManifest(scope, path);
      const webMap = new Map(manifest.files.map((f) => [f.rel, f.hash]));

      const conflicts: Conflict[] = [];
      let up = 0;
      let down = 0;

      // 3) 로컬 기준 비교
      for (const [rel, lf] of localMap) {
        const wh = webMap.get(rel);
        if (wh === undefined) {
          await api.syncUpload(scope, path, rel, lf.buf);
          up++;
        } else if (wh === lf.hash) {
          // 동일 → skip
        } else if (isTextFile(rel)) {
          const localText = dec(lf.buf);
          const webText = dec(await fetchWebBuf(scope, path, rel));
          if (textPolicy === "local") {
            await api.syncUpload(scope, path, rel, lf.buf);
            up++;
          } else if (textPolicy === "web") {
            await writeLocal(handle, rel, enc(webText));
            down++;
          } else if (textPolicy === "merge") {
            const merged = mergeLines(localText, webText);
            await api.syncUpload(scope, path, rel, enc(merged));
            await writeLocal(handle, rel, enc(merged));
            up++;
          } else {
            conflicts.push({ rel, localText, webText });
          }
        } else {
          // 바이너리 → 정책대로 (기본 로컬 우선)
          if (binaryPolicy === "web") {
            await writeLocal(handle, rel, await fetchWebBuf(scope, path, rel));
            down++;
          } else {
            await api.syncUpload(scope, path, rel, lf.buf);
            up++;
          }
        }
      }

      // 4) 웹에만 있는 파일 → 로컬로 내려받기 (합집합 미러)
      for (const f of manifest.files) {
        if (!localMap.has(f.rel)) {
          await writeLocal(handle, f.rel, await fetchWebBuf(scope, path, f.rel));
          down++;
        }
      }

      set({
        stats: { up, down },
        conflicts,
        status: conflicts.length ? "conflict" : "idle",
      });
    } catch (e) {
      set({ status: "error", error: e instanceof Error ? e.message : "동기화 실패" });
    }
  },

  resolveConflict: async (rel, choice) => {
    const { handle, scope, path, conflicts } = get();
    const c = conflicts.find((x) => x.rel === rel);
    if (!c || !handle) return;
    try {
      if (choice === "local") {
        await api.syncUpload(scope, path, rel, enc(c.localText));
      } else if (choice === "web") {
        await writeLocal(handle, rel, enc(c.webText));
      } else {
        const merged = mergeLines(c.localText, c.webText);
        await api.syncUpload(scope, path, rel, enc(merged));
        await writeLocal(handle, rel, enc(merged));
      }
      const rest = conflicts.filter((x) => x.rel !== rel);
      set({ conflicts: rest, status: rest.length ? "conflict" : "idle" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "충돌 처리 실패" });
    }
  },

  disconnect: async () => {
    const userId = get().userId;
    if (userId) await clearMapping(userId).catch(() => {});
    set({ status: fsSupported() ? "unsynced" : "unsupported", handle: null, localName: "", conflicts: [], stats: null });
  },
}));
