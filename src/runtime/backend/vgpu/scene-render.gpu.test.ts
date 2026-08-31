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
    /*
     * The whole pixel IS the env term: black base kills ambient and diffuse, no lights
     * are named, and (1 − roughness) × intensity = 1. What is left is T632's Fresnel,
     * and the grid faces the on-axis camera, so this is a DIELECTRIC AT NORMAL
     * INCIDENCE: F = F0 = 0.04, and 0.04 × 255 = 10.2. Blue, to the byte. Before T632
     * this read 255 — a black plastic disc mirroring the sky back at full strength,
     * which is what made the melted goo read as chrome.
     */
    expect([mirrored[centre], mirrored[centre + 1], mirrored[centre + 2]]).toEqual([0, 0, 10]);

    // §V361's cut: the same scene with nothing wired is the black mirror in a dark room.
    const cut = await render(false);
    expect([cut[centre], cut[centre + 1], cut[centre + 2]]).toEqual([0, 0, 0]);
  }, 120_000);
});

/**
 * T632 — the assertion that separates OIL from CHROME, at BOTH ends of `metallic`
 * (§V147 exact values, §V461 a fixture capable of distinguishing what it asserts).
 *
 * The gap E33-Obol's author named: an IBL-lite reflection with no view-dependent term
 * returns the SAME environment head-on as at a grazing angle, and that is a metal. A
 * test that only checked "the picture changed" would pass for any edit to that line, so
 * the probe measures the SAME material at TWO KNOWN ANGLES and asserts both numbers.
 *
 * The angle is exact by construction rather than eyeballed. A point kernel maps the flat
 * grid onto a plane tilted about x — position (x, y·c, −y·s) — whose central-difference
 * normal is (0, s, c) at EVERY vertex, so the interpolated normal across the centre
 * triangle is that vector exactly. The camera is ORTHOGRAPHIC and a thousand units back,
 * which is what makes N·V a constant: `viewDir` is eye − world, so a near camera would
 * give the centre texel its own slightly-off-axis view ray and the fifth power would
 * amplify the difference. At a thousand units the deviation is 2×10⁻⁵ radians, four
 * orders of magnitude below a byte.
 *
 *   c = 1.0 → N = (0,0,1) → N·V = 1     (normal incidence)
 *   c = 0.2 → N = (0,√0.96,0.2) → N·V = 0.2  (78.5° from the normal — grazing)
 *
 * Specular is written to 0.8 through the VALUE path (§V5) at both ends so the ONLY thing
 * that differs between the dielectric and the metal is `metallic` itself, and so neither
 * end clamps at 1.0 — a metal asserted at a saturated 255 would pass with no Fresnel at
 * all, which is exactly the blind fixture §V461 is about.
 */
