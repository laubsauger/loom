import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/compile.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { ProjectSettings } from "../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const settings: ProjectSettings = {
  outputResolution: { width: 640, height: 360 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

/**
 * T223 (§V130): a Null is a WIRE. The proof is structural and total — the plan compiled
 * THROUGH a null is byte-identical (same structure signature) to the plan compiled
 * without it, and the null's own output resolves to its producer's resource.
 */

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return {
    id: id as NodeId,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
  };
}

function graphOf(
  nodes: GraphNode[],
  edges: Array<[string, string, string, string]>,
): GraphDocument {
  const edgeRecord: GraphDocument["edges"] = {};
  edges.forEach(([sn, sp, tn, tp], index) => {
    edgeRecord[`e${index}`] = {
      id: `e${index}`,
      source: { nodeId: sn, portId: sp },
      target: { nodeId: tn, portId: tp },
    } as GraphDocument["edges"][string];
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: edgeRecord,
    groups: {},
  } as unknown as GraphDocument;
}

const registry = () => createNodeRegistry(allNodeDefinitions).view();

describe("Null splices to a wire (T223, §V130)", () => {
  const direct = graphOf(
    [node("gen", "solid"), node("sink", "output")],
    [["gen", "out", "sink", "input"]],
  );
  const viaNull = graphOf(
    [node("gen", "solid"), node("wire", "null"), node("sink", "output")],
    [
      ["gen", "out", "wire", "in"],
      ["wire", "out", "sink", "input"],
    ],
  );

  it("compiles to the IDENTICAL plan with and without the null — zero cost, proven structurally", () => {
    const a = compileGraph({ graph: direct, settings, registry: registry(), capabilities });
    const b = compileGraph({ graph: viaNull, settings, registry: registry(), capabilities });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.signature).toBe(a.signature);
    expect(b.passes.length).toBe(a.passes.length);
    expect(b.resources.length).toBe(a.resources.length);
  });

  it("keeps the null's output addressable: it aliases the producer's resource", () => {
    const compiled = compileGraph({ graph: viaNull, settings, registry: registry(), capabilities });
    const alias = compiled.outputs.find((output) => output.nodeId === "wire");
    const producer = compiled.outputs.find((output) => output.nodeId === "gen");
    expect(alias).toBeDefined();
    expect(producer).toBeDefined();
    expect(alias?.resourceId).toBe(producer?.resourceId);
  });

  it("resolves chains of nulls to the one real producer", () => {
    const chained = graphOf(
      [node("gen", "solid"), node("w1", "null"), node("w2", "null"), node("sink", "output")],
      [
        ["gen", "out", "w1", "in"],
        ["w1", "out", "w2", "in"],
        ["w2", "out", "sink", "input"],
      ],
    );
    const compiled = compileGraph({ graph: chained, settings, registry: registry(), capabilities });
    const directPlan = compileGraph({ graph: direct, settings, registry: registry(), capabilities });
    expect(compiled.ok).toBe(true);
    expect(compiled.signature).toBe(directPlan.signature);
  });

  it("lets an unconnected null vanish; its consumer reports the missing input", () => {
    const dangling = graphOf(
      [node("wire", "null"), node("sink", "output")],
      [["wire", "out", "sink", "input"]],
    );
    const compiled = compileGraph({ graph: dangling, settings, registry: registry(), capabilities });
    expect(compiled.diagnostics.some((d) => d.code === "compiler/input-missing")).toBe(true);
  });
});

describe("value sources are not 'pruned' (T268, §V173)", () => {
  it("reports a dead texture node pruned, and a working LFO not at all", () => {
    // The LFO is non-plan-resident BY DESIGN: it drives parameters through the channel
    // seam, off the document. "Pruned" means dead-and-excluded; showing it on the one
    // node type whose purpose is to be invisible misdirects exactly the person
    // debugging why nothing moves.
    const graph = graphOf(
      [
        node("gen", "solid"),
        node("sink", "output"),
        { ...node("mod", "lfo"), label: "lfo1" },
        node("orphan", "solid"),
      ],
      [["gen", "out", "sink", "input"]],
    );
    const compiled = compileGraph({ graph, settings, registry: registry(), capabilities });
    expect(compiled.pruned).toContain("orphan");
    expect(compiled.pruned).not.toContain("mod");
  });
});
