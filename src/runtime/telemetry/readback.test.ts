import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { ANALYZE_RESULT_KEY } from "../../nodes/definitions/analyze.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import { analyzeReadbacks, readbackPlanBudget } from "./readback.ts";
import { TELEMETRY_TICK_MS, createTelemetryHub, telemetryPlan } from "./hub.ts";

/**
 * The readback budget (T278, §V185).
 *
 * §V185's whole claim is that the cost SCALES and that the scaling is visible: twenty
 * Analyze nodes are twenty round trips a frame, and a user who cannot see that number will
 * blame the wrong thing. So the load-bearing test is not "a budget exists" — it is that
 * adding a node moves it, and that the bytes are the plan's own, not a constant somebody
 * typed here.
 */

const analyzeNode = (id: string, name: string): GraphNode => ({
  id,
  type: "analyze",
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters: { channel: "luminance", operation: "average" },
  label: name,
});

function graphOf(nodes: readonly GraphNode[]): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    edges: {},
    groups: {},
  };
}

/** The scratch buffer the Analyze node's own `compile()` declares: 16 bytes, one element. */
const analyzeResource = (nodeId: string) => ({
  id: scratchResourceId(nodeId, ANALYZE_RESULT_KEY),
  kind: "buffer",
  stride: 16,
  capacity: 1,
});

const registry = createNodeRegistry(allNodeDefinitions).view();

describe("readbacks are counted and sized from the plan (§V185)", () => {
  it("counts one per Analyze node and scales with them — the §V185 claim", () => {
    const one = analyzeReadbacks(graphOf([analyzeNode("a", "meter1")]), registry);
    const twenty = analyzeReadbacks(
      graphOf(Array.from({ length: 20 }, (_x, i) => analyzeNode(`a${i}`, `meter${i}`))),
      registry,
    );
    expect(one).toHaveLength(1);
    expect(twenty).toHaveLength(20);

    const budget = readbackPlanBudget({
      declared: twenty,
      resources: Array.from({ length: 20 }, (_x, i) => analyzeResource(`a${i}`)),
      sources: [],
    });
    // The number someone acts on: twenty round trips, 320 bytes, every frame.
    expect(budget.count).toBe(20);
    expect(budget.bytes).toBe(320);
    expect(budget.incomplete).toBe(false);
  });

  it("sizes each row from the PLAN's resource, not from a constant", () => {
    // A resource the plan sized differently: the budget must follow the plan, or it is
    // reporting what this file believes rather than what the graph allocated.
    const budget = readbackPlanBudget({
      declared: analyzeReadbacks(graphOf([analyzeNode("a", "meter1")]), registry),
      resources: [{ ...analyzeResource("a"), stride: 64, capacity: 4 }],
      sources: [],
    });
    expect(budget.bytes).toBe(256);
  });

  it("reports an unsizable row as UNKNOWN and the total as a floor, never as zero", () => {
    const budget = readbackPlanBudget({
      declared: analyzeReadbacks(
        graphOf([analyzeNode("a", "meter1"), analyzeNode("b", "meter2")]),
        registry,
      ),
      // "b" was pruned out of the plan, so nothing sizes its readback.
      resources: [analyzeResource("a")],
      sources: [],
    });
    expect(budget.count).toBe(2);
    expect(budget.bytes).toBe(16);
    // A missing size is not free. `incomplete` is what makes the total read "≥ 16 B".
    expect(budget.incomplete).toBe(true);
    expect(budget.rows.find((row) => row.nodeId === "b")?.bytes).toBeNull();
  });

  it("attributes a row to the node's SOURCE PATH when it came from a component (§V82)", () => {
    const budget = readbackPlanBudget({
      declared: analyzeReadbacks(graphOf([analyzeNode("a", "meter1")]), registry),
      resources: [analyzeResource("a")],
      sources: [{ nodeId: "a", path: ["inst"], sourcePath: "Main / Bloom_1 / meter1" }],
    });
    expect(budget.rows[0]?.sourcePath).toBe("Main / Bloom_1 / meter1");
    expect(budget.rows[0]?.reason).toContain("meter1");
  });

  it("names a graph with no Analyze node as zero, not as unknown", () => {
    const budget = readbackPlanBudget({ declared: [], resources: [], sources: [] });
    expect(budget).toMatchObject({ count: 0, bytes: 0, incomplete: false });
  });
});

describe("the hub reports the budget beside what the backend actually did", () => {
  // The hub caches its snapshot between flushes (§V16), so the clock is driven the way
  // `hub.test.ts` drives it rather than by sleeping.
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

  const planOf = (nodeIds: readonly string[]) =>
    telemetryPlan(
      {
        passes: nodeIds.map((nodeId) => ({ id: `${nodeId}:analyze`, kind: "dispatch", nodeId })),
        resources: nodeIds.map(analyzeResource),
        order: nodeIds,
        pruned: [],
        sources: [],
        estimatedResourceBytes: 0,
      },
      { readbacks: nodeIds.map((nodeId) => ({ nodeId, resourceId: scratchResourceId(nodeId, ANALYZE_RESULT_KEY), reason: `Analyze channel "${nodeId}"` })) },
    );

  it("carries the plan budget into the snapshot", () => {
    const hub = createTelemetryHub({ now });
    hub.setPlan(planOf(["a", "b", "c"]));
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().readback).toMatchObject({ count: 3, bytes: 48 });
    hub.dispose();
  });

  it("keeps 'nobody is counting' distinct from 'the backend did none'", () => {
    const hub = createTelemetryHub({ now });
    hub.setPlan(planOf(["a"]));
    advance(TELEMETRY_TICK_MS);
    // No backend has reported. Null, and the panel shows "—": a zero here would claim the
    // readback path ran and found nothing to do, which is a different fact.
    expect(hub.snapshot().readback.performed).toBeNull();

    hub.setReadbacksPerformed(0);
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().readback.performed).toBe(0);

    hub.setReadbacksPerformed(7);
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().readback.performed).toBe(7);
    hub.dispose();
  });

  it("clears the budget with the plan, so a stale count cannot outlive its graph", () => {
    const hub = createTelemetryHub({ now });
    hub.setPlan(planOf(["a", "b"]));
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().readback.count).toBe(2);
    hub.setPlan(null);
    advance(TELEMETRY_TICK_MS);
    expect(hub.snapshot().readback.count).toBe(0);
    hub.dispose();
  });

  it("notifies subscribers when the observed count moves, but not when it repeats", () => {
    const hub = createTelemetryHub({ now });
    let ticks = 0;
    const off = hub.subscribe(() => {
      ticks += 1;
    });
    hub.setReadbacksPerformed(3);
    advance(TELEMETRY_TICK_MS);
    const afterFirst = ticks;
    expect(afterFirst).toBeGreaterThan(0);

    // Same number again: the backend counter is re-read on every backend report, and a
    // notification per report would be a re-render per report for no new information
    // (§V16). The hub coalesces by TIME; this coalesces by VALUE, which is the only thing
    // that helps when the reports are minutes apart and identical.
    hub.setReadbacksPerformed(3);
    advance(TELEMETRY_TICK_MS);
    expect(ticks).toBe(afterFirst);
    off();
    hub.dispose();
  });
});
