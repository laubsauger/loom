import type { CompiledGraph } from "@compiler/index.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { createTelemetryHub, telemetryPlan } from "@runtime/telemetry/index.ts";
import type { PassSpanResults, PassTimingSource, TelemetryHub } from "@runtime/telemetry/index.ts";

/**
 * Fixtures for the node info surfaces.
 *
 * The point of these is that the popup is renderable with no GPU, no device and no frame
 * loop anywhere: `buildNodeInfo` is pure, so a plan literal plus a hub fed synthetic spans
 * reproduces every field the real thing shows (§V85).
 */

export function testRegistry(): NodeRegistryView {
  return createTestRegistry().view();
}

export function node(id: NodeId, type: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {},
    ...extra,
  };
}

export function graphOf(nodes: readonly GraphNode[]): GraphDocument {
  const byId: Record<NodeId, GraphNode> = {};
  for (const entry of nodes) byId[entry.id] = entry;
  return { revision: 1, nodes: byId, edges: {}, groups: {} };
}

export type CompiledFixture = Partial<CompiledGraph>;

/** A minimally complete `CompiledGraph`. Override only the parts a test cares about. */
export function compiledOf(overrides: CompiledFixture = {}): CompiledGraph {
  return {
    passes: [],
    resources: [],
    diagnostics: [],
    ok: true,
    order: [],
    pruned: [],
    outputs: [],
    feedback: [],
    sources: [],
    resourceSignatures: [],
    passSignatures: [],
    signature: "sig",
    estimatedResourceBytes: 0,
    ...overrides,
  };
}

/** A `PassTimingSource` a test drives by hand, standing in for vgpu's `timer(gpu)`. */
export function fakeTiming(timestampQuery: boolean): PassTimingSource & {
  emit(spans: PassSpanResults): void;
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
  };
}

export interface HubFixture {
  hub: TelemetryHub;
  timing: ReturnType<typeof fakeTiming>;
}

/**
 * A hub already holding `plan`, with `spans` delivered and flushed.
 *
 * `intervalMs: 0` collapses the <= 10 Hz tick so a test does not have to run timers to
 * see a value. The coalescing itself is tested where it belongs, in the hub's own suite.
 */
export function hubWith(
  plan: CompiledGraph,
  spans: PassSpanResults = {},
  options: { timestampQuery?: boolean; memoryBudgetBytes?: number } = {},
): HubFixture {
  const timing = fakeTiming(options.timestampQuery ?? true);
  const hub = createTelemetryHub({ intervalMs: 0 });
  hub.attachTimingSource(timing);
  hub.setPlan(
    telemetryPlan(plan, {
      ...(options.memoryBudgetBytes === undefined
        ? {}
        : { memoryBudgetBytes: options.memoryBudgetBytes }),
    }),
  );
  timing.emit(spans);
  return { hub, timing };
}
