import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { pointStorageId } from "./point-storage.ts";

/**
 * Transform (T1205) — the structural half. The geometry itself is asserted on read-back
 * positions in `point-transform.gpu.test.ts`; what a render could not distinguish is here.
 *
 * Three claims:
 *
 * 1. THE PIVOT DECIDES THE PROGRAM. Origin and Point resolve at compile time, so the two
 *    centroid-reduction dispatches must not exist in those plans at all. A build that
 *    always reduced and then ignored the answer renders identically and costs two
 *    dispatches a frame on every graph that never asked for a centroid.
 * 2. §V197 COPY-ON-WRITE, AND IT IS THE OWNER'S QUESTION IN MECHANICAL FORM. He tried
 *    `geometry.scale` and got points that scaled themselves. Here the drawn frame reads
 *    its POSITIONS from this node's own storage and its per-point SIZE from the producer
 *    UPSTREAM of it — so the transform is not on the path a size travels, and cannot be.
 * 3. THE LIVE COUNT SURVIVES, which is exactly where this differs from `pointRange`.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  limits: { maxTextureDimension2D: 8192 },
  timestampQuery: false,
} as never;

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: `${id}1` }) as never;

const edge = (id: string, source: [string, string], target: [string, string]) => ({
  id,
  source: { nodeId: source[0], portId: source[1] },
  target: { nodeId: target[0], portId: target[1] },
});

/** A cloud carrying a SECOND attribute, so the by-reference claim has something to be about. */
const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "grow", type: "f32", default: [1] },
]);

const KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(f32(ctx.index) * 0.1, 0.0, 0.0);
  q.grow = 0.5;
  return q;
}`;

/** `geometry.scale` in MAP mode — the parameter the owner reached for, driven per point. */
const SIZE_MAP = {
  mode: "map",
  bindings: {
    static: { kind: "static", value: 0.05 },
    map: { kind: "map", attribute: "grow" },
  },
} as unknown as GraphNode["parameters"][string];

function graphWith(parameters: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      seed: node("seed", "pointGrid", { cols: 4, rows: 4, count: 16 }),
      cloud: node("cloud", "pointKernel", { capacity: 16, attributes: ATTRIBUTES, kernel: KERNEL }),
      move: node("move", "pointTransform", parameters),
      ink: node("ink", "materialUnlit", { color: [1, 1, 1, 1] }),
      dots: node("dots", "geometry", { mode: "points", material: "ink1", scale: SIZE_MAP }),
      cam: node("cam", "camera", { eye: [0, 0, 4], lookAt: [0, 0, 0], ortho: true, fov: 46, near: 0.1, far: 20 }),
      shot: node("shot", "render", { scenes: "dots1", camera: "cam1", lights: "", background: [0, 0, 0, 1] }),
      out: node("out", "output", {}),
    },
    edges: {
      e0: edge("e0", ["seed", "out"], ["cloud", "in"]),
      e1: edge("e1", ["cloud", "out"], ["move", "points"]),
      e2: edge("e2", ["move", "out"], ["dots", "points"]),
      e3: edge("e3", ["shot", "out"], ["out", "input"]),
    },
    groups: {},
  } as never;
}

const compile = (parameters: Record<string, unknown>) =>
  compileGraph({ graph: graphWith(parameters) as never, settings: SETTINGS, registry, capabilities: CAPABILITIES });

type Pass = ReturnType<typeof compile>["passes"][number];
type Binding = { binding: string; resourceId: string };

const buffersOf = (pass: Pass | undefined): ReadonlyArray<Binding> =>
  ((pass as { buffers?: ReadonlyArray<Binding> } | undefined)?.buffers ?? []) as ReadonlyArray<Binding>;

const dispatchIdsOf = (plan: ReturnType<typeof compile>) =>
  plan.passes
    .filter((pass) => pass.kind === "dispatch" && pass.nodeId === "move")
    .map((pass) => pass.id.replace(/^move#/, ""));

const passNamed = (plan: ReturnType<typeof compile>, id: string): Pass | undefined =>
  plan.passes.find((pass) => pass.id.replace(/^move#/, "") === id);

describe("pointTransform's plan (T1205)", () => {
  it("emits the centroid reduction ONLY for the centroid pivot", () => {
    const centroid = compile({ pivot: "centroid", scale: [2, 2, 2] });
    expect(centroid.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Three passes, in order: block partials, the one-thread finalize, then the apply.
    expect(dispatchIdsOf(centroid)).toEqual([
      "move:transform:centroid",
      "move:transform:centroid:finalize",
      "move:transform:apply:centroid",
    ]);
    expect(centroid.resources.some((resource) => resource.id === `scratch:move:partials`)).toBe(true);
    expect(centroid.resources.some((resource) => resource.id === `scratch:move:centroid`)).toBe(true);

    // §V62b: the other two pivots are constants, so the reduction is not merely unread —
    // it is not planned, and its scratch is not allocated.
    for (const pivot of ["origin", "point"]) {
      const plan = compile({ pivot, scale: [2, 2, 2] });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(dispatchIdsOf(plan)).toEqual([`move:transform:apply:${pivot}`]);
      expect(plan.resources.some((resource) => resource.id === `scratch:move:partials`)).toBe(false);
      expect(plan.resources.some((resource) => resource.id === `scratch:move:centroid`)).toBe(false);
    }
  });

  it("draws positions from the transform and per-point SIZE from upstream of it (§V197)", () => {
    const plan = compile({ pivot: "centroid", scale: [3, 3, 3] });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    // It writes exactly one buffer, its own, and reads the producer's.
    const apply = passNamed(plan, "move:transform:apply:centroid");
    expect(buffersOf(apply).filter((b) => b.binding === "out_position").map((b) => b.resourceId)).toEqual([
      pointStorageId("move"),
    ]);
    expect(buffersOf(apply).filter((b) => b.binding === "in_position").map((b) => b.resourceId)).toEqual([
      pointStorageId("cloud"),
    ]);

    /* ⚑ THE OWNER'S QUESTION, AS A BINDING. The draw's positions come from `move`; its
       per-point scale comes from `cloud`, the producer UPSTREAM of the transform. So a
       node that spreads the cloud out is not on the path a SIZE travels and could not
       change one if it tried — which is the difference between this and the
       `geometry.scale` he reached for, stated where it is true rather than inferred from
       a picture. */
    const scene = plan.passes.find((pass) => pass.kind === "draw" && buffersOf(pass).length > 0);
    expect(scene).toBeDefined();
    expect(
      buffersOf(scene).map((b) => `${b.binding}=${b.resourceId}`),
    ).toEqual([`positions=${pointStorageId("move")}`, `pointScales=${pointStorageId("cloud")}`]);
  });

  it("republishes the live count, which is the difference from pointRange", () => {
    /* A counted producer's contract is "the first N slots are live, CONTIGUOUS". A range
       filter parks survivors in place, which breaks contiguity, so it drops the count on
       purpose. A transform moves points without moving SLOTS, so the claim survives — and
       dropping it would silently put every downstream draw back on capacity, drawing the
       dead tail. */
    const counted = {
      revision: 1,
      nodes: {
        cloud: node("cloud", "pointKernelAdvanced", {
          capacity: 64,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            { name: "id", type: "u32", semantic: "id", default: [0] },
          ]),
          kernel: "fn process(p: Point, ctx: PointCtx) -> Point { return p; }",
        }),
        move: node("move", "pointTransform", { pivot: "centroid", scale: [2, 2, 2] }),
        draw: node("draw", "renderPoints", { count: 64, sizePixels: 4 }),
        out: node("out", "output", {}),
      },
      edges: {
        e1: edge("e1", ["cloud", "out"], ["move", "points"]),
        e2: edge("e2", ["move", "out"], ["draw", "points"]),
        e3: edge("e3", ["draw", "out"], ["out", "input"]),
      },
      groups: {},
    } as never;
    const plan = compileGraph({ graph: counted, settings: SETTINGS, registry, capabilities: CAPABILITIES });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    // The reduction binds the upstream count, so a dead tail is never averaged in…
    const partials = passNamed(plan, "move:transform:centroid:counted");
    expect(partials).toBeDefined();
    expect(buffersOf(partials).map((b) => b.binding)).toContain("in_count");

    // …and the draw downstream still draws INDIRECTLY, which it can only do off a count
    // this node handed on.
    const draw = plan.passes.find((pass) => pass.kind === "draw" && pass.nodeId === "draw");
    expect(JSON.stringify(draw)).toContain("indirect");
  });

  it("refuses an unwired node rather than compiling an empty transform", () => {
    const orphan = {
      revision: 1,
      nodes: {
        move: node("move", "pointTransform", { pivot: "centroid" }),
        draw: node("draw", "renderPoints", { count: 16, sizePixels: 4 }),
        out: node("out", "output", {}),
      },
      edges: {
        e1: edge("e1", ["move", "out"], ["draw", "points"]),
        e2: edge("e2", ["draw", "out"], ["out", "input"]),
      },
      groups: {},
    } as never;
    const plan = compileGraph({ graph: orphan, settings: SETTINGS, registry, capabilities: CAPABILITIES });
    expect(plan.diagnostics.some((d) => d.severity === "error" && d.nodeId === "move")).toBe(true);
  });
});
