import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeId } from "../../domain/types/ids.ts";
import { TELEMETRY_TICK_MS, createTelemetryHub, telemetryPlan } from "./hub.ts";
import type { NodeMetricSink, PlanLike } from "./hub.ts";
import type { FrameSpanExtent, PassSpanResults, PassTimingSource } from "./types.ts";

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
  emit(spans: PassSpanResults, frame?: FrameSpanExtent): void;
  drop(): void;
  listenerCount(): number;
} {
  const listeners = new Set<(spans: PassSpanResults, frame?: FrameSpanExtent) => void>();
  const dropListeners = new Set<() => void>();
  return {
    timestampQuery,
    onPassTimings(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onTimingsDropped(listener) {
      const once = () => listener({ submit: null, reason: "staging-busy", spans: 1 });
      dropListeners.add(once);
      return () => dropListeners.delete(once);
    },
    emit(spans, frame) {
      for (const listener of [...listeners]) listener(spans, frame);
    },
    drop() {
      for (const listener of [...dropListeners]) listener();
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
    resources: [
      { id: "target:a:out", kind: "target" },
      { id: "target:b:out", kind: "target" },
    ],
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

describe("T1295 — a lost frame is counted on the frame figure, not left as an absence", () => {
  it("counts drops beside a measured frame, and forgets them with the plan they belong to", () => {
    const hub = createTelemetryHub({ now });
    const timing = fakeTimingSource(true);
    hub.attachTimingSource(timing);
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));
    timing.emit({ p1: 2.5 }, { gpuMs: 2.5, submit: 1 });
    advance(TELEMETRY_TICK_MS);
    // Nothing lost: the figure is whole and says so with a zero, not an absent field.
    expect(hub.snapshot().frame.droppedFrames).toBe(0);

    timing.drop();
    timing.drop();
    advance(TELEMETRY_TICK_MS);
    const partial = hub.snapshot().frame;
    // The measured figure is still shown — it is a real duration (§V86) — but it now
    // carries how many frames it is NOT describing.
    expect(partial.availability).toBe("measured");
    expect(partial.gpuMs).toBe(2.5);
    expect(partial.droppedFrames).toBe(2);

    // A new plan's figure owes nothing to the old plan's losses.
    hub.setPlan(telemetryPlan(planOf([{ id: "p2", nodeId: "blur" }])));
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().frame.droppedFrames).toBe(0);
    hub.dispose();
  });

  it("stops counting once the source is detached", () => {
    const hub = createTelemetryHub({ now });
    const timing = fakeTimingSource(true);
    const detach = hub.attachTimingSource(timing);
    hub.setPlan(telemetryPlan(planOf([{ id: "p1", nodeId: "blur" }])));
    detach();
    timing.drop();
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().frame.droppedFrames).toBe(0);
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

  it("sums a substepped pass's per-iteration spans onto the pass (T387, §V86)", () => {
    // T387: a pass inside a substep loop is encoded once per iteration and reports one
    // span per iteration, because vgpu refuses a duplicate span NAME inside a frame. The
    // node's row has to show what the loop actually cost — keeping only the first span
    // would report a 20-substep reaction-diffusion as costing one step, which is a node
    // that reads cheap and is not, and the exact reason someone would raise Substeps
    // without ever seeing the frame time they bought.
    const published: Array<[NodeId, { gpuMs?: number | null }]> = [];
    const sink: NodeMetricSink = { publish: (nodeId, patch) => published.push([nodeId, patch]) };
    const hub = createTelemetryHub({ now, sink });
    const timing = fakeTimingSource(true);
    hub.attachTimingSource(timing);
    hub.setPlan(telemetryPlan(planOf([{ id: "rd:custom", nodeId: "rd" }])));
    timing.emit({ "rd:custom": 0.5, "rd:custom~1": 0.5, "rd:custom~2": 0.5, "rd:custom~3": 0.5 });
    advance(TELEMETRY_TICK_MS);

    expect(published).toEqual([["rd", { gpuMs: 2 }]]);
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

describe("noteFrame's ran set (T255, §V85)", () => {
  it("marks ONLY the nodes that actually ran; absent means the whole plan did", () => {
    const hub = createTelemetryHub({ now });
    hub.setPlan(
      telemetryPlan(
        planOf([
          { id: "a#p", nodeId: "a" },
          { id: "b#p", nodeId: "b" },
        ]),
      ),
    );

    hub.noteFrame(1, new Set(["a"]));
    expect(hub.nodeTelemetry("a").renderedThisFrame).toBe(true);
    // The gated node is NOT lied about — this is the seam T254's cook gate feeds.
    expect(hub.nodeTelemetry("b").renderedThisFrame).toBe(false);

    hub.noteFrame(2);
    expect(hub.nodeTelemetry("b").renderedThisFrame).toBe(true); // absent = all ran
  });
});

describe("T304 — the hub remembers when frames happened", () => {
  it("noteFrame accumulates recent timestamps and prunes old ones", () => {
    const hub = createTelemetryHub();
    expect(hub.recentFrameTimes()).toEqual([]);
    hub.noteFrame(0);
    hub.noteFrame(1);
    const times = hub.recentFrameTimes();
    expect(times).toHaveLength(2);
    // Monotonic and recent — the verdict's window can trust them.
    expect(times[1]).toBeGreaterThanOrEqual(times[0] ?? 0);
    const now = typeof performance === "undefined" ? Date.now() : performance.now();
    for (const at of times) expect(now - at).toBeLessThan(1000);
  });
});

/**
 * T1243 — THE FRAME FIGURE IS THE FRAME'S EXTENT, NOT THE SUM OF ITS PASSES.
 *
 * On Dawn/Metal the per-pass spans nest (every pass begins near the command buffer's
 * start), so their sum read ~10× the presented frame. The backend now delivers the
 * frame's extent beside the spans; this pins the bucket arithmetic on a hand-driven
 * source, where the numbers can be chosen so that the two figures are unmistakably
 * different — a sum that happened to equal the extent would pass the old code too.
 */
describe("T1243 — the frame bucket is the submitted frame's extent", () => {
  const passes = [
    { id: "a:p0", nodeId: "a" },
    { id: "b:p0", nodeId: "b" },
    { id: "c:p0", nodeId: "c" },
  ];

  it("reports the extent as gpuMs, labelled, and keeps the per-pass sum beside it", () => {
    const hub = createTelemetryHub({ now });
    const timing = fakeTimingSource(true);
    hub.attachTimingSource(timing);
    hub.setPlan(telemetryPlan(planOf(passes)));
    // Nested spans as Apple reports them: 1, 2, 3 ms from a common start = a 3 ms frame.
    timing.emit({ "a:p0": 1, "b:p0": 2, "c:p0": 3 }, { gpuMs: 3, submit: 7 });
    advance(TELEMETRY_TICK_MS);

    const frame = hub.snapshot().frame;
    expect(frame.availability).toBe("measured");
    expect(frame.basis).toBe("frame");
    expect(frame.gpuMs).toBeCloseTo(3);
    expect(frame.passSumMs).toBeCloseTo(6);
    // The per-pass column is untouched: every span is still its own duration.
    expect(hub.snapshot().passes.map((row) => row.gpuMs)).toEqual([1, 2, 3]);
    expect(hub.nodeTelemetry("c").own.gpuMs).toBeCloseTo(3);
    hub.dispose();
  });

  it("adds the halves of one segmented render (same submit) and replaces on the next", () => {
    const hub = createTelemetryHub({ now });
    const timing = fakeTimingSource(true);
    hub.attachTimingSource(timing);
    hub.setPlan(telemetryPlan(planOf(passes)));
    // The direct path splits a render around a compute dispatch: two vgpu frames, one
    // submit number. Their extents add; their spans land on different passes.
    timing.emit({ "a:p0": 1 }, { gpuMs: 1.25, submit: 3 });
    timing.emit({ "b:p0": 2, "c:p0": 0.5 }, { gpuMs: 2, submit: 3 });
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().frame.gpuMs).toBeCloseTo(3.25);
    expect(hub.snapshot().frame.passSumMs).toBeCloseTo(3.5);

    // The next submit is a new frame — nothing carries over from the last one.
    timing.emit({ "a:p0": 1, "b:p0": 2, "c:p0": 0.5 }, { gpuMs: 2.5, submit: 4 });
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().frame.gpuMs).toBeCloseTo(2.5);

    // A frame the source could not tie to a submit stands alone, twice.
    timing.emit({ "a:p0": 1 }, { gpuMs: 0.75, submit: null });
    timing.emit({ "a:p0": 1 }, { gpuMs: 0.5, submit: null });
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().frame.gpuMs).toBeCloseTo(0.5);
    hub.dispose();
  });

  it("falls back to the labelled per-pass sum when the source delivers no extent", () => {
    const hub = createTelemetryHub({ now });
    const timing = fakeTimingSource(true);
    hub.attachTimingSource(timing);
    hub.setPlan(telemetryPlan(planOf(passes)));
    timing.emit({ "a:p0": 1, "b:p0": 2, "c:p0": 3 });
    advance(TELEMETRY_TICK_MS);
    const frame = hub.snapshot().frame;
    expect(frame.basis).toBe("passes");
    expect(frame.gpuMs).toBeCloseTo(6);
    expect(frame.passSumMs).toBeCloseTo(6);
    hub.dispose();
  });

  it("drops the extent with the plan it was measured under", () => {
    const hub = createTelemetryHub({ now });
    const timing = fakeTimingSource(true);
    hub.attachTimingSource(timing);
    hub.setPlan(telemetryPlan(planOf(passes)));
    timing.emit({ "a:p0": 1, "b:p0": 2, "c:p0": 3 }, { gpuMs: 3, submit: 1 });
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().frame.gpuMs).toBeCloseTo(3);

    hub.setPlan(telemetryPlan(planOf([{ id: "d:p0", nodeId: "d" }])));
    advance(TELEMETRY_TICK_MS);
    // No span and no extent for the new plan yet: pending, not the old frame's number.
    expect(hub.snapshot().frame.availability).toBe("pending");
    expect(hub.snapshot().frame.gpuMs).toBeNull();
    hub.dispose();
  });
});

describe("T1254 — the per-frame compile's reason reaches the snapshot", () => {
  it("carries the compiler's sentence, null by default, and a repeat notifies nobody", () => {
    const hub = createTelemetryHub({ now });
    let notified = 0;
    hub.subscribe(() => {
      notified += 1;
    });
    expect(hub.snapshot().frameCompileReason).toBeNull();

    hub.setFrameCompileReason('Node "cache1" (cache) animates "frames"');
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().frameCompileReason).toBe('Node "cache1" (cache) animates "frames"');
    const after = notified;

    // The hook publishes on every prepared compiler — one per revision during a knob
    // drag — and the same sentence again must not wake the pane (§V16).
    hub.setFrameCompileReason('Node "cache1" (cache) animates "frames"');
    advance(TELEMETRY_TICK_MS * 2);
    expect(notified).toBe(after);

    hub.setFrameCompileReason(null);
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().frameCompileReason).toBeNull();
    expect(notified).toBe(after + 1);
  });
});
