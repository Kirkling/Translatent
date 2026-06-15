// Tiny IndexedDB wrapper for Koe/Box — persists the uploaded CBZ blob and
// per-page translation snapshots so an accidental tab close, desktop-site
// toggle, or reload doesn't wipe progress.

const DB_NAME = "koebox";
const DB_VERSION = 1;
const STORE = "files";

export type StoredRegion = {
  x: number; y: number; w: number; h: number;
  translated: string; bg: string;
  kind?: string; hasBackdrop?: boolean;
};

export type StoredPage = {
  name: string;
  status: "pending" | "processing" | "translated" | "skipped";
  regions: StoredRegion[];
};

export type StoredFile = {
  id: string;          // name + size + lastModified
  name: string;
  size: number;
  lastModified: number;
  pageCount: number;
  blob: Blob;          // original CBZ
  pages: StoredPage[]; // status + regions, sparse OK
  updatedAt: number;
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function fileId(f: { name: string; size: number; lastModified: number }) {
  return `${f.name}::${f.size}::${f.lastModified}`;
}

export async function idbPut(record: StoredFile): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore — quota or unavailable */
  }
}

export async function idbGet(id: string): Promise<StoredFile | null> {
  try {
    const db = await open();
    const out = await new Promise<StoredFile | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const r = tx.objectStore(STORE).get(id);
      r.onsuccess = () => resolve((r.result as StoredFile) || null);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return out;
  } catch {
    return null;
  }
}

export async function idbList(): Promise<StoredFile[]> {
  try {
    const db = await open();
    const out = await new Promise<StoredFile[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const r = tx.objectStore(STORE).getAll();
      r.onsuccess = () => resolve((r.result as StoredFile[]) || []);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function idbDelete(id: string): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

const LAST_KEY = "koebox:lastId";
export function setLastId(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {/* ignore */}
}
export function getLastId(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}