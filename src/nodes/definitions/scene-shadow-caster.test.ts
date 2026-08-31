import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";

/**
 * T666 — WHO CASTS. §V610 said a camera-facing billboard casts no shadow, because a
 * card with no light-facing geometry would cast a lie. That skip is written against the
 * MODE, so it reaches points mode and nothing else — and E34-Lidar found the gap by
 * looking: 480 unlit octahedra in INSTANCES mode cast hard, texel-quantised shadows down
 * every grazing slope, and the black combing was the entire visible shadow content of
 * that example. Rendering its terrain alone showed the ground self-shadows almost
 * nowhere.
 *
 * The rule this file pins is a MATERIAL fact rather than a per-object switch (§V437):
 * an unlit surface declares that it does not take part in lighting, so it does not
 * block light either. A reading, a marker, an overlay, a glow sprite — none of them are
 * matter. The lit shader already declined ambient occlusion for an unlit model; this is
 * the other half of that symmetry.
 *
 * §V461 cuts hard here and dictates the fixture: EVERY case below is in INSTANCES mode,
 * because a points-mode fixture passes today AND would have passed before the change.
 * The two-geometry scenes are the shape that catches a rule applied to the wrong one.
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

/**
 * Two INSTANCED clouds under one casting light, each with its own material. `lit1` is
 * the default lambert; `mark1` is whatever the case asks for. Both are instances, so
 * §V610's mode skip touches neither and the only thing that can separate them is the
 * material.
 */
function twoClouds(
  markMaterial: "materialUnlit" | "materialPhong" | null,
  renderParams: Record<string, unknown> = {},
  markMode: "instances" | "points" | "surface" = "instances",
): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("gridA", "pointGrid", { cols: 8, rows: 8 }, "gridA1"),
        node("gridB", "pointGrid", { cols: 8, rows: 8 }, "gridB1"),
        node("lit", "geometry", { mode: "instances", shape: "box" }, "lit1"),
        node("mark", "geometry", { mode: markMode, shape: "box", material: markMaterial === null ? "" : "mark1" }, "mark1g"),
        node("cam", "camera", { eye: [0, 2, 4], lookAt: [0, 0, 0] }, "cam1"),
        node("sun", "light", { kind: "directional", direction: [0.3, -0.8, -0.4], shadows: true, shadowExtent: 3 }, "sun1"),
        node("shot", "render", { scenes: "lit1 mark1g", camera: "cam1", lights: "sun1", ...renderParams }, "shot1"),
        node("out", "output", {}, "out1"),
        ...(markMaterial === null ? [] : [node("mat", markMaterial, {}, "mark1")]),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "gridA", portId: "out" }, target: { nodeId: "lit", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "gridB", portId: "out" }, target: { nodeId: "mark", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

type Pass = { id: string; shader?: string; target?: string };

/** Ids of the geometry draws inside one depth sweep — the `:clear` plate is not one. */
function sweepDraws(graph: GraphDocument, prefix: string): string[] {
  const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  return (plan.passes as unknown as Pass[])
    .map((pass) => pass.id)
    .filter((id) => id.includes(prefix) && !id.endsWith(":clear"))
    .map((id) => id.slice(id.indexOf("#") + 1));
}

describe("T666: an unlit geometry casts no shadow, in EVERY draw mode (§V610 generalised)", () => {
  it("two instanced clouds, one unlit: the lit one casts and the unlit one does not", () => {
    // Geometry index 0 is `lit1`, index 1 is `mark1g` — draw order is list order.
    expect(sweepDraws(twoClouds("materialUnlit"), ":shadow:")).toEqual(["shot:shadow:0:0"]);
  });

  it("the same fixture with a LIT material casts both — the rule is the material, not the mode", () => {
    // The control §V461 asks for. Without it, "no shadows at all" passes the case above.
    expect(sweepDraws(twoClouds("materialPhong"), ":shadow:")).toEqual([
      "shot:shadow:0:0",
      "shot:shadow:0:1",
    ]);
    // And with no material named at all, the default lambert casts too.
    expect(sweepDraws(twoClouds(null), ":shadow:")).toEqual(["shot:shadow:0:0", "shot:shadow:0:1"]);
  });

  it("it reaches AMBIENT OCCLUSION as well — occlusion is light that fails to arrive", () => {
    expect(sweepDraws(twoClouds("materialUnlit", { ambientOcclusion: true }), ":ao:depth")).toEqual([
      "shot:ao:depth:0",
    ]);
    expect(sweepDraws(twoClouds("materialPhong", { ambientOcclusion: true }), ":ao:depth")).toEqual([
      "shot:ao:depth:0",
      "shot:ao:depth:1",
    ]);
  });

  it("§V610 still holds: a points-mode billboard is skipped whatever its material", () => {
    // A LIT billboard — so this can only pass through the mode skip, not the new one.
    expect(sweepDraws(twoClouds("materialPhong", {}, "points"), ":shadow:")).toEqual(["shot:shadow:0:0"]);
  });

  it("a SURFACE with an unlit material is skipped too — a screen is not a wall", () => {
    expect(sweepDraws(twoClouds("materialUnlit", {}, "surface"), ":shadow:")).toEqual(["shot:shadow:0:0"]);
  });
});
