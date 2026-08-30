import { describe, expect, it } from "vitest";

import type { ProjectDocument } from "../types/graph.ts";
import {
  createAutosave,
  findRestoreCandidate,
  type SnapshotRecord,
  type SnapshotStore,
} from "./autosave.ts";
import { parseProjectDocument, serializeProjectDocument } from "./serialize.ts";
import { planRetention, type SnapshotMeta } from "./snapshot-ring.ts";
import { SCHEMA_VERSION } from "../types/schemas.ts";

/**
 * T101: autosave = same serialized document as a save (one serializer, §V10),
 * debounced ring with periodic pinned snapshots, all headless with injected storage,
 * clock and timers.
 */

function makeDocument(revision: number): ProjectDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "project-1",
    name: "Test",
    graph: { revision, nodes: {}, edges: {}, groups: {} },
    settings: {
      outputResolution: { width: 1920, height: 1080 },
      workingFormat: "rgba8unorm",
      randomSeed: 7,
      previewLongEdge: 192,
      previewFps: 30,
      limits: { maxResolution: 8192, maxDispatch: 65535, maxBufferBytes: 1 << 28, memoryBudgetBytes: 1 << 30 },
    },
    assets: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function memoryStore(): SnapshotStore & { records: Map<string, SnapshotRecord> } {
  const records = new Map<string, SnapshotRecord>();
  return {
    records,
    list: async (projectId) =>
      [...records.values()]
        .filter((r) => r.projectId === projectId)
        .map(({ key, revision, savedAt, pinned }) => ({ key, revision, savedAt, pinned })),
    get: async (projectId, key) => {
      const record = records.get(key);
      return record?.projectId === projectId ? record : undefined;
    },
    put: async (record) => void records.set(record.key, record),
    delete: async (_projectId, key) => void records.delete(key),
  };
}

/** Deterministic manual timer: collects callbacks, fired explicitly. */
function manualTimers() {
  let next = 0;
  const timers = new Map<number, () => void>();
  return {
    setTimer: (cb: () => void): unknown => {
      timers.set((next += 1), cb);
      return next;
    },
    clearTimer: (handle: unknown): void => void timers.delete(handle as number),
    fireAll: (): void => {
      const pending = [...timers.values()];
      timers.clear();
      for (const cb of pending) cb();
    },
    count: (): number => timers.size,
  };
}

describe("one serializer for save and snapshot (§V10)", () => {
  it("round-trips a document byte-identically and deterministically", () => {
    const doc = makeDocument(3);
    const text = serializeProjectDocument(doc);
    const parsed = parseProjectDocument(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeProjectDocument(parsed.document)).toBe(text);
    // Key order is canonical: a reordered input document serializes the same.
    const reordered = { ...doc, name: doc.name, projectId: doc.projectId };
    expect(serializeProjectDocument(reordered)).toBe(text);
  });

  it("rejects invalid text with a reason instead of throwing", () => {
    expect(parseProjectDocument("not json").ok).toBe(false);
    const missing = parseProjectDocument("{}");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).not.toBe("");
  });
});

describe("retention ring", () => {
  const meta = (key: string, savedAt: number, pinned = false): SnapshotMeta => ({
    key,
    revision: savedAt,
    savedAt,
    pinned,
  });

  it("pins the first snapshot and then one per interval", () => {
    const first = planRetention([], { key: "a", revision: 1, savedAt: 0 });
    expect(first.pinIncoming).toBe(true);

    const soon = planRetention([meta("a", 0, true)], { key: "b", revision: 2, savedAt: 60_000 });
    expect(soon.pinIncoming).toBe(false);

    const later = planRetention([meta("a", 0, true)], { key: "c", revision: 3, savedAt: 10 * 60_000 });
    expect(later.pinIncoming).toBe(true);
  });

  it("evicts unpinned snapshots beyond the ring while pinned ones survive", () => {
    const existing = [
      meta("pin", 0, true),
      ...Array.from({ length: 20 }, (_, i) => meta(`u${i}`, 1000 + i)),
    ];
    const plan = planRetention(existing, { key: "new", revision: 99, savedAt: 5000 });
    // 21 unpinned candidates for 20 slots: the oldest unpinned goes, the pin stays.
    expect(plan.evictKeys).toEqual(["u0"]);
  });

  it("caps pinned snapshots, evicting the oldest pin first", () => {
    const pins = Array.from({ length: 48 }, (_, i) => meta(`p${i}`, i * 10 * 60_000, true));
    const plan = planRetention(pins, { key: "new", revision: 1, savedAt: 48 * 10 * 60_000 });
    expect(plan.pinIncoming).toBe(true);
    expect(plan.evictKeys).toEqual(["p0"]);
  });
});

