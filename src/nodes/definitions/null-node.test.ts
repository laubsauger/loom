import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/compile.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { ProjectSettings } from "../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import { pointsPreviewResourceId } from "../../compiler/resources.ts";
import { flatDocument } from "../../compiler/test-support.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { NO_FLATTENING } from "../../domain/parameters/node-references.ts";

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

  it("keeps an op()-referenced texture node out of the pruned report (§V154, §V173b)", () => {
    const graph = graphOf(
      [
        {
          ...node("gen", "blur"),
          parameters: {
            size: {
              mode: "expression",
              bindings: { expression: { kind: "expression", source: "op('backdrop').par.amount" } },
            },
          } as GraphNode["parameters"],
        },
        node("sink", "output"),
        { ...node("referenced", "solid"), label: "backdrop" },
      ],
      [["gen", "out", "sink", "input"]],
    );
    const compiled = compileGraph({ graph, settings, registry: registry(), capabilities });
    // Not in the GPU plan (kept stays edge-based; a .par read needs no pixels) — but
    // not "pruned" either: it is a live dependency, and the badge would misdirect.
    expect(compiled.pruned).not.toContain("referenced");
  });
});

describe("bypass and mute reach the compiler (T250, B16)", () => {
  it("a bypassed filter is a wire: the plan is byte-identical to the chain without it", () => {
    const direct = graphOf(
      [node("gen", "solid"), node("sink", "output")],
      [["gen", "out", "sink", "input"]],
    );
    const bypassed = graphOf(
      [node("gen", "solid"), { ...node("fx", "blur"), ui: { bypassed: true } }, node("sink", "output")],
      [
        ["gen", "out", "fx", "input"],
        ["fx", "out", "sink", "input"],
      ],
    );
    const a = compileGraph({ graph: direct, settings, registry: registry(), capabilities });
    const b = compileGraph({ graph: bypassed, settings, registry: registry(), capabilities });
    expect(b.signature).toBe(a.signature);
    // Previewing the bypassed node shows its INPUT — the TD behaviour, via the alias.
    expect(b.outputs.find((o) => o.nodeId === "fx")?.resourceId).toBe(
      b.outputs.find((o) => o.nodeId === "gen")?.resourceId,
    );
  });

  it("a muted node is silence: it and its edges leave the compile graph", () => {
    const graph = graphOf(
      [{ ...node("gen", "solid"), ui: { muted: true } }, node("sink", "output")],
      [["gen", "out", "sink", "input"]],
    );
    const compiled = compileGraph({ graph, settings, registry: registry(), capabilities });
    // The consumer sees a disconnected required input — the honest signal; the mute
    // badge already explains why. And the muted node is not "pruned": it is not dead.
    expect(compiled.diagnostics.some((d) => d.code === "compiler/input-missing")).toBe(true);
    expect(compiled.passes.some((p) => "nodeId" in p && p["nodeId"] === "gen")).toBe(false);
    expect(compiled.pruned).not.toContain("gen");
  });

  it("a bypassed SOURCE (nothing to pass through) mutes instead", () => {
    const graph = graphOf(
      [{ ...node("gen", "solid"), ui: { bypassed: true } }, node("sink", "output")],
      [["gen", "out", "sink", "input"]],
    );
    const compiled = compileGraph({ graph, settings, registry: registry(), capabilities });
    expect(compiled.diagnostics.some((d) => d.code === "compiler/input-missing")).toBe(true);
    expect(compiled.passes.some((p) => "nodeId" in p && p["nodeId"] === "gen")).toBe(false);
  });
});

/**
 * T1822b — the Null of the POINTS family. Same splice as the texture Null (zero cost, proven
 * by the plan signature), and B305/T1823b's half of it: a WATCHED points Null previews as a
 * splat of its own, drawing its producer's points. The §V130 alias alone handed it the
 * producer's pointset MARKER, which no preview (tile or viewer) can show.
 */
