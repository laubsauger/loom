import { beforeEach, describe, expect, it } from "vitest";

import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { ProjectDocument } from "../types/graph.ts";
import { alice, contextFor, createHarness, patch, type Harness } from "./test-support.ts";
import { UnknownQueryError } from "./bus.ts";
import { attachStateSources, stateSourcesFor, type RuntimeMetricsSnapshot } from "./state-queries.ts";

/**
 * T175 (§V39): the reads an adapter needs, as bus queries.
 *
 * The agent surface took these as injected ports, which reaches the running editor and
 * nothing else. An out-of-process MCP server holds a transport: whatever the bus does not
 * publish, it cannot see.
 */

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

const context = () => contextFor(alice);

const metrics: RuntimeMetricsSnapshot = {
  timingAvailable: false,
  framesRendered: 12,
  lastFrameIndex: 11,
  frameGpuMs: null,
  passCount: 3,
  nodeCount: 4,
  prunedCount: 1,
  estimatedResourceBytes: 2048,
  memoryBudgetBytes: 4096,
  overBudget: false,
};

const project = (): Omit<ProjectDocument, "graph"> => ({
  schemaVersion: 1,
  projectId: "project-1",
  name: "Sketch",
  settings: {
    outputResolution: { width: 1280, height: 720 },
    workingFormat: "rgba16float",
    randomSeed: 7,
    previewLongEdge: 192,
    previewFps: 20,
    limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 1024, memoryBudgetBytes: 2048 },
  },
  assets: [],
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
});

describe("state queries are registered only once something can answer them", () => {
  it("does not publish a query with no source behind it", async () => {
    for (const name of ["selection.get", "diagnostics.get", "runtime.metrics", "project.get"] as const) {
      expect(harness.bus.hasQuery(name)).toBe(false);
    }
    // Honest rather than empty: "nobody is watching" must not read as "nothing is
    // selected", which is what a registered-but-unbacked query would say.
    await expect(harness.bus.query("selection.get", {}, context())).rejects.toBeInstanceOf(
      UnknownQueryError,
    );
  });

  it("publishes only the queries whose source was attached", () => {
    attachStateSources(harness.bus, { selection: () => ({ nodeIds: [], edgeIds: [] }) });
    expect(harness.bus.hasQuery("selection.get")).toBe(true);
    expect(harness.bus.hasQuery("runtime.metrics")).toBe(false);
  });

  it("replaces a source on re-attach without registering twice", () => {
    attachStateSources(harness.bus, { selection: () => ({ nodeIds: ["a"], edgeIds: [] }) });
    // A remount hands over a new closure; the bus has no unregister, so the holder is
    // what changes.
    expect(() =>
      attachStateSources(harness.bus, { selection: () => ({ nodeIds: ["b"], edgeIds: [] }) }),
    ).not.toThrow();
    expect(stateSourcesFor(harness.bus).selection?.().nodeIds).toEqual(["b"]);
  });
});

describe("each query answers what it claims", () => {
  it("selection.get returns the ids the editor holds", async () => {
    attachStateSources(harness.bus, {
      selection: () => ({ nodeIds: ["nd_1", "nd_2"], edgeIds: ["ed_1"] }),
    });
    const selection = await harness.bus.query("selection.get", {}, context());
    expect(selection).toEqual({ nodeIds: ["nd_1", "nd_2"], edgeIds: ["ed_1"] });
  });

  it("diagnostics.get filters by severity and keeps the newest N", async () => {
    const published: RuntimeDiagnostic[] = [
      { severity: "info", code: "a", message: "first" },
      { severity: "error", code: "b", message: "second" },
      { severity: "error", code: "c", message: "third" },
    ];
    attachStateSources(harness.bus, { diagnostics: () => ({ diagnostics: published, revision: 7 }) });

    const all = await harness.bus.query("diagnostics.get", {}, context());
    expect(all.diagnostics).toHaveLength(3);
    // T596: the answer is DATED. A caller that just applied revision 8 can see that this
    // list has not looked at it yet, instead of reading a clean list as approval (§V338).
    expect(all.revision).toBe(7);

    const errors = await harness.bus.query("diagnostics.get", { severity: "error" }, context());
    expect(errors.diagnostics.map((entry) => entry.code)).toEqual(["b", "c"]);

    const newest = await harness.bus.query("diagnostics.get", { limit: 1 }, context());
    expect(newest.diagnostics.map((entry) => entry.code)).toEqual(["c"]);
  });

  it("runtime.metrics passes the runtime's own snapshot through, nulls included", async () => {
    attachStateSources(harness.bus, { metrics: () => metrics });
    const snapshot = await harness.bus.query("runtime.metrics", {}, context());
    // §V86: a null millisecond figure means "no timestamp query", never zero cost — so
    // the flag travels with it rather than being inferred.
    expect(snapshot.frameGpuMs).toBeNull();
    expect(snapshot.timingAvailable).toBe(false);
    expect(snapshot.framesRendered).toBe(12);
  });

  it("project.get answers the envelope graph.get cannot, paired with the graph revision", async () => {
    attachStateSources(harness.bus, { project });
    await harness.bus.execute(
      "graph.applyPatch",
      patch(0, [{ op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } }]),
      context(),
    );

    const snapshot = await harness.bus.query("project.get", {}, context());
    expect(snapshot.name).toBe("Sketch");
    expect(snapshot.settings.randomSeed).toBe(7);
    expect(snapshot.assets).toEqual([]);
    // The revision the envelope was read at, so a caller can pair it with a graph read.
    expect(snapshot.revision).toBe(harness.store.view.getRevision());
  });
});
