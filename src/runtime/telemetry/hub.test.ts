import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeId } from "../../domain/types/ids.ts";
import { TELEMETRY_TICK_MS, createTelemetryHub, telemetryPlan } from "./hub.ts";
import type { NodeMetricSink, PlanLike } from "./hub.ts";
import type { PassSpanResults, PassTimingSource } from "./types.ts";

/**
 * The metrics pipe (T41, T42, §V16, §V86).
 *
 * These tests encode WHY the pipe exists, not merely that a number moves: that a 60 Hz
 * producer cannot make the UI repaint at 60 Hz, that nothing telemetry-shaped can reach
 * the document store, and that an absent timestamp-query feature produces "unavailable"
 * rather than a confident zero.
 */

/** A controllable stand-in for the backend's vgpu timer surface. */
function fakeTimingSource(timestampQuery: boolean): PassTimingSource & {
  emit(spans: PassSpanResults): void;
  listenerCount(): number;
} {
  const listeners = new Set<(spans: PassSpanResults) => void>();
  return {
    timestampQuery,
    onPassTimings(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(spans) {
      for (const listener of [...listeners]) listener(spans);
    },
    listenerCount: () => listeners.size,
  };
}

function planOf(
  passes: ReadonlyArray<{ id: string; nodeId?: string; kind?: string }>,
  extra: Partial<PlanLike> = {},
): PlanLike {
  const nodeIds = [...new Set(passes.flatMap((p) => (p.nodeId === undefined ? [] : [p.nodeId])))];
  return {
    passes: passes.map((p) => ({
      id: p.id,
      kind: p.kind ?? "effect",
      ...(p.nodeId === undefined ? {} : { nodeId: p.nodeId }),
    })),
    resources: [{}, {}],
    order: nodeIds,
    pruned: [],
    sources: [],
    estimatedResourceBytes: 1024,
    ...extra,
  };
}

let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advances the injected clock and the fake timer queue together. */
function advance(ms: number): void {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

describe("§V16 — the UI is notified at most 10 times a second", () => {
  it("coalesces a 60 Hz frame burst into <= 10 notifications per second", () => {
    const hub = createTelemetryHub({ now });
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));

    let notifications = 0;
    hub.subscribe(() => {
      notifications += 1;
    });

    // One second of 60 fps: 60 producer pushes, each advancing the clock ~16.67 ms.
    for (let frame = 0; frame < 60; frame += 1) {
      hub.noteFrame(frame);
      advance(1000 / 60);
    }

    // <= 10 Hz is the cap, so at most 11 flushes can land inside a 1000 ms window
    // (the leading one plus one per 100 ms). Anything more is a §V16 violation.
    expect(notifications).toBeGreaterThan(0);
    expect(notifications).toBeLessThanOrEqual(11);
    hub.dispose();
  });

  it("never notifies twice inside one tick interval", () => {
    const hub = createTelemetryHub({ now });
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));

    const at: number[] = [];
    hub.subscribe(() => at.push(clock));

    for (let frame = 0; frame < 200; frame += 1) {
      hub.noteFrame(frame);
      advance(5);
    }

    expect(at.length).toBeGreaterThan(1);
    for (let index = 1; index < at.length; index += 1) {
      const previous = at[index - 1] ?? 0;
      const current = at[index] ?? 0;
      expect(current - previous).toBeGreaterThanOrEqual(TELEMETRY_TICK_MS);
    }
    hub.dispose();
  });

  it("does not notify when nothing changed", () => {
    const hub = createTelemetryHub({ now });
    let notifications = 0;
    hub.subscribe(() => {
      notifications += 1;
    });
    advance(1000);
    expect(notifications).toBe(0);
    hub.dispose();
  });

  it("keeps a snapshot stable between ticks so useSyncExternalStore cannot loop", () => {
    const hub = createTelemetryHub({ now });
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));
    advance(TELEMETRY_TICK_MS);

    const first = hub.snapshot();
    expect(hub.snapshot()).toBe(first);

    hub.noteFrame(1);
    // Still the same object until the tick lands: a consumer polling in between must not
    // see a new identity, or React would re-render at producer rate.
    expect(hub.snapshot()).toBe(first);

    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot()).not.toBe(first);
    hub.dispose();
  });
});

