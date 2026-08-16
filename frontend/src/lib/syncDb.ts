// 로컬 연동 매핑을 IndexedDB에 저장 (사용자당 여러 개).
// FileSystemDirectoryHandle은 structured-clone 가능 → IndexedDB에 그대로 저장.

const DB_NAME = "server-sync";
const STORE = "mappings";
const VERSION = 2; // v1: 사용자당 1개(keyPath userId) → v2: 여러 개(keyPath id)


export interface SyncMapping {
  id: string;
  userId: string;
  handle: any; // FileSystemDirectoryHandle
  path: string; // 웹 폴더 상대경로
  uploaded: string[]; // 이 매핑이 웹에 업로드한 파일 rel 목록(해제 시 삭제 추적용)
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 스토어(keyPath userId)가 있으면 제거하고 새 구조로 재생성
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listMappings(userId: string): Promise<SyncMapping[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () =>
      resolve((req.result as SyncMapping[]).filter((m) => m.userId === userId));
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

export async function deleteMapping(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
