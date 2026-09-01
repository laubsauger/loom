import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { POSE_KEYPOINT_COUNT } from "../../runtime/models/pose-runner.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";

/**
 * Pose, and the node that makes its output mean something (T743).
 *
 * §T386 said keypoints should "feed the whole existing point and instancing catalogue"
 * rather than being a dead-end overlay. That was aspirational until `pointsFromTexture`
 * existed, so the chain itself is the claim under test here — not either node alone.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();
const compile = (graph: GraphDocument) => compileGraph({ graph, settings, registry, capabilities });

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: registry.get(type)?.version ?? 1, position: { x: 0, y: 0 }, parameters };
}
function edge(id: string, from: [string, string], to: [string, string]) {
  return { id, source: { nodeId: from[0], portId: from[1] }, target: { nodeId: to[0], portId: to[1] } };
}
const errorsOf = (plan: { diagnostics: ReadonlyArray<{ severity: string; message: string }> }) =>
  plan.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

describe("Pose compiles as the same shape as Depth", () => {
  const graph: GraphDocument = {
    revision: 1,
    nodes: {
      cam: node("cam", "noise", { type: "simplex2d" }),
      pose: node("pose", "pose"),
      out: node("out", "output"),
    },
    edges: {
      e1: edge("e1", ["cam", "out"], ["pose", "input"]),
      e2: edge("e2", ["pose", "out"], ["out", "input"]),
    },
    groups: {},
  } as never;

  it("compiles with no errors", () => {
    expect(errorsOf(compile(graph))).toEqual([]);
  });

  it("declares the same two halves inference always declares", () => {
    // The finding, as an assertion: pose needed no new resource kind. A storage buffer in,
    // an external texture out — analyze's route and webcam's route, exactly as depth.
    const plan = compile(graph);
    const input = plan.resources.find((r) => r.id === scratchResourceId("pose", "modelInput"));
    const result = plan.resources.find((r) => r.id === scratchResourceId("pose", "modelResult"));
    expect(input?.kind).toBe("buffer");
    expect(result?.kind).toBe("externalTexture");
    expect((result as { sourceId?: string }).sourceId).toBe("infer:pose");
  });

  it("emits a 17x1 keypoint map in half float, not a picture", () => {
    // Fixed, not inherited: resampling seventeen measurements across a million texels
    // would smear them and invite someone to composite the result.
    const plan = compile(graph);
    const result = plan.resources.find((r) => r.id === scratchResourceId("pose", "modelResult")) as
      | { size?: readonly [number, number]; format?: string }
      | undefined;
    expect(result?.size).toEqual([POSE_KEYPOINT_COUNT, 1]);
    expect(result?.format).toBe("rgba16float");
  });

  it("prunes when unwired, so placing one downloads nothing", () => {
    const orphan = { ...graph, nodes: { ...graph.nodes, lonely: node("lonely", "pose") } } as GraphDocument;
    expect(compile(orphan).order).not.toContain("lonely");
  });
});

describe("keypoints reach the point and instancing catalogue", () => {
  /**
   * §T386's claim, finally testable. Pose -> Points From Texture -> Render Instances: the
   * model decides where seventeen points are and the existing instancing machinery draws
   * whatever you like at each one. Nothing here is pose-specific except the node at the
   * front.
   */
  it("compiles Pose -> Points From Texture -> Render Instances", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        cam: node("cam", "noise", { type: "simplex2d" }),
        pose: node("pose", "pose"),
        joints: node("joints", "pointsFromTexture", { mode: "value", cols: POSE_KEYPOINT_COUNT, rows: 1 }),
        draw: node("draw", "renderInstances"),
        out: node("out", "output"),
      },
      edges: {
        e1: edge("e1", ["cam", "out"], ["pose", "input"]),
        e2: edge("e2", ["pose", "out"], ["joints", "texture"]),
        e3: edge("e3", ["joints", "out"], ["draw", "points"]),
        e4: edge("e4", ["draw", "out"], ["out", "input"]),
      },
      groups: {},
    } as never;

    const plan = compile(graph);
    expect(errorsOf(plan)).toEqual([]);
    expect(plan.order.indexOf("pose")).toBeLessThan(plan.order.indexOf("joints"));
    expect(plan.order.indexOf("joints")).toBeLessThan(plan.order.indexOf("draw"));
  });

  it("allocates exactly one point per keypoint in Value mode", () => {
    // cols x rows IS the point count. Seventeen joints must not become a 128x128 lattice
    // of mostly-parked points, which is what the Grid default would give.
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        cam: node("cam", "noise", { type: "simplex2d" }),
        pose: node("pose", "pose"),
        joints: node("joints", "pointsFromTexture", { mode: "value", cols: POSE_KEYPOINT_COUNT, rows: 1 }),
        draw: node("draw", "renderInstances"),
        out: node("out", "output"),
      },
      edges: {
        e1: edge("e1", ["cam", "out"], ["pose", "input"]),
        e2: edge("e2", ["pose", "out"], ["joints", "texture"]),
        e3: edge("e3", ["joints", "out"], ["draw", "points"]),
        e4: edge("e4", ["draw", "out"], ["out", "input"]),
      },
      groups: {},
    } as never;

    const plan = compile(graph);
    const pair = plan.resources.find((r) => r.id.includes("joints") && r.id.includes("position")) as
      | { capacity?: number }
      | undefined;
    expect(pair?.capacity).toBe(POSE_KEYPOINT_COUNT);
  });
});

