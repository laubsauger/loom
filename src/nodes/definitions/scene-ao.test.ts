import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { sceneInstancesWgsl, sceneSurfaceWgsl, shadowInstancesWgsl, shadowSurfaceWgsl } from "../shaders/scene-render.wgsl.ts";
import { AO_SAMPLE_COUNTS, aoSampleCount } from "../shaders/scene-ao.wgsl.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";

/**
 * T624 — AMBIENT OCCLUSION as a render capability, at the compiler level.
 *
 * What this file exists to stop, in order of how expensive each would be to find later:
 *
 *  (a) AO delivered SITE BY SITE (§V437). The gate is that turning the ONE switch on
 *      reaches EVERY geometry the render names — asserted over a two-geometry scene,
 *      because a per-geometry opt-in passes a one-geometry test perfectly.
 *  (b) AO OFF changing anything (§V309). Every emitted shader and every pass must be
 *      byte-identical to what the render emitted before the feature existed, which is
 *      why the shadow generators are compared against their own no-option output.
 *  (c) The shader and the compiler disagreeing about whether a map is BOUND. A shader
 *      that declares `occlusionMap` with no texture bound, or a texture bound to a
 *      shader that never declared it, is a pipeline error at device time and nothing
 *      earlier catches it — so the two decisions are asserted to agree, including the
 *      unlit case where the shader deliberately declines AO.
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

/** Two geometries under one render — the shape that catches a per-node opt-in. */
function twoObjectScene(renderParams: Record<string, unknown>, material = ""): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("gridA", "pointGrid", { cols: 8, rows: 8 }, "gridA1"),
        node("gridB", "pointGrid", { cols: 8, rows: 8 }, "gridB1"),
        node("geoA", "geometry", { mode: "surface", material }, "geoA1"),
        node("geoB", "geometry", { mode: "instances", shape: "box", material }, "geoB1"),
        node("cam", "camera", {}, "cam1"),
        node("sun", "light", {}, "sun1"),
        node("shot", "render", { scenes: "geoA1 geoB1", camera: "cam1", lights: "sun1", ...renderParams }, "shot1"),
        node("out", "output", {}, "out1"),
        ...(material === "" ? [] : [node("mat", "materialUnlit", {}, material)]),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "gridA", portId: "out" }, target: { nodeId: "geoA", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "gridB", portId: "out" }, target: { nodeId: "geoB", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

type Pass = {
  id: string;
  shader?: string;
  target?: string;
  textures?: ReadonlyArray<{ binding: string; resourceId: string }>;
  uniforms?: Record<string, unknown>;
};

const planOf = (graph: GraphDocument) => {
  const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return plan;
};

describe("T624: ambient occlusion is a property of the RENDER, not of each geometry (§V437)", () => {
  it("one switch reaches EVERY geometry the render names, in both draw modes", () => {
    const plan = planOf(twoObjectScene({ ambientOcclusion: true }));
    const passes = plan.passes as unknown as Pass[];
    const lit = passes.filter((pass) => pass.id.includes(":scene:"));
    expect(lit).toHaveLength(2);
    for (const pass of lit) {
      expect(pass.shader).toContain("var occlusionMap: texture_2d<f32>");
      expect(pass.shader).toContain("let occlusion = textureLoad(occlusionMap");
      expect((pass.textures ?? []).map((texture) => texture.binding)).toContain("occlusionMap");
      expect((pass.textures ?? []).find((texture) => texture.binding === "occlusionMap")?.resourceId).toBe(
        "scratch:shot:aoMap",
      );
    }
  });

  it("the three AO passes are emitted in the only order that can work, before the backdrop", () => {
    const plan = planOf(twoObjectScene({ ambientOcclusion: true }));
    const ids = (plan.passes as unknown as Pass[]).map((pass) => pass.id);
    const index = (needle: string) => ids.findIndex((id) => id.includes(needle));
    // The depth sweep clears, then draws BOTH geometries, then resolve, then blur — and
    // every one of those lands before the lit draws read the result.
    expect(index("shot:ao:depth:clear")).toBeGreaterThanOrEqual(0);
    expect(index("shot:ao:depth:0")).toBeGreaterThan(index("shot:ao:depth:clear"));
    expect(index("shot:ao:depth:1")).toBeGreaterThan(index("shot:ao:depth:0"));
    expect(index("shot:ao:resolve")).toBeGreaterThan(index("shot:ao:depth:1"));
    expect(index("shot:ao:blur")).toBeGreaterThan(index("shot:ao:resolve"));
    expect(index("shot:backdrop")).toBeGreaterThan(index("shot:ao:blur"));
    expect(index("shot:scene:0")).toBeGreaterThan(index("shot:backdrop"));
  });

  it("the AO scratch targets are r32float at output size, and the depth sweep carries depth", () => {
    const plan = planOf(twoObjectScene({ ambientOcclusion: true }));
    const resources = plan.resources as unknown as ReadonlyArray<{
      id: string;
      kind: string;
      format?: string;
      size?: readonly [number, number];
      depth?: boolean;
    }>;
    const find = (id: string) => resources.find((resource) => resource.id === id);
    for (const key of ["aoDepth", "aoRaw", "aoMap"]) {
      const resource = find(`scratch:shot:${key}`);
      expect(resource, key).toBeDefined();
      expect(resource?.format).toBe("r32float");
      expect(resource?.size).toEqual([64, 64]);
    }
    // Only the sweep is depth-tested: the resolve and the blur are full-target passes
    // and a depth attachment on either would be storage nobody reads.
    expect(find("scratch:shot:aoDepth")?.depth).toBe(true);
    expect(find("scratch:shot:aoRaw")?.depth).toBeUndefined();
    expect(find("scratch:shot:aoMap")?.depth).toBeUndefined();
  });

  it("the resolve's tap count follows the quality enum", () => {
    for (const [quality, taps] of Object.entries(AO_SAMPLE_COUNTS)) {
      const plan = planOf(twoObjectScene({ ambientOcclusion: true, aoQuality: quality }));
      const resolve = (plan.passes as unknown as Pass[]).find((pass) => pass.id.includes(":ao:resolve"));
      expect(resolve?.shader, quality).toContain(`i < ${taps}u`);
    }
    // An unknown value is not a crash and not a silent zero — it is the middle setting.
    expect(aoSampleCount("nonsense")).toBe(AO_SAMPLE_COUNTS.medium);
  });

  it("an UNLIT geometry declines AO on both sides at once — no map declared, none bound", () => {
    const plan = planOf(twoObjectScene({ ambientOcclusion: true }, "flat1"));
    for (const pass of (plan.passes as unknown as Pass[]).filter((p) => p.id.includes(":scene:"))) {
      expect(pass.shader).not.toContain("occlusionMap");
      expect((pass.textures ?? []).map((texture) => texture.binding)).not.toContain("occlusionMap");
    }
    // The passes still run: the switch is on the render, and a second, lit geometry in
    // the same scene would read the map. What must not happen is a half-bound pipeline.
    expect((plan.passes as unknown as Pass[]).some((pass) => pass.id.includes(":ao:blur"))).toBe(true);
  });
});

describe("T624: AO OFF is byte-identical to the render that had no AO (§V309)", () => {
  it("emits no AO pass, no AO scratch and no occlusion binding", () => {
    const plan = planOf(twoObjectScene({}));
    const passes = plan.passes as unknown as Pass[];
    expect(passes.filter((pass) => pass.id.includes(":ao:"))).toEqual([]);
    expect(
      (plan.resources as unknown as ReadonlyArray<{ id: string }>).filter((resource) => resource.id.includes(":ao")),
    ).toEqual([]);
    for (const pass of passes.filter((p) => p.id.includes(":scene:"))) {
      expect(pass.shader).not.toContain("occlusionMap");
      expect(pass.shader).not.toContain("occlusion");
    }
  });

  it("the depth-pass generators emit their pre-T624 text when linearDepth is absent", () => {
    // The AO prepass reuses the SHADOW geometry shaders rather than copying them, so
    // this is the assertion that the reuse cost the shadow path nothing.
    expect(shadowSurfaceWgsl()).toBe(shadowSurfaceWgsl({}));
    expect(shadowInstancesWgsl()).toBe(shadowInstancesWgsl({}));
    expect(shadowSurfaceWgsl()).not.toContain("depthRow");
    expect(shadowInstancesWgsl()).not.toContain("depthRow");
    expect(shadowSurfaceWgsl()).toContain("out.depth = clip.z;");
    expect(shadowInstancesWgsl()).toContain("out.depth = clip.z;");

    const linearSurface = shadowSurfaceWgsl({ linearDepth: true });
    expect(linearSurface).toContain("depthRow: vec4f");
    expect(linearSurface).toContain("depthRange: vec4f");
    expect(linearSurface).toContain("dot(params.depthRow");
    expect(linearSurface).not.toContain("out.depth = clip.z;");
    // Same vertex arithmetic, one implementation: the grid addressing is untouched.
    expect(linearSurface).toContain("fn gridPosition(gx: u32, gy: u32) -> vec3f");
  });

  it("the lit generators emit their pre-T624 text when ambientOcclusion is absent", () => {
    const base = { model: "phong" as const, lightCount: 2, environment: true };
    expect(sceneSurfaceWgsl(base)).toBe(sceneSurfaceWgsl({ ...base, ambientOcclusion: false }));
    expect(sceneInstancesWgsl(base)).toBe(sceneInstancesWgsl({ ...base, ambientOcclusion: false }));
    // And an unlit material refuses AO even when asked — the compiler makes the same
    // call in `aoActive`, and this is the half that pins the shader side of it.
    const unlit = { model: "unlit" as const, lightCount: 1 };
    expect(sceneSurfaceWgsl(unlit)).toBe(sceneSurfaceWgsl({ ...unlit, ambientOcclusion: true }));
    expect(sceneInstancesWgsl(unlit)).toBe(sceneInstancesWgsl({ ...unlit, ambientOcclusion: true }));
  });

  it("AO binds AFTER the environment, so shadow slots never renumber", () => {
    const withShadows = {
      model: "phong" as const,
      lightCount: 2,
      shadows: [0, 1],
      environment: true,
      ambientOcclusion: true,
    };
    const source = sceneSurfaceWgsl(withShadows);
    expect(source).toContain("@group(0) @binding(5) var shadowMap0");
    expect(source).toContain("@group(0) @binding(6) var shadowMap1");
    expect(source).toContain("@group(0) @binding(7) var environmentMap");
    expect(source).toContain("@group(0) @binding(8) var occlusionMap");
    // No environment: AO takes the slot the environment would have had, and nothing else moves.
    const noEnv = sceneSurfaceWgsl({ ...withShadows, environment: false });
    expect(noEnv).toContain("@group(0) @binding(7) var occlusionMap");
    expect(noEnv).not.toContain("environmentMap");
  });
});

describe("T624: AO attenuates the AMBIENT and ENVIRONMENT terms and nothing else", () => {
  it("the occlusion factor never reaches a direct light's radiance", () => {
    const source = sceneSurfaceWgsl({
      model: "phong",
      lightCount: 1,
      environment: true,
      ambientOcclusion: true,
    });
    expect(source).toContain("params.ambientColor.a * occlusion");
    expect(source).toContain("params.environment.x * occlusion");
    // The two direct-light additions must be untouched: a `* occlusion` on either is the
    // change that makes AO look stronger and be wrong, and it is invisible in a still.
    expect(source).toContain("lit += albedo.rgb * radiance * lambert;\n");
    expect(source).toContain("lit += params.specular.rgb * radiance * highlight;\n");
  });
});