describe("§V16 — telemetry never reaches the document store", () => {
  it("publishes only to the injected per-node sink, and only gpuMs", () => {
    const published: Array<[NodeId, { gpuMs?: number | null }]> = [];
    const sink: NodeMetricSink = {
      publish: (nodeId, patch) => published.push([nodeId, patch]),
    };
    const hub = createTelemetryHub({ now, sink });
    const timing = fakeTimingSource(true);
    hub.attachTimingSource(timing);
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));
    timing.emit({ p1: 2.5 });
    advance(TELEMETRY_TICK_MS);

    expect(published).toEqual([["blur", { gpuMs: 2.5 }]]);
    // The patch shape is the whole guarantee: it can carry a metric and structurally
    // cannot carry a document mutation. There is no bus, no store and no patch here.
    for (const [, patch] of published) expect(Object.keys(patch)).toEqual(["gpuMs"]);
    hub.dispose();
  });

  it("imports nothing from the domain command bus or graph store", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./hub.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/domain\/commands/);
    expect(source).not.toMatch(/domain\/graph/);
    expect(source).not.toMatch(/applyPatch|execute\(/);
  });
});

describe("§V86 — timing comes from GPU spans or reads unavailable", () => {
  it("reports 'unavailable', not 0, when the device has no timestamp query", () => {
    const hub = createTelemetryHub({ now });
    hub.attachTimingSource(fakeTimingSource(false));
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));
    advance(TELEMETRY_TICK_MS);

    const snapshot = hub.snapshot();
    expect(snapshot.timingAvailable).toBe(false);
    expect(snapshot.frame.availability).toBe("unavailable");
    expect(snapshot.frame.gpuMs).toBeNull();
    // The counts are still real; it is only the duration that does not exist.
    expect(snapshot.frame.passCount).toBe(1);
    expect(snapshot.passes[0]?.availability).toBe("unavailable");
    expect(snapshot.passes[0]?.gpuMs).toBeNull();
    expect(hub.nodeTelemetry("blur").own.gpuMs).toBeNull();
    expect(hub.nodeTelemetry("blur").own.availability).toBe("unavailable");
    hub.dispose();
  });

  it("distinguishes 'pending' (supported, nothing measured yet) from 'unavailable'", () => {
    const hub = createTelemetryHub({ now });
    hub.attachTimingSource(fakeTimingSource(true));
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));
    advance(TELEMETRY_TICK_MS);

    expect(hub.snapshot().passes[0]?.availability).toBe("pending");
    expect(hub.snapshot().passes[0]?.gpuMs).toBeNull();
    hub.dispose();
  });

  it("never invents a duration from frame counting", () => {
    const hub = createTelemetryHub({ now });
    hub.attachTimingSource(fakeTimingSource(true));
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));
    for (let frame = 0; frame < 30; frame += 1) {
      hub.noteFrame(frame);
      advance(16);
    }
    // 30 frames of wall clock have gone by and no span has landed: still no number.
    expect(hub.snapshot().frame.gpuMs).toBeNull();
    expect(hub.snapshot().framesRendered).toBe(30);
    hub.dispose();
  });
});