describe("the environment reflection is VIEW-DEPENDENT for a dielectric and not for a metal (T632, §V147, §V461)", () => {
  /** Schlick, in the test's own arithmetic — never imported from the shader. */
  const schlick = (f0: number, nDotV: number): number => f0 + (1 - f0) * (1 - nDotV) ** 5;

  const tiltedGraph = (cosTilt: number): GraphDocument => {
    const sinTilt = Math.sqrt(1 - cosTilt * cosTilt);
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
          node("grid", "pointGrid", { cols: 8, rows: 8, count: 64 }, "grid1"),
          node("tilt", "pointKernel", {
            capacity: 64,
            attributes: JSON.stringify([
              { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            ]),
            kernel:
              "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n" +
              `  q.position = vec3f(p.position.x, p.position.y * ${cosTilt.toFixed(17)}, -p.position.y * ${sinTilt.toFixed(17)});\n` +
              "  return q;\n}",
          }, "tilt1"),
          node("geo", "geometry", { mode: "surface", material: "mirror1" }, "geo1"),
          // Black base kills ambient and diffuse; roughness 0 leaves (1 − roughness) = 1.
          node("mirror", "materialPhong", { color: [0, 0, 0, 1], specular: [1, 1, 1, 1], shininess: 8, roughness: 0 }, "mirror1"),
          // Ortho, far back: one view direction for the whole frame (see the docblock).
          node("cam", "camera", { eye: [0, 0, 1000], lookAt: [0, 0, 0], ortho: true, orthoHeight: 2, near: 900, far: 1100 }, "cam1"),
          node("sky", "solid", { color: [0, 0, 1, 1] }, "sky1"), // display 1 decodes to linear 1
          node(
            "shot",
            "render",
            { scenes: "geo1", camera: "cam1", lights: "", ambientColor: [1, 1, 1, 1], ambientIntensity: 0 },
            "shot1",
          ),
          node("out", "output", {}, "out1"),
        ].map((entry) => [entry.id, entry]),
      ),
      edges: {
        e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "tilt", portId: "in" } },
        e2: { id: "e2", source: { nodeId: "tilt", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
        e3: { id: "e3", source: { nodeId: "sky", portId: "out" }, target: { nodeId: "shot", portId: "environment" } },
        e4: { id: "e4", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as never;
  };

  /** Blue channel of the centre texel at both values of `metallic`, for one tilt. */
  const probe = async (cosTilt: number): Promise<{ dielectric: number; metal: number }> => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: tiltedGraph(cosTilt),
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
    const passId = plan.passes.find((pass) => pass.kind === "draw" && pass.id.includes(":scene:"))?.id ?? "";
    expect(passId).not.toBe("");
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      const blueAt = async (): Promise<number> => {
        backend.render(compiled, {
          frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
        const image = await backend.readOutput("target:shot:out");
        return image.bytes[(32 * 64 + 32) * 4 + 2] ?? -1;
      };
      // §V5, the value path: specular 0.8 linear, metallic 0 — an ordinary dielectric.
      backend.updateUniforms({ passId, values: { specular: [0.8, 0.8, 0.8, 8], material: [0, 0, 0, 0] } });
      const dielectric = await blueAt();
      // The SAME material with metallic driven to 1. Nothing else moves.
      backend.updateUniforms({ passId, values: { specular: [0.8, 0.8, 0.8, 8], material: [1, 0, 0, 0] } });
      const metal = await blueAt();
      return { dielectric, metal };
    } finally {
      backend.dispose();
    }
  };

  it("a dielectric reflects 8.9× more at 78.5° than head-on; a metal reflects the same at both, to the byte", async () => {
    const dawn = await probeDawn();
    if (!dawn.available) throw new Error(`Dawn unavailable: ${dawn.error}`);

    const headOn = await probe(1.0);
    const grazing = await probe(0.2);

    // F0 = mix(0.04, 1.0, metallic). Specular 0.8 tints it; env colour and intensity are 1.
    const expected = (metallic: number, nDotV: number): number =>
      Math.round(0.8 * schlick(0.04 + 0.96 * metallic, nDotV) * 255);

    // THE DIELECTRIC — the assertion this task exists for. 0.8 × 0.04 = 0.032 → 8 head-on;
    // 0.8 × (0.04 + 0.96 × 0.8⁵) = 0.2837 → 72 at 78.5°. Same material, same light, same
    // environment: only the angle moved, and the reflection is 9× brighter for it.
    expect(headOn.dielectric).toBe(8);
    expect(grazing.dielectric).toBe(72);
    expect(headOn.dielectric).toBe(expected(0, 1));
    expect(grazing.dielectric).toBe(expected(0, 0.2));
    expect(grazing.dielectric / headOn.dielectric).toBeGreaterThan(8);

    // THE METAL — §V461's other end. F0 = 1, so the Schlick term has nowhere to rise to
    // and the reflection is ANGLE-INVARIANT: 0.8 × 1 = 0.8 → 204 at both angles. If F0
    // ignored `metallic` these would read 8 and 72 like the dielectric; if the fixture
    // were a saturated white metal both ends would read 255 and prove nothing.
    expect(headOn.metal).toBe(204);
    expect(grazing.metal).toBe(204);
    expect(headOn.metal).toBe(expected(1, 1));
    expect(grazing.metal).toBe(expected(1, 0.2));
    expect(grazing.metal).toBe(headOn.metal);
  }, 240_000);
});

/**
 * T636 — the DIFFUSE half of the environment, at three points of `metallic`
 * (§V147 exact values, §V461 a fixture able to distinguish each factor).
 *
 * The Fresnel work exposed the gap: with only a specular half, removing the head-on
 * reflection from a dielectric left nothing physical to fill its shadows, and
 * `environmentIntensity` stood in by hand (E33's 7× re-exposure). The new term is
 * irradiance along N × albedo × (1 − F) × (1 − metallic) × intensity.
 *
 * EXACT BY CONSTRUCTION: the environment is a UNIFORM solid, so the five-tap cone
 * average equals the solid's own value whatever directions the taps take; the grid is
 * flat and the ortho camera on-axis, so N·V = 1 and F = F0 exactly; roughness is 1, so
 * (1 − roughness) zeroes the specular term and the ONLY light in the frame is the term
 * under test. Albedo is WHITE (display 1 = linear 1) so the product needs no transfer
 * arithmetic.
 *
 *   metallic 0.0 → (1 − 0.04) × (1 − 0)   = 0.96 → 245   (the fill this task adds)
 *   metallic 0.5 → (1 − 0.52) × (1 − 0.5) = 0.24 →  61   (both factors, distinguished:
 *                                                   a missing (1 − metallic) reads 122)
 *   metallic 1.0 → (1 − 1.00) × (1 − 1)   = 0    →   0   (a metal gains NOTHING)
 *
 * And §V361's cut: the same dielectric with no environment wired reads 0 — the fill
 * came from the wire, not from an ambient constant.
 */
describe("the environment lights a dielectric's body and never a metal's (T636, §V147, §V461)", () => {
  const flatGraph = (withEnvironment: boolean): GraphDocument => {
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
          node("grid", "pointGrid", { cols: 8, rows: 8, count: 64 }, "grid1"),
          node("geo", "geometry", { mode: "surface", material: "matte1" }, "geo1"),
          // WHITE albedo carries the diffuse term; roughness 1 zeroes the specular one.
          node("matte", "materialPhong", { color: [1, 1, 1, 1], specular: [1, 1, 1, 1], shininess: 8, roughness: 1 }, "matte1"),
          node("cam", "camera", { eye: [0, 0, 1000], lookAt: [0, 0, 0], ortho: true, orthoHeight: 2, near: 900, far: 1100 }, "cam1"),
          node("sky", "solid", { color: [0, 0, 1, 1] }, "sky1"),
          node(
            "shot",
            "render",
            { scenes: "geo1", camera: "cam1", lights: "", ambientColor: [1, 1, 1, 1], ambientIntensity: 0 },
            "shot1",
          ),
          node("out", "output", {}, "out1"),
        ].map((entry) => [entry.id, entry]),
      ),
      edges: {
        e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
        ...(withEnvironment
          ? { e3: { id: "e3", source: { nodeId: "sky", portId: "out" }, target: { nodeId: "shot", portId: "environment" } } }
          : {}),
        e4: { id: "e4", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as never;
  };

  const probe = async (withEnvironment: boolean, metallic: number): Promise<number> => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: flatGraph(withEnvironment),
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
    const passId = plan.passes.find((pass) => pass.kind === "draw" && pass.id.includes(":scene:"))?.id ?? "";
    expect(passId).not.toBe("");
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      // §V5, the value path: only `metallic` moves between probes; roughness stays 1.
      backend.updateUniforms({ passId, values: { specular: [0.8, 0.8, 0.8, 8], material: [metallic, 1, 0, 0] } });
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      const image = await backend.readOutput("target:shot:out");
      return image.bytes[(32 * 64 + 32) * 4 + 2] ?? -1;
    } finally {
      backend.dispose();
    }
  };

  it("dielectric fills at 0.96, half-metal at 0.24, metal at zero — and nothing without the wire", async () => {
    const dawn = await probeDawn();
    if (!dawn.available) throw new Error(`Dawn unavailable: ${dawn.error}`);

    expect(await probe(true, 0)).toBe(245);
    expect(await probe(true, 0.5)).toBe(61);
    expect(await probe(true, 1)).toBe(0);
    expect(await probe(false, 0)).toBe(0);
  }, 240_000);
});

