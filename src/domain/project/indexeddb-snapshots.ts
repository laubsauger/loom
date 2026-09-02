import type { SnapshotMeta, SnapshotRecord, SnapshotStore } from "./autosave.ts";

/**
 * Browser SnapshotStore over IndexedDB (T101). Storage adapter only — every policy
 * decision (debounce, ring, pinning) lives in the headless modules this feeds.
 *
 * Returns undefined when IndexedDB is unavailable (some private modes, non-browser
 * contexts): the composition root then runs without autosave and should surface that
 * as a diagnostic rather than crashing (§Rule 8 — fail loud, not silently).
 */

// §V813: the `shaderloom` prefix is a STORAGE ADDRESS, not a name — renaming it orphans every user's saved state for zero visible benefit. The product renamed to Loom (§T899); this key deliberately did not.
const DB_NAME = "shaderloom.autosave";
const STORE = "snapshots";

export function createIndexedDbSnapshotStore(): SnapshotStore | undefined {
  if (typeof indexedDB === "undefined") return undefined;

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: ["projectId", "key"] });
          store.createIndex("byProject", "projectId");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });

  const withStore = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      });
    } finally {
      db.close();
    }
  };

  return {
    async list(projectId: string): Promise<SnapshotMeta[]> {
      const records = await withStore<SnapshotRecord[]>("readonly", (store) =>
        store.index("byProject").getAll(projectId),
      );
      return records.map(({ key, revision, savedAt, pinned }) => ({ key, revision, savedAt, pinned }));
    },
    async get(projectId: string, key: string): Promise<SnapshotRecord | undefined> {
      const record = await withStore<SnapshotRecord | undefined>("readonly", (store) =>
        store.get([projectId, key]) as IDBRequest<SnapshotRecord | undefined>,
      );
      return record ?? undefined;
    },
    async put(record: SnapshotRecord): Promise<void> {
      await withStore("readwrite", (store) => store.put(record));
    },
    async delete(projectId: string, key: string): Promise<void> {
      await withStore("readwrite", (store) => store.delete([projectId, key]));
    },
  };
}