describe("Points From Texture serves Depth too, which is why it exists", () => {
  /**
   * The reason this node earns its place is not pose: a Depth map in Grid mode is a live
   * point cloud, which is worth more than either node alone.
   */
  it("compiles Depth -> Points From Texture -> Render Instances as a point cloud", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        cam: node("cam", "noise", { type: "simplex2d" }),
        depth: node("depth", "depth"),
        cloud: node("cloud", "pointsFromTexture", { mode: "grid", cols: 64, rows: 64, depth: 2 }),
        draw: node("draw", "renderInstances"),
        out: node("out", "output"),
      },
      edges: {
        e1: edge("e1", ["cam", "out"], ["depth", "input"]),
        e2: edge("e2", ["depth", "out"], ["cloud", "texture"]),
        e3: edge("e3", ["cloud", "out"], ["draw", "points"]),
        e4: edge("e4", ["draw", "out"], ["out", "input"]),
      },
      groups: {},
    } as never;

    const plan = compile(graph);
    expect(errorsOf(plan)).toEqual([]);
    const pair = plan.resources.find((r) => r.id.includes("cloud") && r.id.includes("position")) as
      | { capacity?: number }
      | undefined;
    expect(pair?.capacity).toBe(64 * 64);
  });

  it("publishes grid topology in Grid mode and none in Value mode", () => {
    // Claiming a lattice over keypoints would let a surface be spanned across unrelated
    // joints — a mesh from the nose to the left ankle.
    const build = (mode: string) =>
      ({
        revision: 1,
        nodes: {
          cam: node("cam", "noise", { type: "simplex2d" }),
          depth: node("depth", "depth"),
          pts: node("pts", "pointsFromTexture", { mode, cols: 8, rows: 4 }),
          draw: node("draw", "renderInstances"),
          out: node("out", "output"),
        },
        edges: {
          e1: edge("e1", ["cam", "out"], ["depth", "input"]),
          e2: edge("e2", ["depth", "out"], ["pts", "texture"]),
          e3: edge("e3", ["pts", "out"], ["draw", "points"]),
          e4: edge("e4", ["draw", "out"], ["out", "input"]),
        },
        groups: {},
      }) as never as GraphDocument;

    expect(errorsOf(compile(build("grid")))).toEqual([]);
    expect(errorsOf(compile(build("value")))).toEqual([]);
  });

  it("refuses with a named diagnostic when nothing is wired to its texture", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        pts: node("pts", "pointsFromTexture"),
        draw: node("draw", "renderInstances"),
        out: node("out", "output"),
      },
      edges: {
        e1: edge("e1", ["pts", "out"], ["draw", "points"]),
        e2: edge("e2", ["draw", "out"], ["out", "input"]),
      },
      groups: {},
    } as never;
    expect(errorsOf(compile(graph)).join(" ")).toMatch(/texture/i);
  });
});
