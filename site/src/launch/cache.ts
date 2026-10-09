// Tiny IndexedDB key-value store for immutable on-chain data (launch logs, images). Falls back to memory.
const mem = new Map<string, unknown>();
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise(resolve => {
    try {
      const req = indexedDB.open('bunker-launch', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

export async function cget<T>(key: string): Promise<T | undefined> {
  if (mem.has(key)) return mem.get(key) as T;
  const d = await db();
  if (!d) return undefined;
  return new Promise(resolve => {
    try {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => {
        if (r.result !== undefined) mem.set(key, r.result);
        resolve(r.result as T | undefined);
      };
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function cset(key: string, value: unknown): Promise<void> {
  mem.set(key, value);
  const d = await db();
  if (!d) return;
  try {
    d.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
  } catch {
    /* quota or private mode: memory copy is enough */
  }
}
