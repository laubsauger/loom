import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeId } from "../../domain/types/ids.ts";
import { UNCATEGORISED, categoryRollups, nodeCostRows } from "./cost.ts";
import type { CostInput } from "./cost.ts";
import { TELEMETRY_TICK_MS, createTelemetryHub, telemetryPlan } from "./hub.ts";
import type { CpuSpanResults, CpuTimingSource, PassSpanResults, PassTimingSource } from "./types.ts";

/**
 * Per-node CPU + GPU cost with category rollups (T256, §V86).
 *
 * The property that matters is not "it adds up". It is that an ABSENT measurement never
 * becomes a zero, anywhere on the path — per node, per category, or in a total that mixes
 * measured and unmeasured nodes. `timestamp-query` is unavailable on real devices (headless
 * Dawn reports it as an info diagnostic, so a build looks healthy and measures nothing), and
 * a zero in that cell reads as FREE. Someone then optimises the node above it.
 */

const pass = (id: string, nodeId: NodeId, label: string | null = null) => ({
  id,
  kind: "effect",
  nodeId,
  label,
});

function input(over: Partial<CostInput> = {}): CostInput {
  return {
    passes: [
      pass("blur:p0", "blur1"),
      pass("blur:p1", "blur1"),
      pass("noise:p0", "noise1"),
      pass("over:p0", "over1"),
    ],
    sources: [],
    gpuSpans: new Map([
      ["blur:p0", 2],
      ["blur:p1", 3],
      ["noise:p0", 1],
      ["over:p0", 0.5],
    ]),
    cpuSpans: new Map([
      ["blur:p0", 0.2],
      ["blur:p1", 0.3],
      ["noise:p0", 0.1],
      ["over:p0", 0.4],
    ]),
    gpuAvailable: true,
    cpuAvailable: true,
    categories: new Map([
      ["blur1", "filter"],
      ["noise1", "generator"],
      ["over1", "composite"],
    ]),
    ...over,
  };
}

describe("a node's cost is both halves, on one row (T256)", () => {
  it("sums a node's passes — the row's unit is the NODE, not the pass", () => {
    const blur = nodeCostRows(input()).find((row) => row.nodeId === "blur1");
    // A Blur is two passes sharing a node-private scratch; a profiler that lists them
    // separately makes the user add them up to answer "how much does Blur cost".
    expect(blur?.passCount).toBe(2);
    expect(blur?.gpu).toEqual({ availability: "measured", ms: 5 });
    expect(blur?.cpu.ms).toBeCloseTo(0.5, 10);
  });

  it("keeps CPU and GPU apart — neither is ever summed into the other (§V86)", () => {
    const rows = nodeCostRows(input());
    const total = rows.reduce((sum, row) => sum + (row.gpu.ms ?? 0), 0);
    expect(total).toBe(6.5);
    // The CPU column is an order of magnitude smaller here, which is the normal case and
    // exactly why blending them would hide the GPU cost the user is looking for.
    expect(rows.reduce((sum, row) => sum + (row.cpu.ms ?? 0), 0)).toBeCloseTo(1, 10);
  });

  it("degrades each half INDEPENDENTLY", () => {
    const gpuOnly = nodeCostRows(input({ cpuAvailable: false }));
    expect(gpuOnly[0]?.gpu.availability).toBe("measured");
    expect(gpuOnly[0]?.cpu).toEqual({ availability: "unavailable", ms: null });

    const cpuOnly = nodeCostRows(input({ gpuAvailable: false }));
    expect(cpuOnly[0]?.cpu.availability).toBe("measured");
    expect(cpuOnly[0]?.gpu).toEqual({ availability: "unavailable", ms: null });
  });

  it("says PENDING, not zero, while a supported source has produced no span yet", () => {
    const rows = nodeCostRows(input({ gpuSpans: new Map() }));
    // Spans land a frame or two after submit. "measuring…" is a promise of a number;
    // "0.000 ms" is a claim that the node is free.
    expect(rows[0]?.gpu).toEqual({ availability: "pending", ms: null });
  });

  it("rolls an unclassified node under 'other' rather than dropping it", () => {
    const rows = nodeCostRows(input({ categories: new Map() }));
    expect(rows.every((row) => row.category === UNCATEGORISED)).toBe(true);
    // Dropping it would make the rollup total quietly smaller than the frame.
    expect(rows).toHaveLength(3);
  });

  it("names a row by its source path when it came out of a component (§V82)", () => {
    const rows = nodeCostRows(
      input({ sources: [{ nodeId: "blur1", path: ["inst"], sourcePath: "Main / Bloom_1 / blur1" }] }),
    );
    expect(rows.find((row) => row.nodeId === "blur1")?.sourcePath).toBe("Main / Bloom_1 / blur1");
  });

  it("orders rows by node id, so a 10 Hz table does not reshuffle under the pointer", () => {
    expect(nodeCostRows(input()).map((row) => row.nodeId)).toEqual(["blur1", "noise1", "over1"]);
  });
});

