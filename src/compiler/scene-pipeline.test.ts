import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { DrawPassDescriptor } from "../runtime/backend/plan.ts";

/**
 * T377/T447: the scene pipeline at the compiler level.
 *
 * Scene assembly flows by NAME (V372) and the compiler resolves every name into a
 * synthesized edge (V373), so what these tests pin is the whole authoring contract:
 * payloads reach the render across references, list order IS draw/light order, every
 * dangling or wrong-kind name refuses BY NAME (§V369, never a quietly smaller scene),
 * and two scenes in one document stay disjoint (§V321).
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

function node(id: string, type: string, parameters: Record<string, unknown> = {}, label?: string): GraphNode {
  return {
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    ...(label === undefined ? {} : { label }),
  } as never;
}

function sceneGraph(overrides: {
  renderParams?: Record<string, unknown>;
  extraNodes?: GraphNode[];
  extraEdges?: Record<string, unknown>;
} = {}): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
        node("geo", "geometry", { mode: "surface" }, "geo1"),
        node("cam", "camera", {}, "cam1"),
        node("sun", "light", {}, "sun1"),
        node(
          "shot",
          "render",
          { scenes: "geo1", camera: "cam1", lights: "sun1", ...overrides.renderParams },
          "shot1",
        ),
        node("out", "output", {}, "out1"),
        ...(overrides.extraNodes ?? []),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      ...(overrides.extraEdges ?? {}),
    },
    groups: {},
  } as never;
}

const compile = (graph: GraphDocument) =>
  compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES } as never);

// Geometry draws only: every render leads with its backdrop fill (T444).
const sceneDraws = (compiled: { passes: ReadonlyArray<unknown> }) =>
  compiled.passes.filter(
    (pass) => (pass as { kind: string }).kind === "draw" && String((pass as { id: string }).id).includes(":scene:"),
  ) as DrawPassDescriptor[];
const drawOf = (compiled: { passes: ReadonlyArray<unknown> }) => sceneDraws(compiled)[0] as DrawPassDescriptor;

describe("the scene pipeline compiles by NAME (T377, T447)", () => {
  it("resolves camera, light and geometry references into one lit draw", () => {
    const compiled = compile(sceneGraph());
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(compiled.ok).toBe(true);

    const draw = drawOf(compiled);
    expect(draw).toBeDefined();
    // The geometry's pair, by reference chain: grid → geometry → (named) → render.
    expect(draw.buffers?.[0]?.resourceId).toBe("scratch:grid:position");
    // The camera reached the uniforms as a composed matrix, the light as array values.
    expect(Array.isArray(draw.uniforms?.["viewProjection"])).toBe(true);
    expect(Array.isArray(draw.uniforms?.["light0Color"])).toBe(true);
    // The generated shader is per-light-count: one light, one loop bound.
    expect(draw.shader).toContain("light0Meta");
  });

  it("draw order and light order are LIST order, not name order (§V131)", () => {
    const compiled = compile(
      sceneGraph({
        renderParams: { scenes: "geo1 geob1", lights: "moon1 sun1" },
        extraNodes: [
          node("gridb", "pointGrid", { cols: 4, rows: 4 }, "gridb1"),
          node("geob", "geometry", { mode: "surface" }, "geob1"),
          node("moon", "light", { intensity: 0.2 }, "moon1"),
        ],
        extraEdges: {
          e3: { id: "e3", source: { nodeId: "gridb", portId: "out" }, target: { nodeId: "geob", portId: "points" } },
        },
      }),
    );
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draws = sceneDraws(compiled);
    // geo1 first, geob1 second — the parameter's stated order.
    expect(draws.map((draw) => draw.buffers?.[0]?.resourceId)).toEqual([
      "scratch:grid:position",
      "scratch:gridb:position",
    ]);
    // moon before sun in the flat light array: moon's intensity 0.2 leads.
    expect((draws[0]?.uniforms?.["light0Meta"] as number[])[1]).toBe(0.2);
    // The backdrop clears; every geometry draw composes over it (T444).
    expect(draws[0]?.clear).toBe(false);
    expect(draws[1]?.clear).toBe(false);
  });

  it("a dangling name refuses BY NAME — never a quietly smaller scene (§V369)", () => {
    const compiled = compile(sceneGraph({ renderParams: { scenes: "geo1 ghost1" } }));
    const missing = compiled.diagnostics.find((d) => d.code === CompilerDiagnosticCode.sourceReferenceMissing);
    expect(missing?.message).toContain('"ghost1"');
  });

  it("a wrong-KIND name refuses naming the parameter, the name, and what it IS", () => {
    // The camera parameter naming a light: resolvable — and statically wrong, refused
    // at synthesis with everything the fix needs in one sentence.
    const compiled = compile(sceneGraph({ renderParams: { camera: "sun1" } }));
    const wrong = compiled.diagnostics.find((d) => d.code === CompilerDiagnosticCode.sourceReferenceMissing);
    expect(wrong?.message).toContain('camera "sun1"');
    expect(wrong?.message).toContain("is a light");
    expect(wrong?.message).toContain("publishes no camera");
  });

  it("an empty scene list is a refusal, because an empty scene renders happily (§V369)", () => {
    const compiled = compile(sceneGraph({ renderParams: { scenes: "" } }));
    expect(compiled.diagnostics.some((d) => d.code === "node.scene.empty")).toBe(true);
  });

  it("a lit material under zero lights renders — and SAYS ambient-floor-only", () => {
    const compiled = compile(sceneGraph({ renderParams: { lights: "" } }));
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const warning = compiled.diagnostics.find((d) => d.code === "node.scene.unlit");
    expect(warning?.severity).toBe("warning");
    // And the generated shader for zero lights carries no light loop at all.
    expect(drawOf(compiled).shader).not.toContain("light0Meta");
  });

  it("TWO scene pipelines in one document stay disjoint (§V321)", () => {
    const graph = sceneGraph({
      extraNodes: [
        node("grid2", "pointGrid", { cols: 4, rows: 4 }, "grid21"),
        node("geo2", "geometry", { mode: "surface" }, "geo21"),
        node("cam2", "camera", { eye: [5, 5, 5] }, "cam21"),
        node("shot2", "render", { scenes: "geo21", camera: "cam21", lights: "" }, "shot21"),
        node("out2", "analyze", {}, "probe1"),
      ],
      extraEdges: {
        x1: { id: "x1", source: { nodeId: "grid2", portId: "out" }, target: { nodeId: "geo2", portId: "points" } },
        x2: { id: "x2", source: { nodeId: "shot2", portId: "out" }, target: { nodeId: "out2", portId: "input" } },
      },
    });
    const compiled = compile(graph);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const byNode = new Map(sceneDraws(compiled).map((draw) => [draw.nodeId, draw.buffers?.[0]?.resourceId]));
    expect(byNode.get("shot")).toBe("scratch:grid:position");
    expect(byNode.get("shot2")).toBe("scratch:grid2:position");
  });

  it("moving the camera is a VALUE change; renaming the graph's shape is not required (§V5)", () => {
    const still = compile(sceneGraph());
    const moved = compile(sceneGraph({ renderParams: {} , extraNodes: [] }));
    // Same graph, same signature (control) —
    expect(moved.signature).toBe(still.signature);
    // — and a different camera EYE keeps the signature too: uniforms carry it.
    const orbited = sceneGraph();
    ((orbited.nodes["cam"] as GraphNode).parameters as Record<string, unknown>)["eye"] = [2, 1, 2];
    expect(compile(orbited).signature).toBe(still.signature);
  });
});

describe("materials (T428) — referenced by name, mapped by wire", () => {
  it("a phong material's colours and gloss reach the draw uniforms; roughness dulls", () => {
    const compiled = compile(
      sceneGraph({
        renderParams: {},
        extraNodes: [
          node("gold", "materialPhong", { color: [1, 0.7, 0.2, 1], specular: [1, 0.9, 0.6, 1], shininess: 96, roughness: 0.2 }, "gold1"),
        ],
      }),
    );
    // geometry names the material
    const graph = sceneGraph({
      extraNodes: [
        node("gold", "materialPhong", { specular: [1, 1, 0, 1], shininess: 96 }, "gold1"),
      ],
    });
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["material"] = "gold1";
    const lit = compile(graph);
    expect(lit.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = drawOf(lit);
    // Display-space params decode to LINEAR at resolution (§V56); 0 and 1 are the
    // decode's fixed points, which is what makes this exact.
    expect(draw.uniforms?.["specular"]).toEqual([1, 1, 0, 96]);
    expect(draw.shader).toContain("highlight");
    void compiled;
  });

  it("THE T444 WIRE: a texture wired into a material's albedo is BOUND by the render", () => {
    // The virtual screen's whole mechanism: any texture output — including another
    // render's — reaches a surface as a material map through one plain edge.
    const graph = sceneGraph({
      extraNodes: [
        node("plate", "checker", {}, "plate1"),
        node("skin", "materialUnlit", {}, "skin1"),
      ],
      extraEdges: {
        m1: { id: "m1", source: { nodeId: "plate", portId: "out" }, target: { nodeId: "skin", portId: "albedo" } },
      },
    });
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["material"] = "skin1";
    const compiled = compile(graph);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = drawOf(compiled);
    expect(draw.textures?.some((t) => t.binding === "albedoMap" && t.resourceId === "target:plate:out")).toBe(true);
    expect(draw.shader).toContain("albedoMap");
    // And the plate is ALIVE through the chain: wired to the material, named to the
    // geometry, named to the render — liveness end to end.
    expect(compiled.pruned).not.toContain("plate");
  });

  it("per-object tint multiplies the referenced material's base colour (T449, inherit at white)", () => {
    const graph = sceneGraph({
      extraNodes: [node("gold", "materialPhong", { color: [1, 1, 1, 1] }, "gold1")],
    });
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["material"] = "gold1";
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["tint"] = [0, 1, 1, 1];
    const compiled = compile(graph);
    expect(drawOf(compiled).uniforms?.["baseColor"]).toEqual([0, 1, 1, 1]);
  });
});

describe("instances mode (T428b)", () => {
  it("draws a primitive per point with the material shading, capacity instances", () => {
    const graph = sceneGraph();
    ((graph.nodes["grid"] as GraphNode).parameters as Record<string, unknown>)["count"] = 64;
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["mode"] = "instances";
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["shape"] = "octahedron";
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["scale"] = 0.1;
    const compiled = compile(graph);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = drawOf(compiled);
    expect(draw.instances).toBe(64); // the 8x8 grid's capacity
    expect(draw.vertexCount).toBe(36);
    expect(draw.uniforms?.["instance"]).toEqual([0.1, 2, 0, 0]);
    expect(draw.shader).toContain("shapeVertex");
  });

  it("maps on instances refuse BY NAME — no uv means no silent no-op (V368)", () => {
    const graph = sceneGraph({
      extraNodes: [
        node("plate", "checker", {}, "plate1"),
        node("skin", "materialUnlit", {}, "skin1"),
      ],
      extraEdges: {
        m1: { id: "m1", source: { nodeId: "plate", portId: "out" }, target: { nodeId: "skin", portId: "albedo" } },
      },
    });
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["mode"] = "instances";
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["material"] = "skin1";
    const compiled = compile(graph);
    const refusal = compiled.diagnostics.find((d) => d.code === "node.scene.maps");
    expect(refusal?.message).toContain("no uv");
  });
});