describe("per-pass spans map to the node that owns the pass", () => {
  it("attributes each span to its own node and sums a node's passes", () => {
    const hub = createTelemetryHub({ now });
    const timing = fakeTimingSource(true);
    hub.attachTimingSource(timing);
    hub.setPlan(
      telemetryPlan(
        planOf([
          { id: "blur:pass0", nodeId: "blur" },
          { id: "blur:pass1", nodeId: "blur" },
          { id: "solid:pass0", nodeId: "solid" },
          { id: "swap:0", kind: "swap" },
        ]),
      ),
    );
    timing.emit({ "blur:pass0": 1.5, "blur:pass1": 0.5, "solid:pass0": 4 });
    advance(TELEMETRY_TICK_MS);

    expect(hub.nodeTelemetry("blur").own.gpuMs).toBeCloseTo(2);
    expect(hub.nodeTelemetry("blur").own.passCount).toBe(2);
    expect(hub.nodeTelemetry("solid").own.gpuMs).toBeCloseTo(4);
    expect(hub.snapshot().frame.gpuMs).toBeCloseTo(6);

    // A swap pass belongs to no node and must not be attributed to one.
    const swap = hub.snapshot().passes.find((row) => row.passId === "swap:0");
    expect(swap?.nodeId).toBeNull();
  });

  it("drops spans belonging to a plan that no longer exists", () => {
    const hub = createTelemetryHub({ now });
    const timing = fakeTimingSource(true);
    hub.attachTimingSource(timing);
    hub.setPlan(telemetryPlan(planOf([{ id: "blur:pass0", nodeId: "blur" }])));
    timing.emit({ "blur:pass0": 3 });
    advance(TELEMETRY_TICK_MS);
    expect(hub.nodeTelemetry("blur").own.gpuMs).toBeCloseTo(3);

    // Recompile: the blur pass is gone. Its old cost must not be reported against the
    // new plan, and must not resurface if a pass id is later reused.
    hub.setPlan(telemetryPlan(planOf([{ id: "solid:pass0", nodeId: "solid" }])));
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().passes.map((row) => row.passId)).toEqual(["solid:pass0"]);
    expect(hub.snapshot().frame.availability).toBe("pending");
    hub.dispose();
  });
});

describe("frame counters (TD Info CHOP analogues)", () => {
  it("counts frames per node and reports cooked-this-frame", () => {
    const hub = createTelemetryHub({ now });
    hub.attachTimingSource(fakeTimingSource(true));
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));

    hub.noteFrame(10);
    hub.noteFrame(11);
    advance(TELEMETRY_TICK_MS);

    const node = hub.nodeTelemetry("blur");
    expect(node.framesRendered).toBe(2);
    expect(node.lastRenderedFrame).toBe(11);
    expect(node.renderedThisFrame).toBe(true);

    // A node with no pass in the plan is not rendering, and says so with 0/null.
    const absent = hub.nodeTelemetry("not-in-plan");
    expect(absent.framesRendered).toBe(0);
    expect(absent.lastRenderedFrame).toBeNull();
    expect(absent.renderedThisFrame).toBe(false);
    hub.dispose();
  });
});

describe("plan facts (T41)", () => {
  it("surfaces resource count, estimated bytes and the memory budget verdict", () => {
    const hub = createTelemetryHub({ now });
    hub.setPlan(
      telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }], { estimatedResourceBytes: 2048 }), {
        memoryBudgetBytes: 1024,
      }),
    );
    advance(TELEMETRY_TICK_MS);

    const snapshot = hub.snapshot();
    expect(snapshot.plan?.resourceCount).toBe(2);
    expect(snapshot.plan?.estimatedResourceBytes).toBe(2048);
    expect(snapshot.overBudget).toBe(true);
    hub.dispose();
  });

  it("carries BackendStatus.lastBuild reuse accounting", () => {
    const hub = createTelemetryHub({ now });
    hub.setBuild({ resourcesCreated: 1, resourcesReused: 3, effectsBuilt: 2, effectsReused: 5 });
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().build).toEqual({
      resourcesCreated: 1,
      resourcesReused: 3,
      effectsBuilt: 2,
      effectsReused: 5,
    });
    hub.dispose();
  });
});

describe("lifecycle", () => {
  it("detaching a timing source unsubscribes and stops reporting durations", () => {
    const hub = createTelemetryHub({ now });
    const timing = fakeTimingSource(true);
    const detach = hub.attachTimingSource(timing);
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));
    timing.emit({ p1: 1 });
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().frame.gpuMs).toBeCloseTo(1);

    detach();
    advance(TELEMETRY_TICK_MS);
    expect(timing.listenerCount()).toBe(0);
    expect(hub.snapshot().timingAvailable).toBe(false);
    expect(hub.snapshot().frame.gpuMs).toBeNull();
    hub.dispose();
  });

  it("dispose stops the tick and drops listeners", () => {
    const hub = createTelemetryHub({ now });
    let notifications = 0;
    hub.subscribe(() => {
      notifications += 1;
    });
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));
    hub.dispose();
    advance(1000);
    expect(notifications).toBe(0);
  });
});
