import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { encodePng } from "../../export/png.ts";
import { writeFileSync } from "node:fs";

const savePng = (name: string, bytes: Uint8Array): void => {
  writeFileSync(`test-results/${name}`, encodePng({ width: 64, height: 64, data: bytes }).bytes);
};

/**
 * T377 on a REAL device, with §V147 exact values: one directional light straight down
 * the view axis onto a flat grid gives |N·L| = 1, so the centre texel is
 * albedo × (ambient + intensity) to the byte. And §V361's question answered as bytes:
 * CUT the light (clear the lights list) and the same texel drops to the ambient floor —
 * also exact. A lighting model that ignored its lights would fail both.
 */

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

function sceneGraph(lights: string): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    label,
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
        node("geo", "geometry", { mode: "surface" }, "geo1"),
        node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }, "cam1"),
        // Straight down the view axis: toLight = (0,0,1), |N·L| = 1 on a flat grid.
        node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1 }, "sun1"),
        node(
          "shot",
          "render",
          { scenes: "geo1", camera: "cam1", lights, ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12 },
          "shot1",
        ),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

describe("the scene render lights exactly (T377, §V147, §V361)", () => {
  it("centre texel = albedo × (ambient + lambert); cut the light and it is the floor", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const render = async (lights: string): Promise<Uint8Array> => {
      const plan = compileGraph({
        graph: sceneGraph(lights),
        settings: SETTINGS,
        registry,
        capabilities: {
          tier: "B",
          features: [],
          formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
          timestampQuery: false,
          limits: { maxTextureDimension2D: 8192 },
        } as never,
      });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const backend = createVgpuBackend({ host: nodeGpuHost() });
      try {
        await backend.initialize({});
        const compiled = await backend.compile(plan);
        backend.render(compiled, {
          frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
        const image = await backend.readOutput("target:shot:out");
        return image.bytes;
      } finally {
        backend.dispose();
      }
    };

    const lit = await render("sun1");
    const centre = (32 * 64 + 32) * 4;
    // albedo 0.8 × (0.12 ambient + 1.0 × |N·L| = 1) = 0.896 → byte 228, every channel.
    const litExpected = Math.round(0.8 * (0.12 + 1) * 255);
    expect([lit[centre], lit[centre + 1], lit[centre + 2]]).toEqual([litExpected, litExpected, litExpected]);

    // §V361: the drive cut. Same graph, no light named — the exact ambient floor.
    const dark = await render("");
    const floorExpected = Math.round(0.8 * 0.12 * 255);
    expect([dark[centre], dark[centre + 1], dark[centre + 2]]).toEqual([
      floorExpected,
      floorExpected,
      floorExpected,
    ]);
    expect(litExpected).not.toBe(floorExpected);
  }, 120_000);
});

describe("phong specular is exact on the axis (T428, §V147)", () => {
  it("centre texel adds exactly the specular term when the material goes phong", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const graph = sceneGraph("sun1");
    (graph.nodes as Record<string, { parameters: Record<string, unknown>; label?: string }>)["gold"] = {
      id: "gold",
      type: "materialPhong",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      // 0/1 fixed points of the display decode, and roughness 0 so gloss is pure
      // shininess; on the axis N·L = N·H = 1, so highlight = 1 whatever the gloss.
      parameters: { color: [1, 1, 1, 1], specular: [0, 0, 0, 1], shininess: 64, roughness: 0 },
      label: "gold1",
    } as never;
    (graph.nodes["geo"] as { parameters: Record<string, unknown> }).parameters["material"] = "gold1";
    // Specular alpha channel is unused; use a dim white via intensity instead: set the
    // light to 0.5 so diffuse = 1 × (0.12 + 0.5) and specular = 0 adds nothing — then
    // flip specular to prove the ADDITION, exactly.
    (graph.nodes["sun"] as { parameters: Record<string, unknown> }).parameters["intensity"] = 0.5;

    const plan = compileGraph({
      graph,
      settings: SETTINGS,
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      } as never,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      const renderOnce = async (): Promise<number> => {
        backend.render(compiled, {
          frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
        const image = await backend.readOutput("target:shot:out");
        return image.bytes[(32 * 64 + 32) * 4] ?? -1;
      };
      // Black specular: pure diffuse — 1 × (0.12 + 0.5) = 0.62.
      expect(await renderOnce()).toBe(Math.round(0.62 * 255));
      // White specular, via the VALUE path (§V5): + 1 × 0.5 highlight = 1.12, clamped.
      backend.updateUniforms({
        passId: plan.passes.find((pass) => pass.kind === "draw" && pass.id.includes(":scene:"))?.id ?? "",
        values: { specular: [1, 1, 1, 64] },
      });
      expect(await renderOnce()).toBe(255);
    } finally {
      backend.dispose();
    }
  }, 120_000);
});


describe("per-point colour reaches the lit scene exactly (T478, §V147, §V361)", () => {
  it("a mapped tint paints the instance red to the byte; unmapped stays white", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const registry = createNodeRegistry(allNodeDefinitions).view();

    const render = async (tint: unknown): Promise<Uint8Array> => {
      const graph = sceneGraph("sun1");
      const nodes = graph.nodes as Record<string, { parameters: Record<string, unknown> }>;
      nodes["grid"]!.parameters["count"] = 64;
      (graph.nodes as Record<string, unknown>)["paint"] = {
        id: "paint",
        type: "pointKernel",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {
          capacity: 64,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            { name: "color", type: "vec4f", default: [1, 0, 0, 1] },
          ]),
          kernel:
            "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.color = vec4f(1.0, 0.0, 0.0, 1.0);\n  return q;\n}",
        },
        label: "paint1",
      };
      (graph.edges as Record<string, unknown>)["e1"] = {
        id: "e1",
        source: { nodeId: "grid", portId: "out" },
        target: { nodeId: "paint", portId: "in" },
      };
      (graph.edges as Record<string, unknown>)["e3"] = {
        id: "e3",
        source: { nodeId: "paint", portId: "out" },
        target: { nodeId: "geo", portId: "points" },
      };
      // Instances big enough that one box face covers the centre texel flat-on.
      nodes["geo"]!.parameters["mode"] = "instances";
      nodes["geo"]!.parameters["scale"] = 0.5;
      nodes["geo"]!.parameters["tint"] = tint;

      const plan = compileGraph({
        graph,
        settings: SETTINGS,
        registry,
        capabilities: {
          tier: "B",
          features: [],
          formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
          timestampQuery: false,
          limits: { maxTextureDimension2D: 8192 },
        } as never,
      });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const backend = createVgpuBackend({ host: nodeGpuHost() });
      try {
        await backend.initialize({});
        const compiled = await backend.compile(plan);
        backend.render(compiled, {
          frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
        const image = await backend.readOutput("target:shot:out");
        return image.bytes;
      } finally {
        backend.dispose();
      }
    };

    const centre = (32 * 64 + 32) * 4;
    // A +z box face straight at the camera under a light straight down the axis:
    // |N·L| = 1 exactly, so the texel is base 0.8 × pointColour × (0.12 + 1).
    const lit = Math.round(0.8 * 1.12 * 255);
    const mapped = await render({
      mode: "map",
      value: [1, 1, 1, 1],
      bindings: { map: { kind: "map", attribute: "color" } },
    });
    expect([mapped[centre], mapped[centre + 1], mapped[centre + 2]]).toEqual([lit, 0, 0]);

    // §V361's cut: the SAME graph with a static tint — white, all three channels.
    const flat = await render([1, 1, 1, 1]);
    expect([flat[centre], flat[centre + 1], flat[centre + 2]]).toEqual([lit, lit, lit]);
  }, 120_000);
});

describe("shadows land exactly (T481, §V147, §V361)", () => {
  it("under the box the ground is the ambient floor; beside it, fully lit — to the byte", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const registry = createNodeRegistry(allNodeDefinitions).view();

    const buildGraph = (shadows: boolean): GraphDocument => {
      const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
        id,
        type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters,
        label,
      });
      return {
        revision: 1,
        nodes: Object.fromEntries(
          [
            // The ground: a 16×16 grid mapped onto the xz plane, ±4 world units.
            node("grid", "pointGrid", { cols: 16, rows: 16, count: 256 }, "grid1"),
            node("flatten", "pointKernel", {
              capacity: 256,
              attributes: JSON.stringify([
                { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
              ]),
              kernel:
                "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = vec3f(p.position.x * 4.0, 0.0, p.position.y * 4.0);\n  return q;\n}",
            }, "flatten1"),
            node("ground", "geometry", { mode: "surface" }, "ground1"),
            // The caster: one box floating a unit above the origin.
            node("dot", "pointGrid", { cols: 1, rows: 1, count: 1 }, "dot1"),
            node("lift", "pointKernel", {
              capacity: 1,
              attributes: JSON.stringify([
                { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
              ]),
              kernel:
                "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = vec3f(0.0, 1.0, 0.0);\n  return q;\n}",
            }, "lift1"),
            node("box", "geometry", { mode: "instances", shape: "box", scale: 0.5 }, "box1"),
            node("cam", "camera", { eye: [0, 2, 4], lookAt: [0, 0, 0] }, "cam1"),
            // Straight down, so |N·L| = 1 on the ground: shadowed = ambient floor
            // EXACTLY, lit = ambient + intensity EXACTLY. The up-vector swap for a
            // direction parallel to world-up is exercised for free.
            node("sun", "light", { kind: "directional", direction: [0, -1, 0], intensity: 1, shadows }, "sun1"),
            node(
              "shot",
              "render",
              { scenes: "ground1 box1", camera: "cam1", lights: "sun1", ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12 },
              "shot1",
            ),
            node("out", "output", {}, "out1"),
          ].map((entry) => [entry.id, entry]),
        ),
        edges: {
          e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "flatten", portId: "in" } },
          e2: { id: "e2", source: { nodeId: "flatten", portId: "out" }, target: { nodeId: "ground", portId: "points" } },
          e3: { id: "e3", source: { nodeId: "dot", portId: "out" }, target: { nodeId: "lift", portId: "in" } },
          e4: { id: "e4", source: { nodeId: "lift", portId: "out" }, target: { nodeId: "box", portId: "points" } },
          e5: { id: "e5", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      } as never;
    };

    const render = async (shadows: boolean): Promise<Uint8Array> => {
      const plan = compileGraph({
        graph: buildGraph(shadows),
        settings: SETTINGS,
        registry,
        capabilities: {
          tier: "B",
          features: [],
          formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
          timestampQuery: false,
          limits: { maxTextureDimension2D: 8192 },
        } as never,
      });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const backend = createVgpuBackend({ host: nodeGpuHost() });
      try {
        await backend.initialize({});
        const compiled = await backend.compile(plan);
        backend.render(compiled, {
          frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
        const image = await backend.readOutput("target:shot:out");
        return image.bytes;
      } finally {
        backend.dispose();
      }
    };

    // Project world points through the SAME camera the render composes, so the texels
    // sampled are exact by construction rather than eyeballed.
    const matrix = cameraPayloadMatrix(
      { eye: [0, 2, 4], lookAt: [0, 0, 0], fovDeg: 55, near: 0.1, far: 100, ortho: false, orthoHeight: 2 },
      1,
    );
    const texelOf = (world: readonly [number, number, number]): number => {
      const clip = transformPoint(matrix, world);
      const x = Math.round(((clip[0] / clip[3]) * 0.5 + 0.5) * 64);
      const y = Math.round((0.5 - (clip[1] / clip[3]) * 0.5) * 64);
      return (y * 64 + x) * 4;
    };
    const inShadow = texelOf([0.3, 0, 0.3]); // under the box's footprint, visible past its face
    const inLight = texelOf([0, 0, 2]); // open ground

    const shadowed = await render(true);
    const floor = Math.round(0.8 * 0.12 * 255); // albedo × ambient — the light is blocked
    const lit = Math.round(0.8 * (0.12 + 1) * 255); // albedo × (ambient + |N·L| = 1)
    expect(shadowed[inShadow]).toBe(floor);
    expect(shadowed[inLight]).toBe(lit);

    // §V361: the same graph with casting OFF — the "shadowed" texel is fully lit.
    const cut = await render(false);
    expect(cut[inShadow]).toBe(lit);
    expect(cut[inLight]).toBe(lit);

    savePng("scene-shadow-on.png", shadowed);
    savePng("scene-shadow-off.png", cut);
  }, 120_000);
});

describe("the environment reflects exactly (T482, §V147, §V361)", () => {
  it("a mirror-flat phong grid adds exactly the env colour; unwire it and the term is gone", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const registry = createNodeRegistry(allNodeDefinitions).view();

    const buildGraph = (wired: boolean): GraphDocument => {
      const graph = sceneGraph("");
      const nodes = graph.nodes as Record<string, { parameters: Record<string, unknown> }>;
      // A mirror: black base (no ambient term), white specular, roughness 0, through
      // the phong path. The flat grid faces the on-axis camera, so R hits ONE texel of
      // the equirect for every centre fragment — and the env is a solid anyway.
      (graph.nodes as Record<string, unknown>)["mirror"] = {
        id: "mirror",
        type: "materialPhong",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { color: [0, 0, 0, 1], specular: [1, 1, 1, 1], shininess: 8, roughness: 0 },
        label: "mirror1",
      };
      nodes["geo"]!.parameters["material"] = "mirror1";
      if (wired) {
        (graph.nodes as Record<string, unknown>)["sky"] = {
          id: "sky",
          type: "solid",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: { color: [0, 0, 1, 1] }, // display 1 decodes to linear 1: exact
          label: "sky1",
        };
        (graph.edges as Record<string, unknown>)["env"] = {
          id: "env",
          source: { nodeId: "sky", portId: "out" },
          target: { nodeId: "shot", portId: "environment" },
        };
      }
      return graph;
    };

    const render = async (wired: boolean): Promise<Uint8Array> => {
      const plan = compileGraph({
        graph: buildGraph(wired),
        settings: SETTINGS,
        registry,
        capabilities: {
          tier: "B",
          features: [],
          formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
          timestampQuery: false,
          limits: { maxTextureDimension2D: 8192 },
        } as never,
      });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const backend = createVgpuBackend({ host: nodeGpuHost() });
      try {
        await backend.initialize({});
        const compiled = await backend.compile(plan);
        backend.render(compiled, {
          frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
        const image = await backend.readOutput("target:shot:out");
        return image.bytes;
      } finally {
        backend.dispose();
      }
    };

    const centre = (32 * 64 + 32) * 4;
    const mirrored = await render(true);
    // The whole pixel IS the env term: black base kills ambient and diffuse, no lights
    // are named, and (1 − roughness) × intensity = 1. Blue, to the byte.
    expect([mirrored[centre], mirrored[centre + 1], mirrored[centre + 2]]).toEqual([0, 0, 255]);

    // §V361's cut: the same scene with nothing wired is the black mirror in a dark room.
    const cut = await render(false);
    expect([cut[centre], cut[centre + 1], cut[centre + 2]]).toEqual([0, 0, 0]);
  }, 120_000);
});