describe("Points Null (T1822b, B305)", () => {
  const sinks = (nodeId: string) => [{ nodeId: nodeId as NodeId, portId: "out", kind: "preview" as const }];
  const direct = graphOf(
    [node("gen", "pointGrid"), node("draw", "renderPoints"), node("sink", "output")],
    [
      ["gen", "out", "draw", "points"],
      ["draw", "out", "sink", "input"],
    ],
  );
  const viaNull = graphOf(
    [node("gen", "pointGrid"), node("wire", "pointNull"), node("draw", "renderPoints"), node("sink", "output")],
    [
      ["gen", "out", "wire", "in"],
      ["wire", "out", "draw", "points"],
      ["draw", "out", "sink", "input"],
    ],
  );

  it("compiles to the IDENTICAL plan with and without the null — no pass, no buffer", () => {
    const a = compileGraph({ graph: direct, settings, registry: registry(), capabilities });
    const b = compileGraph({ graph: viaNull, settings, registry: registry(), capabilities });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.signature).toBe(a.signature);
    expect(b.passes.length).toBe(a.passes.length);
    expect(b.resources.length).toBe(a.resources.length);
  });

  it("cut the wire into it and the renderer loses its points: it IS the wire", () => {
    const cut = graphOf(
      [node("gen", "pointGrid"), node("wire", "pointNull"), node("draw", "renderPoints"), node("sink", "output")],
      [
        ["wire", "out", "draw", "points"],
        ["draw", "out", "sink", "input"],
      ],
    );
    const compiled = compileGraph({ graph: cut, settings, registry: registry(), capabilities });
    expect(compiled.diagnostics.some((d) => d.code === "compiler/input-missing" && d.nodeId === "draw")).toBe(true);
  });

  it("watched, it previews its producer's points under its OWN target and pass", () => {
    const own = compileGraph({ graph: viaNull, settings, registry: registry(), capabilities, sinks: sinks("gen") });
    const wire = compileGraph({ graph: viaNull, settings, registry: registry(), capabilities, sinks: sinks("wire") });
    const producerRow = own.outputs.find((output) => output.nodeId === "gen" && output.portId === "out");
    const nullRow = wire.outputs.find((output) => output.nodeId === "wire" && output.portId === "out");
    // The producer's own splat, as T373 has always made it: the reference.
    expect(producerRow?.synthesis?.kind).toBe("pointset");
    // The null's row is a PICTURE — a target the preview program draws — not the marker.
    expect(nullRow?.resourceKind).toBe("target");
    expect(nullRow?.resourceId).toBe(pointsPreviewResourceId("wire" as NodeId, "out"));
    const nullPass = nullRow?.synthesis?.passes[0];
    const producerPass = producerRow?.synthesis?.passes[0];
    expect(nullPass?.id).toBe("wire#pointsPreview:out");
    expect(nullPass?.target).toBe(pointsPreviewResourceId("wire" as NodeId, "out"));
    // …drawing EXACTLY the producer's points: the same buffer, the same count, the same framing.
    expect(nullPass?.buffers).toEqual(producerPass?.buffers);
    expect(nullPass?.instances).toBe(producerPass?.instances);
    expect(nullPass?.uniforms).toEqual(producerPass?.uniforms);
    // And the main plan is untouched by the preview: the splat lives in the preview program.
    expect(wire.signature).toBe(own.signature);
  });

  it("a BYPASSED point node is the same wire, so it previews its input's points the same way", () => {
    const bypassed = graphOf(
      [node("gen", "pointGrid"), { ...node("fx", "pointTransform"), ui: { bypassed: true } }],
      [["gen", "out", "fx", "points"]],
    );
    const compiled = compileGraph({ graph: bypassed, settings, registry: registry(), capabilities, sinks: sinks("fx") });
    const own = compileGraph({ graph: bypassed, settings, registry: registry(), capabilities, sinks: sinks("gen") });
    const row = compiled.outputs.find((output) => output.nodeId === "fx" && output.portId === "out");
    expect(row?.resourceId).toBe(pointsPreviewResourceId("fx" as NodeId, "out"));
    expect(row?.synthesis?.passes[0]?.buffers).toEqual(
      own.outputs.find((output) => output.nodeId === "gen")?.synthesis?.passes[0]?.buffers,
    );
  });

  it("unwatched, it costs nothing: no splat is synthesized for it", () => {
    const compiled = compileGraph({ graph: viaNull, settings, registry: registry(), capabilities, sinks: sinks("gen") });
    const nullRow = compiled.outputs.find((output) => output.nodeId === "wire" && output.portId === "out");
    expect(nullRow?.synthesis).toBeUndefined();
  });
});

/**
 * T1822b — the Null of the VALUE family: a channel bag under a stable name. The claim a
 * person relies on is `op('null_x').chan.<channel>` reading the source's number THROUGH the
 * null, so that is what is asserted — by exact value, against a source whose number is not
 * a default, and with the wire cut to show the read really goes through it.
 */
describe("Value Null (T1822b)", () => {
  const reader = (): GraphNode =>
    ({
      ...node("reader", "constant"),
      label: "constant_reader",
      parameters: {
        value: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('null_level').chan.value * 2" } } },
      },
    }) as GraphNode;
  const chain = (wired: boolean) =>
    graphOf(
      [
        { ...node("src", "constant", { value: 0.37 }), label: "constant_src" },
        { ...node("wire", "valueNull"), label: "null_level" },
        reader(),
      ],
      wired ? [["src", "out", "wire", "in"]] : [],
    );
  const frame = { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 1 } as const;

  it("publishes its input's bag unchanged under its own name, and op() reads it there", () => {
    const result = createValueGraphSession(registry()).evaluate(flatDocument(chain(true)), frame, { flattening: NO_FLATTENING });
    expect(result.byName.get("null_level")).toEqual({ value: 0.37 });
    expect(result.byName.get("constant_reader")).toEqual({ value: 0.74 });
  });

  it("cut the wire into it and it publishes NOTHING — absence, not an empty bag (T541)", () => {
    const result = createValueGraphSession(registry()).evaluate(flatDocument(chain(false)), frame, { flattening: NO_FLATTENING });
    expect(result.byName.has("null_level")).toBe(false);
    expect(result.byName.get("constant_reader")).not.toEqual({ value: 0.74 });
  });

  it("costs the plan nothing either: it splices out of the compile like every Null", () => {
    const compiled = compileGraph({ graph: chain(true), settings, registry: registry(), capabilities });
    expect(compiled.passes.some((pass) => "nodeId" in pass && pass["nodeId"] === "wire")).toBe(false);
  });
});
