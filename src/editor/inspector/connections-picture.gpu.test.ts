import { describe, expect, it } from "vitest";

import { compileGraph } from "@compiler/index.ts";
import { scratchResourceId } from "@compiler/resources.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { ProjectSettings } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions, ANALYZE_RESULT_KEY } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "@/runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "@/runtime/backend/vgpu/vgpu-backend.ts";
import { connectionModel, movedOrder } from "./connections.ts";
import { createParameterEditor } from "./parameter-editor.ts";

/**
 * DRAGGING A ROW IN THE CONNECTIONS LIST CHANGES THE PICTURE (T1049), on a real device.
 *
 * This is the claim the feature stands on, and it is the one a purely cosmetic
 * implementation would pass every other gate with. A list that re-sorts its own rows and
 * writes nothing renders identically to one that rewrites the document — so the assertion
 * here is not "the rows moved", it is the COLOUR that comes back off the GPU.
 *
 * The mechanism, from `edge-order.ts`: slot k of a variadic port is the edge whose `order`
 * is k, and a Switch selects `sources[index]`. Three solids into one Switch with the index
 * pinned at 1 means the output IS the second row of this list. Move a different row into
 * second place and the frame changes colour; move nothing and it does not.
 *
 * THREE layers, and the move is 2 → 0 (§V854). A two-input fixture cannot distinguish
 * "moved to the front" from "reversed", and even at three, REVERSING [r,g,b] leaves green
 * in slot 1 — so a reversal reads exactly the same green as doing nothing. Only the
 * one-row move produces red, which is why that is the move under test.
 *
 * The reorder is issued through `movedOrder` and `ParameterEditor.reorderPortEdges` — the
 * panel's own arithmetic and the panel's own write path — so an off-by-one in either is
 * visible here as the wrong colour rather than as a passing unit test of `reorderEdges`.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const context = contextFor(alice);

const settings: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/**
 * Primaries at 0 and 1 only. `solid`'s colour is `space: "display"`, so it is sRGB-decoded
 * on the way into the texture — and 0 and 1 are the two values that decode to themselves,
 * which is what lets this assert an exact colour instead of a tolerance band (§V147).
 */
const RED = [1, 0, 0, 1];
const GREEN = [0, 1, 0, 1];
const BLUE = [0, 0, 1, 1];

interface Fixture {
  bus: LoomBus;
  sw: NodeId;
  /** Edge ids of the three sources, in the order they were wired: red, green, blue. */
  wired: [string, string, string];
}

async function fixture(): Promise<Fixture> {
  const store = createGraphStore({ ids: createSequentialIdFactory("t1049-gpu") });
  const { bus } = createDomainBus({ store, registry });
  const created = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        { op: "addNode", ref: "$red", type: "solid", position: { x: 0, y: 0 }, parameters: { color: RED } },
        { op: "addNode", ref: "$green", type: "solid", position: { x: 0, y: 100 }, parameters: { color: GREEN } },
        { op: "addNode", ref: "$blue", type: "solid", position: { x: 0, y: 200 }, parameters: { color: BLUE } },
        { op: "addNode", ref: "$sw", type: "switch", position: { x: 300, y: 0 }, parameters: { index: 1 } },
        // One meter per channel: three sinks keep the Switch alive through the prune
        // (§V25) and between them read the whole colour off one rendered frame.
        { op: "addNode", ref: "$mr", type: "analyze", position: { x: 600, y: 0 }, parameters: { channel: "r", operation: "average" } },
        { op: "addNode", ref: "$mg", type: "analyze", position: { x: 600, y: 100 }, parameters: { channel: "g", operation: "average" } },
        { op: "addNode", ref: "$mb", type: "analyze", position: { x: 600, y: 200 }, parameters: { channel: "b", operation: "average" } },
        { op: "setNodeLabel", nodeId: "$red", label: "red1" },
        { op: "setNodeLabel", nodeId: "$green", label: "green1" },
        { op: "setNodeLabel", nodeId: "$blue", label: "blue1" },
        { op: "connect", ref: "$er", source: { nodeId: "$red", portId: "out" }, target: { nodeId: "$sw", portId: "inputs" } },
        { op: "connect", ref: "$eg", source: { nodeId: "$green", portId: "out" }, target: { nodeId: "$sw", portId: "inputs" } },
        { op: "connect", ref: "$eb", source: { nodeId: "$blue", portId: "out" }, target: { nodeId: "$sw", portId: "inputs" } },
        { op: "connect", source: { nodeId: "$sw", portId: "out" }, target: { nodeId: "$mr", portId: "input" } },
        { op: "connect", source: { nodeId: "$sw", portId: "out" }, target: { nodeId: "$mg", portId: "input" } },
        { op: "connect", source: { nodeId: "$sw", portId: "out" }, target: { nodeId: "$mb", portId: "input" } },
      ],
    },
    context,
  );
  expect(created.status).toBe("applied");
  const ids = created.output.createdIds as Record<string, string>;
  return {
    bus,
    sw: ids["$sw"] as NodeId,
    wired: [ids["$er"] as string, ids["$eg"] as string, ids["$eb"] as string],
  };
}