/**
 * T642 — §V471'S SELECTION IDIOM, THROUGH THE SHARED CAMERA AND DEPTH BUFFER.
 *
 * One cloud, one draw, a per-instance vertex gate: `group` on the geometry node splits
 * by predicate exactly as renderPoints does (same resolver, same zero-area collapse —
 * §V349 by construction). The fixture is §V461-shaped: a kernel writes a `flag` the
 * points themselves carry, the predicate reads it, and the assertions are BYTE-EXACT
 * against an unpredicated control — an included instance renders identically to the
 * control, an excluded one leaves exactly the background.
 */
describe("a geometry group predicate selects instances in the lit scene (T642, §V471, §V147)", () => {
  const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    label,
  });

  const graphWithGroup = (group: string, mode: "instances" | "points" = "instances"): GraphDocument =>
    ({
      revision: 1,
      nodes: Object.fromEntries(
        [
          node("pair", "pointLine", { count: 2 }, "pair1"),
          node("split", "pointKernel", {
            capacity: 2,
            attributes: JSON.stringify([
              { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
              { name: "flag", type: "f32", default: [0] },
            ]),
            /* Point 0 left and flagged, point 1 right and not: the predicate has one
               member of each class to distinguish (§V461). */
            kernel:
              "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n" +
              "  q.position = vec3f(f32(ctx.index) * 1.0 - 0.5, 0.0, 0.0);\n" +
              "  q.flag = 1.0 - f32(ctx.index);\n  return q;\n}",
          }, "split1"),
          node("chalk", "materialUnlit", { color: [1, 1, 1, 1] }, "chalk1"),
          node("dots", "geometry", { mode, shape: "box", scale: 0.2, material: "chalk1", ...(group === "" ? {} : { group }) }, "dots1"),
          node("cam", "camera", { eye: [0, 0, 1000], lookAt: [0, 0, 0], ortho: true, orthoHeight: 2, near: 900, far: 1100 }, "cam1"),
          node("shot", "render", { scenes: "dots1", camera: "cam1", lights: "", ambientColor: [1, 1, 1, 1], ambientIntensity: 0 }, "shot1"),
          node("out", "output", {}, "out1"),
        ].map((entry) => [entry.id, entry]),
      ),
      edges: {
        e1: { id: "e1", source: { nodeId: "pair", portId: "out" }, target: { nodeId: "split", portId: "in" } },
        e2: { id: "e2", source: { nodeId: "split", portId: "out" }, target: { nodeId: "dots", portId: "points" } },
        e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    }) as never;

  const rendered = async (group: string, mode: "instances" | "points" = "instances"): Promise<Uint8Array> => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: graphWithGroup(group, mode),
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

  it.each(["instances", "points"] as const)(
    "keeps the flagged %s-mode point byte-identical to the control and erases the other completely",
    async (mode) => {
    const dawn = await probeDawn();
    if (!dawn.available) throw new Error(`Dawn unavailable: ${dawn.error}`);

    const control = await rendered("", mode);
    const gated = await rendered("p.flag > 0.5", mode);

    /* Ortho height 2 over 64px: point 0 at x −0.5 lands at column 16, point 1 at 48. */
    const at = (bytes: Uint8Array, column: number): number => bytes[(32 * 64 + column) * 4] ?? -1;
    // Both drawn in the control…
    expect(at(control, 16)).toBeGreaterThan(0);
    expect(at(control, 48)).toBeGreaterThan(0);
    // …the predicate keeps the flagged one EXACTLY and removes the other to the ground.
    expect(at(gated, 16)).toBe(at(control, 16));
    expect(at(gated, 48)).toBe(0);
    // And the included half is byte-identical everywhere left of centre — the gate
    // changed SELECTION, not shading.
    for (let column = 0; column < 32; column += 1) {
      expect(at(gated, column)).toBe(at(control, column));
    }
    /* T647's own exactness, riding the same fixture: unlit white through a billboard
       is 255 at the card's centre — a lit card would read the lambert instead. */
    expect(at(control, 16)).toBe(255);
  }, 240_000);
});
