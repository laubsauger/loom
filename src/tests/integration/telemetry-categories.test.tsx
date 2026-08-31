// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { componentNodeType } from "@domain/components/component-type.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import { useGraphCompile } from "../../app/use-graph-compile.ts";

/**
 * T629 — THE PERFORMANCE ROLLUP SEES INSIDE A COMPONENT.
 *
 * The telemetry plan's `categories` map was built from the RAW document, while the
 * plan's pass ids name flattened inner nodes (`instance/inner`). So every pass inside a
 * component instance rolled up under "other" — invisible exactly when the component
 * held the animated subgraph dominating the frame, which components exist to hold. Not
 * a frame-path defect, so T615's gates never saw it; this drives the app's real seam
 * (`useGraphCompile` → `telemetryPlan` → the hub) and reads the answer back off the
 * hub's own snapshot.
 */

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  limits: { maxTextureDimension2D: 8192 },
  timestampQuery: false,
};

/** One blur behind the socket — the exact shape whose cost hid under "other". */
function fanDefinition(): GraphComponentDefinition {
  return {
    componentId: "fan",
    version: 1,
    name: "Fan",
    graph: {
      revision: 1,
      nodes: {
        entry: { id: "entry" as NodeId, type: "componentIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "feed" },
        blurA: { id: "blurA" as NodeId, type: "blur", definitionVersion: 1, position: { x: 240, y: 0 }, parameters: {} },
        exit: { id: "exit" as NodeId, type: "componentOut", definitionVersion: 1, position: { x: 480, y: 0 }, parameters: {}, label: "result" },
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "entry" as NodeId, portId: "out" }, target: { nodeId: "blurA" as NodeId, portId: "input" } },
        e1: { id: "e1", source: { nodeId: "blurA" as NodeId, portId: "out" }, target: { nodeId: "exit" as NodeId, portId: "in" } },
      },
      groups: {},
    } as never,
    inputs: [],
    outputs: [],
    parameters: [],
  };
}

afterEach(cleanup);

describe("T629 — telemetry categories come from the FLAT document", () => {
  it("a blur inside an instance attributes as 'filter', by its flat id, on the hub's plan", async () => {
    const runtime = createAppRuntime({
      identityStorage: null,
      actor: { kind: "human", id: "tester", label: "Tester" },
    });
    runtime.components.register(fanDefinition());
    const type = componentNodeType("fan", 1);

    await act(async () => {
      const result = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "seed",
          operations: [
            { op: "addNode", ref: "$gen", type: "noise", position: { x: 0, y: 0 } },
            { op: "addNode", ref: "$c", type, position: { x: 240, y: 0 } },
            { op: "addNode", ref: "$out", type: "output", position: { x: 480, y: 0 } },
            { op: "connect", source: { nodeId: "$gen", portId: "out" }, target: { nodeId: "$c", portId: "feed" } },
            { op: "connect", source: { nodeId: "$c", portId: "result" }, target: { nodeId: "$out", portId: "input" } },
          ],
        },
        runtime.invocation,
      );
      expect(result.status).toBe("applied");
    });

    const hook = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    const compiled = hook.result.current.compiled;
    expect(compiled).not.toBeNull();

    const instanceId = Object.entries(hook.result.current.graph.nodes).find(
      ([, node]) => node.type === type,
    )?.[0];
    expect(instanceId).toBeDefined();
    const flatBlurId = `${instanceId}/blurA` as NodeId;

    // The plan actually names the flat inner node — the premise of the whole defect.
    expect(compiled?.passes.some((pass) => pass.id.startsWith(`${flatBlurId}#`))).toBe(true);

    // THE GATE, read back off the hub the performance tab reads: the flat blur carries
    // its manifest category. Built from the raw document this entry does not exist and
    // the pass rolls up under "other".
    const plan = runtime.telemetry.snapshot().plan;
    expect(plan).not.toBeNull();
    expect(plan?.categories.get(flatBlurId)).toBe("filter");
    // And the outer document's own nodes did not lose theirs in the move.
    const genId = Object.entries(hook.result.current.graph.nodes).find(
      ([, node]) => node.type === "noise",
    )?.[0] as NodeId;
    expect(plan?.categories.get(genId)).toBe("generator");
  });
});