/** The colour the Switch is publishing, straight off the device. */
async function renderedColor(bus: LoomBus): Promise<[number, number, number]> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const plan = compileGraph({ graph: bus.store.getGraph(), settings, registry, capabilities });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    });
    const read = async (meter: string): Promise<number> => {
      const raw = await backend.readBuffer(scratchResourceId(meter, ANALYZE_RESULT_KEY));
      // [average, minimum, maximum] of the analysed channel.
      return new Float32Array(raw, 0, 4)[0] ?? Number.NaN;
    };
    const graph = bus.store.getGraph();
    const meterFor = (channel: string): string =>
      Object.values(graph.nodes).find(
        (node) => node.type === "analyze" && node.parameters["channel"] === channel,
      )?.id as string;
    return [await read(meterFor("r")), await read(meterFor("g")), await read(meterFor("b"))];
  } finally {
    backend.dispose();
  }
}

describe("T1049 — reordering a connection changes what the graph renders", () => {
  it("moves the layer the LIST moved, and the Switch selects a different source for it", async () => {
    // Dawn is required, not optional: skipping would turn the one test that can see the
    // difference between this feature and a cosmetic list into a green tick everywhere.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const { bus, sw, wired } = await fixture();

    // §V854's other precondition: the phenomenon is PRESENT before it is judged. Index 1
    // of [red, green, blue] is green, and the measured channels really do vary.
    expect(await renderedColor(bus)).toEqual([0, 1, 0]);

    // The panel's own reading of the port, and the panel's own arithmetic for the drag.
    const group = connectionModel(bus.store.getGraph(), registry, sw).inputs.find(
      (entry) => entry.portId === "inputs",
    );
    expect(group?.orderable).toBe(true);
    expect(group?.rows.map((row) => row.peerName)).toEqual(["red1", "green1", "blue1"]);
    const edgeIds = (group?.rows ?? []).map((row) => row.edgeId);
    expect(edgeIds).toEqual(wired);

    // Blue, dragged from the bottom of the list to the top: [b, r, g].
    const next = movedOrder(edgeIds, 2, 0);
    expect(next).toEqual([wired[2], wired[0], wired[1]]);

    // Through the panel's write path, which is the command bus (§V29).
    const editor = createParameterEditor({ bus, context });
    await editor.reorderPortEdges(sw, "inputs", next as string[]);
    editor.endReorderGesture(sw, "inputs");
    editor.dispose();

    /*
     * RED, and only red distinguishes the right answer from the wrong ones. Index 1 of
     * [blue, red, green] is red; a reversal ([blue, green, red]) leaves GREEN there, which
     * is the colour a list that wrote nothing also produces. Both failure modes are one
     * assertion away, and neither is a tolerance question — these are exact.
     */
    expect(await renderedColor(bus)).toEqual([1, 0, 0]);
  }, 120_000);
});