describe("category rollups (T256)", () => {
  it("totals each category over the nodes in it", () => {
    const rollups = categoryRollups(nodeCostRows(input()));
    expect(rollups.map((entry) => entry.category)).toEqual(["composite", "filter", "generator"]);
    const filter = rollups.find((entry) => entry.category === "filter");
    expect(filter).toMatchObject({ nodeCount: 1, passCount: 2 });
    expect(filter?.gpu.ms).toBe(5);
  });

  it("adds nodes of the same category together", () => {
    const rollups = categoryRollups(
      nodeCostRows(
        input({
          categories: new Map([
            ["blur1", "filter"],
            ["noise1", "filter"],
            ["over1", "composite"],
          ]),
        }),
      ),
    );
    const filter = rollups.find((entry) => entry.category === "filter");
    expect(filter).toMatchObject({ nodeCount: 2, passCount: 3 });
    expect(filter?.gpu.ms).toBe(6);
  });

  it("a category with nothing measured totals to ABSENT, never to 0.000 ms", () => {
    const rollups = categoryRollups(nodeCostRows(input({ gpuAvailable: false })));
    for (const rollup of rollups) {
      expect(rollup.gpu.ms).toBeNull();
      expect(rollup.gpu.availability).toBe("unavailable");
    }
  });

  it("keeps 'unavailable' over 'pending' when a category mixes them", () => {
    const rows = nodeCostRows(
      input({
        gpuSpans: new Map(),
        categories: new Map([
          ["blur1", "filter"],
          ["noise1", "filter"],
        ]),
      }),
    );
    const pendingOnly = categoryRollups(rows).find((entry) => entry.category === "filter");
    expect(pendingOnly?.gpu.availability).toBe("pending");

    // Now one of the two is genuinely unmeasurable. The total is unmeasurable too —
    // calling it "measuring…" would promise a number that is never coming.
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined) throw new Error("expected two rows");
    const mixed = categoryRollups([
      { ...first, gpu: { availability: "unavailable", ms: null } },
      second,
    ]);
    expect(mixed[0]?.gpu.availability).toBe("unavailable");
  });

  it("a partly measured category carries the sum of what it has", () => {
    const rollups = categoryRollups(
      nodeCostRows(
        input({
          gpuSpans: new Map([["blur:p0", 2]]),
          categories: new Map([
            ["blur1", "filter"],
            ["noise1", "filter"],
          ]),
        }),
      ),
    );
    // blur1 measured 2 ms, noise1 measured nothing. The total is 2, not 2-plus-a-guess.
    expect(rollups.find((entry) => entry.category === "filter")?.gpu.ms).toBe(2);
  });
});

describe("the hub carries both halves through a snapshot", () => {
  let clock = 0;
  const now = () => clock;
  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const advance = (ms: number): void => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };

  function fakeGpu(): PassTimingSource & { emit: (spans: PassSpanResults) => void } {
    let listener: ((spans: PassSpanResults) => void) | null = null;
    return {
      timestampQuery: true,
      onPassTimings(next) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      emit: (spans) => listener?.(spans),
    };
  }

  function fakeCpu(): CpuTimingSource & { emit: (spans: CpuSpanResults) => void } {
    let listener: ((spans: CpuSpanResults) => void) | null = null;
    return {
      available: true,
      onCpuTimings(next) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      emit: (spans) => listener?.(spans),
    };
  }

  const planOf = () =>
    telemetryPlan(
      {
        passes: [
          { id: "blur:p0", kind: "effect", nodeId: "blur1" },
          { id: "noise:p0", kind: "effect", nodeId: "noise1" },
        ],
        resources: [],
        order: ["blur1", "noise1"],
        pruned: [],
        sources: [],
        estimatedResourceBytes: 0,
      },
      {
        categories: new Map([
          ["blur1", "filter"],
          ["noise1", "generator"],
        ]),
      },
    );

  it("reads unavailable on BOTH halves until something is attached", () => {
    const hub = createTelemetryHub({ now });
    hub.setPlan(planOf());
    advance(TELEMETRY_TICK_MS);
    const snapshot = hub.snapshot();
    expect(snapshot.cpuTimingAvailable).toBe(false);
    expect(snapshot.timingAvailable).toBe(false);
    for (const row of snapshot.nodes) {
      expect(row.cpu.ms).toBeNull();
      expect(row.gpu.ms).toBeNull();
    }
    hub.dispose();
  });

  it("fills the two columns from two separate sources", () => {
    const hub = createTelemetryHub({ now });
    const gpu = fakeGpu();
    const cpu = fakeCpu();
    hub.attachTimingSource(gpu);
    hub.attachCpuTimingSource(cpu);
    hub.setPlan(planOf());
    gpu.emit({ "blur:p0": 4, "noise:p0": 1 });
    cpu.emit({ "blur:p0": 0.25 });
    advance(TELEMETRY_TICK_MS);

    const rows = hub.snapshot().nodes;
    const blur = rows.find((row) => row.nodeId === "blur1");
    expect(blur?.gpu.ms).toBe(4);
    expect(blur?.cpu.ms).toBe(0.25);
    // noise1 has a GPU span and no CPU one. That is a per-half state, not a zero.
    const noise = rows.find((row) => row.nodeId === "noise1");
    expect(noise?.gpu.ms).toBe(1);
    expect(noise?.cpu).toEqual({ availability: "pending", ms: null });

    expect(hub.snapshot().categories.map((entry) => entry.category)).toEqual([
      "filter",
      "generator",
    ]);
    hub.dispose();
  });

  it("drops spans belonging to a plan that no longer exists", () => {
    const hub = createTelemetryHub({ now });
    const cpu = fakeCpu();
    hub.attachCpuTimingSource(cpu);
    hub.setPlan(planOf());
    cpu.emit({ "blur:p0": 5 });
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().nodes.find((row) => row.nodeId === "blur1")?.cpu.ms).toBe(5);

    // A recompile that no longer contains that pass must not report the old cost against
    // whatever takes its id next.
    hub.setPlan(
      telemetryPlan(
        {
          passes: [{ id: "solid:p0", kind: "effect", nodeId: "solid1" }],
          resources: [],
          order: ["solid1"],
          pruned: [],
          sources: [],
          estimatedResourceBytes: 0,
        },
        {},
      ),
    );
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().nodes.map((row) => row.nodeId)).toEqual(["solid1"]);
    expect(hub.snapshot().nodes[0]?.cpu).toEqual({ availability: "pending", ms: null });
    hub.dispose();
  });
});
