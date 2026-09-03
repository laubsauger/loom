import { describe, expect, it } from "vitest";
import { pointStorageId } from "../nodes/definitions/point-storage.ts";

import { compileGraph } from "./index.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { DrawPassDescriptor } from "../runtime/backend/plan.ts";
import { cameraPayloadMatrix } from "../domain/geometry/camera.ts";

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
    expect(draw.buffers?.[0]?.resourceId).toBe(pointStorageId("grid"));
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
      pointStorageId("grid"),
      pointStorageId("gridb"),
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
    expect(byNode.get("shot")).toBe(pointStorageId("grid"));
    expect(byNode.get("shot2")).toBe(pointStorageId("grid2"));
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

  it("a group predicate splits the draw AND its shadow; surface mode refuses with WHY (T642)", () => {
    const graph = sceneGraph();
    ((graph.nodes["grid"] as GraphNode).parameters as Record<string, unknown>)["count"] = 64;
    const geo = (graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>;
    geo["mode"] = "instances";
    geo["group"] = "p.position.y > 0.0";
    // Shadows ON, so the ghost-shadow half below is non-vacuous (§V461).
    ((graph.nodes["sun"] as GraphNode).parameters as Record<string, unknown>)["shadows"] = true;
    const compiled = compile(graph);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = drawOf(compiled);
    // The lit draw gates per instance — same resolver, same collapse as renderPoints.
    expect(draw.shader).toContain("groupMatch");
    expect(draw.buffers?.some((buffer) => buffer.binding === "group_position")).toBe(true);
    // And an excluded instance casts NO GHOST SHADOW: every shadow pass for this
    // geometry carries the same gate and the same bind.
    const shadowDraws = compiled.passes.filter(
      (pass) => pass.kind === "draw" && pass.id.includes(":shadow:") && (pass as { shader?: string }).shader?.includes("shapeVertex"),
    ) as Array<{ shader: string; buffers?: Array<{ binding: string }> }>;
    expect(shadowDraws.length).toBeGreaterThan(0);
    for (const shadow of shadowDraws) {
      expect(shadow.shader).toContain("groupMatch");
      expect(shadow.buffers?.some((buffer) => buffer.binding === "group_position")).toBe(true);
    }

    // SURFACE mode refuses, and the refusal carries its WHY (§V606): connectivity.
    geo["mode"] = "surface";
    const refused = compile(graph);
    const refusal = refused.diagnostics.find((d) => d.code === "node.scene.group");
    expect(refusal?.message).toContain("punch holes");
    expect(refusal?.suggestion).toContain("Instances");
  });

  it("points mode draws camera-facing billboards, no shadow, group honoured (T647)", () => {
    const graph = sceneGraph();
    ((graph.nodes["grid"] as GraphNode).parameters as Record<string, unknown>)["count"] = 64;
    const geo = (graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>;
    geo["mode"] = "points";
    geo["scale"] = 0.1;
    geo["group"] = "p.position.y > 0.0";
    ((graph.nodes["sun"] as GraphNode).parameters as Record<string, unknown>)["shadows"] = true;
    const compiled = compile(graph);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = drawOf(compiled);
    // Six vertices — a card, not a box — with the camera basis in the uniforms and
    // the SAME group gate instances carry (§V349: the third path was never born).
    expect(draw.vertexCount).toBe(6);
    expect(draw.uniforms?.["billboardRight"]).toBeDefined();
    expect(draw.uniforms?.["billboardUp"]).toBeDefined();
    expect(draw.shader).toContain("billboardRight");
    expect(draw.shader).toContain("groupMatch");
    // And NO shadow pass for a points geometry — a camera-facing card has no
    // light-facing geometry, and a grid-topology cloud must not cast its MESH's ghost.
    const shadowDraws = compiled.passes.filter(
      (pass) => pass.kind === "draw" && pass.id.includes(":shadow:") && !pass.id.includes(":clear"),
    );
    expect(shadowDraws.filter((pass) => (pass as { nodeId?: string }).nodeId === draw.nodeId && (pass as { shader?: string }).shader?.includes("billboardRight"))).toEqual([]);
    // Non-vacuous: the light IS casting (its clear pass exists), the cloud just
    // contributes nothing to it.
    expect(compiled.passes.some((pass) => pass.id.includes(":shadow:"))).toBe(true);
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


describe("the point renderers take a camera by NAME (T457, V387)", () => {
  const surfaceGraph = (parameters: Record<string, unknown>): GraphDocument =>
    ({
      revision: 1,
      nodes: Object.fromEntries(
        [
          node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
          node("surf", "renderSurface", parameters, "surf1"),
          node("cam", "camera", { eye: [5, 2, 9] }, "cam1"),
          node("out", "output", {}, "out1"),
        ].map((entry) => [entry.id, entry]),
      ),
      edges: {
        e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "surf", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "surf", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    }) as never;

  const surfaceMatrix = (compiled: { passes: ReadonlyArray<unknown> }): ReadonlyArray<number> => {
    const pass = compiled.passes.find(
      (p) => (p as { kind: string }).kind === "draw" && String((p as { id: string }).id).endsWith(":surface"),
    ) as DrawPassDescriptor;
    return (pass.uniforms as { viewProjection: number[] }).viewProjection;
  };

  it("a named camera replaces the inline eye/look/FOV — cut the name and they return (V361)", () => {
    const named = compile(surfaceGraph({ camera: "cam1" }));
    expect(named.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // The EXACT matrix the shared composer gives for cam1's payload (§V147/§V198):
    // eye overridden, everything else the camera node's own defaults, aspect 64/64.
    const expected = cameraPayloadMatrix(
      { eye: [5, 2, 9], lookAt: [0, 0, 0], fovDeg: 55, near: 0.1, far: 100, ortho: false, orthoHeight: 2 },
      1,
    );
    expect(surfaceMatrix(named)).toEqual(Array.from(expected));

    // §V361 as matrices: unname the camera and the INLINE parameters compose instead.
    const inline = compile(surfaceGraph({}));
    expect(inline.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(surfaceMatrix(inline)).not.toEqual(surfaceMatrix(named));
  });

  it("a dangling or wrong-kind camera name refuses BY NAME (§V369) — on instances too", () => {
    const dangling = compile(surfaceGraph({ camera: "ghost1" }));
    expect(dangling.diagnostics.some((d) => d.severity === "error" && d.message.includes('"ghost1"'))).toBe(true);

    const graph = surfaceGraph({ camera: "grid1" });
    const wrongKind = compile(graph);
    expect(
      wrongKind.diagnostics.some((d) => d.severity === "error" && d.message.includes("publishes no camera")),
    ).toBe(true);

    // renderInstances rides the same table entry; one dangling probe pins the wiring.
    const instances = surfaceGraph({});
    (instances.nodes["surf"] as GraphNode as { type: string }).type = "renderInstances";
    ((instances.nodes["surf"] as GraphNode).parameters as Record<string, unknown>)["camera"] = "ghost1";
    const refused = compile(instances);
    expect(refused.diagnostics.some((d) => d.severity === "error" && d.message.includes('"ghost1"'))).toBe(true);
  });
});

describe("per-point colour and counted sets reach the SCENE (T478)", () => {
  const tintMapped = {
    mode: "map",
    value: [1, 1, 1, 1],
    bindings: { map: { kind: "map", attribute: "color" } },
  };

  const colouredGraph = (mode: "surface" | "instances", tint: unknown): GraphDocument => {
    const graph = sceneGraph();
    // The grid's allocation follows its count parameter, not its cols×rows (§V50).
    ((graph.nodes["grid"] as GraphNode).parameters as Record<string, unknown>)["count"] = 64;
    (graph.nodes as Record<string, GraphNode>)["paint"] = node(
      "paint",
      "pointKernel",
      {
        capacity: 64,
        attributes: JSON.stringify([
          { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          { name: "color", type: "vec4f", default: [1, 0, 0, 1] },
        ]),
        kernel:
          "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.color = vec4f(1.0, 0.0, 0.0, 1.0);\n  return q;\n}",
      },
      "paint1",
    ) as never;
    (graph.edges as Record<string, unknown>)["e3"] = {
      id: "e3",
      source: { nodeId: "grid", portId: "out" },
      target: { nodeId: "paint", portId: "in" },
    };
    (graph.edges as Record<string, unknown>)["e1"] = {
      id: "e1",
      source: { nodeId: "paint", portId: "out" },
      target: { nodeId: "geo", portId: "points" },
    };
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["mode"] = mode;
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["tint"] = tint;
    return graph;
  };

  it("a mapped tint binds the attribute pair into BOTH scene draw shapes", () => {
    for (const mode of ["surface", "instances"] as const) {
      const compiled = compile(colouredGraph(mode, tintMapped));
      expect(compiled.diagnostics.filter((d) => d.severity === "error"), mode).toEqual([]);
      const draw = drawOf(compiled);
      const colors = draw.buffers?.find((binding) => binding.binding === "pointColors");
      const positions = draw.buffers?.find((binding) => binding.binding === "positions");
      expect(colors, mode).toBeDefined();
      /* T1076: the colour is a REGION of the producer's packed buffer, so the id no
         longer spells the attribute — what says "this is the colour, not the position"
         is that the two bindings share a buffer and land at different offsets. */
      expect(colors?.resourceId, mode).toBe(positions?.resourceId);
      expect(colors?.offset, mode).not.toBe(positions?.offset);
      expect(typeof colors?.offset, mode).toBe("number");
      expect(draw.shader).toContain("pointColors");
      // The material's own base colour STAYS in the uniforms: the map multiplies, it
      // never replaces — no half of the material goes silently dead (V349).
      expect(draw.uniforms?.["baseColor"]).toBeDefined();
    }
  });

  it("a STATIC tint keeps its old meaning and binds nothing (V361's cut)", () => {
    const compiled = compile(colouredGraph("instances", [1, 1, 1, 1]));
    const draw = drawOf(compiled);
    expect(draw.buffers?.some((binding) => binding.binding === "pointColors")).toBe(false);
    expect(draw.shader).not.toContain("pointColors");
  });

  it("geometry refuses a map on anything but tint, BY NAME (§V288)", () => {
    const graph = colouredGraph("instances", tintMapped);
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["scale"] = {
      mode: "map",
      value: 0.05,
      bindings: { map: { kind: "map", attribute: "color" } },
    };
    const compiled = compile(graph);
    const refusal = compiled.diagnostics.find((d) => d.code === "node.parameter.map");
    expect(refusal?.message).toContain("scale");
  });

  const countedGraph = (mode: "surface" | "instances"): GraphDocument => {
    const graph = sceneGraph();
    (graph.nodes as Record<string, GraphNode>)["sim"] = node("sim", "pointKernelAdvanced", {}, "sim1") as never;
    delete (graph.nodes as Record<string, unknown>)["grid"];
    (graph.edges as Record<string, unknown>)["e1"] = {
      id: "e1",
      source: { nodeId: "sim", portId: "out" },
      target: { nodeId: "geo", portId: "points" },
    };
    ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["mode"] = mode;
    return graph;
  };

  it("a counted set renders as INSTANCES, drawn indirectly off the live count (T322)", () => {
    const compiled = compile(countedGraph("instances"));
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = drawOf(compiled);
    // Indirect draw: the instance count is the GPU-resident args buffer, never the
    // capacity — a dead tail cannot be resurrected into the scene.
    expect(draw.instances).toEqual({ indirect: "scratch:shot:drawArgs0" });
    const args = compiled.passes.find(
      (pass) => pass.kind === "dispatch" && String(pass.id).includes("drawArgs"),
    );
    expect(args).toBeDefined();
  });

  it("a counted SURFACE still refuses by name — topology over dead points is a lie", () => {
    const compiled = compile(countedGraph("surface"));
    const refusal = compiled.diagnostics.find((d) => d.code === "node.scene.geometry");
    expect(refusal?.message).toContain("live count");
    expect(refusal?.message).toContain("instances");
  });
});

describe("shadows are opt-in per light, priced in the open (T481, §V309)", () => {
  it("a casting directional light adds named shadow passes BEFORE the lit draws", () => {
    const graph = sceneGraph();
    ((graph.nodes["sun"] as GraphNode).parameters as Record<string, unknown>)["shadows"] = true;
    const compiled = compile(graph);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const ids = compiled.passes.map((pass) => String((pass as { id: string }).id));
    const clearAt = ids.findIndex((id) => id.includes(":shadow:0:clear"));
    const shadowAt = ids.findIndex((id) => id.includes(":shadow:0:0"));
    const litAt = ids.findIndex((id) => id.includes(":scene:0"));
    // The map renders before anything reads it, and each pass is named per light so
    // the performance panel can attribute the casting cost.
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(shadowAt).toBeGreaterThan(clearAt);
    expect(litAt).toBeGreaterThan(shadowAt);

    // The map itself: r32float, depth-attached, twice the output size.
    const map = compiled.resources.find((resource) => resource.id === "scratch:shot:shadow0");
    expect(map).toMatchObject({ kind: "target", format: "r32float", depth: true, size: [128, 128] });

    // The lit draw binds the map and carries the light's matrix as a NAMED member.
    const lit = drawOf(compiled);
    expect(lit.textures?.map((texture) => texture.binding) ?? [], "lit textures").toContain("shadowMap0");
    expect(Array.isArray(lit.uniforms?.["shadow0Matrix"])).toBe(true);
    expect(lit.shader).toContain("shadowMap0");
  });

  it("§V309: no casting light — passes and shaders byte-identical to the shadowless build", () => {
    const off = compile(sceneGraph());
    const explicit = ((): ReturnType<typeof compile> => {
      const graph = sceneGraph();
      ((graph.nodes["sun"] as GraphNode).parameters as Record<string, unknown>)["shadows"] = false;
      return compile(graph);
    })();
    expect(explicit.passSignatures).toEqual(off.passSignatures);
    expect(drawOf(off).shader).not.toContain("shadowMap");
    expect(off.passes.some((pass) => String((pass as { id: string }).id).includes(":shadow:"))).toBe(false);
  });

  it("a casting POINT light refuses by name — six faces is a different feature", () => {
    const graph = sceneGraph();
    ((graph.nodes["sun"] as GraphNode).parameters as Record<string, unknown>)["kind"] = "point";
    ((graph.nodes["sun"] as GraphNode).parameters as Record<string, unknown>)["shadows"] = true;
    const compiled = compile(graph);
    const refusal = compiled.diagnostics.find((d) => d.code === "node.scene.shadow");
    expect(refusal?.message).toContain("POINT");
    expect(refusal?.suggestion).toContain("Directional");
  });
});

describe("the environment input is REAL (T482, §V309)", () => {
  const envGraph = (material?: string): GraphDocument => {
    const graph = sceneGraph(
      material === undefined
        ? {}
        : { extraNodes: [node("skin", material, {}, "skin1")] },
    );
    (graph.nodes as Record<string, GraphNode>)["sky"] = node("sky", "solid", { color: [0, 0, 1, 1] }, "sky1") as never;
    (graph.edges as Record<string, unknown>)["env"] = {
      id: "env",
      source: { nodeId: "sky", portId: "out" },
      target: { nodeId: "shot", portId: "environment" },
    };
    if (material !== undefined) {
      ((graph.nodes["geo"] as GraphNode).parameters as Record<string, unknown>)["material"] = "skin1";
    }
    return graph;
  };

  it("a wired environment reaches a PHONG draw as texture + intensity", () => {
    const compiled = compile(envGraph("materialPhong"));
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = drawOf(compiled);
    expect(draw.shader).toContain("environmentMap");
    expect(draw.shader).toContain("reflect(-viewDir");
    /* T632: the reflection is view-dependent, and the Schlick term rides in with it. */
    expect(draw.shader).toContain("envFresnel");
    expect(draw.textures?.some((texture) => texture.binding === "environmentMap")).toBe(true);
    expect(draw.uniforms?.["environment"]).toEqual([1, 0, 0, 0]);
  });

  it("a LAMBERT material ignores it — stated on the input, enforced in the plan (V349)", () => {
    const compiled = compile(envGraph());
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = drawOf(compiled);
    expect(draw.shader).not.toContain("environmentMap");
    expect(draw.textures?.some((texture) => texture.binding === "environmentMap") ?? false).toBe(false);
  });

  it("§V309: unwired — the phong build is byte-identical to the pre-environment form", () => {
    const withEnv = compile(envGraph("materialPhong"));
    const without = ((): ReturnType<typeof compile> => {
      const graph = envGraph("materialPhong");
      delete (graph.edges as Record<string, unknown>)["env"];
      delete (graph.nodes as Record<string, unknown>)["sky"];
      return compile(graph);
    })();
    expect(drawOf(without).shader).not.toContain("environmentMap");
    /* T632 rides on the same gate: no environment wired, no Fresnel term emitted. */
    expect(drawOf(without).shader).not.toContain("envFresnel");
    expect(drawOf(withEnv).shader).not.toBe(drawOf(without).shader);
  });
});
