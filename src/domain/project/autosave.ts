import type { ProjectDocument } from "../types/graph.ts";
import { serializeProjectDocument } from "./serialize.ts";
import { planRetention, type RetentionOptions, type SnapshotMeta } from "./snapshot-ring.ts";

export type { SnapshotMeta } from "./snapshot-ring.ts";

/**
 * Autosave scheduler (T101): debounces mutations, then writes a snapshot through the
 * one project serializer and applies the retention ring.
 *
 * Headless by construction: storage, clock and timers are injected, so the whole flow
 * runs under vitest with fakes. The IndexedDB adapter lives separately in
 * `indexeddb-snapshots.ts` and is wired in by the composition root, which subscribes
 * this to the graph store and drives the restore-on-launch prompt from
 * `findRestoreCandidate`.
 */

export interface SnapshotRecord extends SnapshotMeta {
  projectId: string;
  /** Exactly what `serializeProjectDocument` returned — a save writes the same bytes. */
  body: string;
}

/** Async storage seam; implemented over IndexedDB in the browser, a Map in tests. */
export interface SnapshotStore {
  list(projectId: string): Promise<SnapshotMeta[]>;
  get(projectId: string, key: string): Promise<SnapshotRecord | undefined>;
  put(record: SnapshotRecord): Promise<void>;
  delete(projectId: string, key: string): Promise<void>;
}

export interface AutosaveOptions {
  store: SnapshotStore;
  /** Returns the current document; called only when a debounced write actually fires. */
  getDocument: () => ProjectDocument;
  debounceMs?: number;
  retention?: RetentionOptions;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Storage failures land here (quota, private mode); autosave must never throw into the store subscription. */
  onError?: (error: unknown) => void;
}

export interface Autosave {
  /** Call on every committed mutation; the write fires `debounceMs` after the last one. */
  notifyChange(): void;
  /** Force any pending write now (call before manual save/close). */
  flush(): Promise<void>;
  dispose(): void;
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const debounceMs = options.debounceMs ?? 2000;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  const onError = options.onError ?? (() => undefined);

  let pending: unknown = null;
  let disposed = false;
  let writing: Promise<void> = Promise.resolve();

  async function write(): Promise<void> {
    const document = options.getDocument();
    const savedAt = now();
    const revision = document.graph.revision;
    const record: SnapshotRecord = {
      key: `${savedAt}-r${revision}`,
      projectId: document.projectId,
      revision,
      savedAt,
      pinned: false,
      body: serializeProjectDocument(document),
    };

    const existing = await options.store.list(document.projectId);
    // Nothing changed since the last snapshot: skip the write entirely.
    const newest = existing.reduce<SnapshotMeta | undefined>(
      (best, meta) => (best === undefined || meta.savedAt > best.savedAt ? meta : best),
      undefined,
    );
    if (newest !== undefined && newest.revision === revision) return;

    const plan = planRetention(existing, record, options.retention);
    record.pinned = plan.pinIncoming;
    await options.store.put(record);
    for (const key of plan.evictKeys) await options.store.delete(document.projectId, key);
  }

  function fire(): void {
    pending = null;
    writing = write().catch(onError);
  }

  return {
    notifyChange(): void {
      if (disposed) return;
      if (pending !== null) clearTimer(pending);
      pending = setTimer(fire, debounceMs);
    },
    async flush(): Promise<void> {
      if (pending !== null) {
        clearTimer(pending);
        fire();
      }
      await writing;
    },
    dispose(): void {
      disposed = true;
      if (pending !== null) clearTimer(pending);
      pending = null;
    },
  };
}

export interface RestoreCandidate {
  meta: SnapshotMeta;
  record: SnapshotRecord;
}

/**
 * Newest snapshot for a project — the restore-on-launch prompt offers it when its
 * revision is ahead of (or the caller has no) last explicitly-saved document.
 */
export async function findRestoreCandidate(
  store: SnapshotStore,
  projectId: string,
): Promise<RestoreCandidate | undefined> {
  const metas = await store.list(projectId);
  const newest = metas.reduce<SnapshotMeta | undefined>(
    (best, meta) => (best === undefined || meta.savedAt > best.savedAt ? meta : best),
    undefined,
  );
  if (newest === undefined) return undefined;
  const record = await store.get(projectId, newest.key);
  return record === undefined ? undefined : { meta: newest, record };
}