describe("autosave scheduler", () => {
  it("debounces: many mutations produce one snapshot after quiet", async () => {
    const store = memoryStore();
    const timers = manualTimers();
    let revision = 0;
    const autosave = createAutosave({
      store,
      getDocument: () => makeDocument(revision),
      now: () => 1000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    for (let i = 1; i <= 10; i += 1) {
      revision = i;
      autosave.notifyChange();
    }
    expect(store.records.size).toBe(0); // nothing until the debounce fires
    expect(timers.count()).toBe(1); // earlier timers were cleared, not stacked

    timers.fireAll();
    await autosave.flush();
    expect(store.records.size).toBe(1);
    const record = [...store.records.values()][0];
    expect(record?.revision).toBe(10);
    // The snapshot body is exactly what a manual save would write.
    expect(record?.body).toBe(serializeProjectDocument(makeDocument(10)));
  });

  it("skips the write when the newest snapshot already has this revision", async () => {
    const store = memoryStore();
    const timers = manualTimers();
    const autosave = createAutosave({
      store,
      getDocument: () => makeDocument(5),
      now: () => 1000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    autosave.notifyChange();
    timers.fireAll();
    await autosave.flush();
    autosave.notifyChange();
    timers.fireAll();
    await autosave.flush();
    expect(store.records.size).toBe(1);
  });

  it("routes storage failures to onError instead of throwing", async () => {
    const failing: SnapshotStore = {
      list: async () => [],
      get: async () => undefined,
      put: async () => {
        throw new Error("quota exceeded");
      },
      delete: async () => undefined,
    };
    const timers = manualTimers();
    const errors: unknown[] = [];
    const autosave = createAutosave({
      store: failing,
      getDocument: () => makeDocument(1),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onError: (error) => errors.push(error),
    });

    autosave.notifyChange();
    timers.fireAll();
    await autosave.flush();
    expect(errors).toHaveLength(1);
  });

  it("flush writes a pending snapshot without waiting for the timer", async () => {
    const store = memoryStore();
    const timers = manualTimers();
    const autosave = createAutosave({
      store,
      getDocument: () => makeDocument(2),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    autosave.notifyChange();
    await autosave.flush();
    expect(store.records.size).toBe(1);
    expect(timers.count()).toBe(0);
  });

  it("offers the newest snapshot as the restore candidate", async () => {
    const store = memoryStore();
    const timers = manualTimers();
    let clock = 1000;
    let revision = 1;
    const autosave = createAutosave({
      store,
      getDocument: () => makeDocument(revision),
      now: () => clock,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    autosave.notifyChange();
    timers.fireAll();
    await autosave.flush();
    clock = 2000;
    revision = 7;
    autosave.notifyChange();
    timers.fireAll();
    await autosave.flush();

    const candidate = await findRestoreCandidate(store, "project-1");
    expect(candidate?.meta.revision).toBe(7);
    const parsed = candidate === undefined ? undefined : parseProjectDocument(candidate.record.body);
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) expect(parsed.document.graph.revision).toBe(7);
    expect(await findRestoreCandidate(store, "other-project")).toBeUndefined();
  });
});
