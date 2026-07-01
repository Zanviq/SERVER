// 로컬 연동 매핑을 IndexedDB에 사용자별 저장.
// FileSystemDirectoryHandle은 structured-clone 가능 → IndexedDB에 그대로 저장된다.

const DB_NAME = "server-sync";
const STORE = "mappings";
const VERSION = 1;

export interface SyncMapping {
  userId: string;
  handle: any; // FileSystemDirectoryHandle
  scope: "me" | "common";
  path: string; // 웹 폴더 상대경로
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "userId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getMapping(userId: string): Promise<SyncMapping | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(userId);
    req.onsuccess = () => resolve(req.result as SyncMapping | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function saveMapping(m: SyncMapping): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(m);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearMapping(userId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(userId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
