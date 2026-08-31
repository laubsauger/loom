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

/**
 * T704 on a REAL device, §V147 exact values throughout.
 *
 * A projector is an ADDITIVE LIGHT carrying its cookie (§V644) — so every gate here is
 * an arithmetic identity on the T377 lighting model, never a "looks projected":
 *
 *  - the BEAM LANDS: on-axis, at the nominal throw distance, a white beam of
 *    brightness 1 is exactly one directional light's worth — albedo × (ambient + 1);
 *  - OUTSIDE THE BEAM is exactly the ambient floor: the frustum edge is a hard gate,
 *    and a surface no beam reaches is lit by nothing but ambient (§V644's other half);
 *  - OVERLAP ADDS: two half-bright beams sum to one — additive means additive;
 *  - FALLOFF is inverse-square about the THROW distance: aim the look-at halfway to
 *    the surface and the contribution is exactly (2/4)² = 0.25 — and the falloff
 *    SWITCH restores nominal exactly;
 *  - the COOKIE modulates per channel: a pure-red cookie (0/1 fixed points of the
 *    display decode, §V56) lands red-only light;
 *  - an UNLIT material ignores projectors exactly as it ignores lights (§V666);
 *  - a PARAPET OCCLUDES (separate test): behind an occluder the beam contributes
 *    ZERO — the exact ambient floor — through the perspective depth compare, which is
 *    the w-divide the ortho shadow read never needed.
 */

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

const registry = createNodeRegistry(allNodeDefinitions).view();

const savePng = (name: string, bytes: Uint8Array): void => {
  writeFileSync(`test-results/${name}`, encodePng({ width: 64, height: 64, data: bytes }).bytes);
};

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

async function renderPlan(graph: GraphDocument): Promise<Uint8Array> {
  const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
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
}

describe("the beam lands exactly (T704, §V147, §V644)", () => {
  /**
   * The flat stage: an 8×8 grid spanning ±1 in xy at z = 0, facing an on-axis camera.
   * The projector sits on the same axis, so on-axis |N·L| = 1 and the throw distance
   * equals the surface distance — every term below is a clean constant.
   */
  const flatGraph = (
    projectorParams: ReadonlyArray<Record<string, unknown>>,
    options: { unlit?: boolean; cookie?: boolean } = {},
  ): GraphDocument => {
    const projectorNodes = projectorParams.map((parameters, index) =>
      node(`proj${index}`, "projector", parameters, `proj${index + 1}`),
    );
    return {
      revision: 1,
      nodes: Object.fromEntries(
        [
          node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
          node("geo", "geometry", { mode: "surface", ...(options.unlit ? { material: "flat1" } : {}) }, "geo1"),
          ...(options.unlit ? [node("flat", "materialUnlit", {}, "flat1")] : []),
          /* Pure red: 0 and 1 are fixed points of the display decode (§V56), so the
             cookie's linear value is exactly (1, 0, 0) with no colour-space maths. */
          ...(options.cookie ? [node("cookie", "solid", { color: [1, 0, 0, 1] }, "cookie1")] : []),
          node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }, "cam1"),
          ...projectorNodes,
          node(
            "shot",
            "render",
            {
              scenes: "geo1",
              camera: "cam1",
              lights: "",
              projectors: projectorParams.map((_, index) => `proj${index + 1}`).join(" "),
              ambientColor: [1, 1, 1, 1],
              ambientIntensity: 0.12,
            },
            "shot1",
          ),
          node("out", "output", {}, "out1"),
        ].map((entry) => [entry.id, entry]),
      ),
      edges: {
        e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        ...(options.cookie
          ? { e3: { id: "e3", source: { nodeId: "cookie", portId: "out" }, target: { nodeId: "proj0", portId: "cookie" } } }
          : {}),
      },
      groups: {},
    } as never;
  };

  /* Texels through the render's OWN camera, exact by construction. */
  const camMatrix = cameraPayloadMatrix(
    { eye: [0, 0, 3], lookAt: [0, 0, 0], fovDeg: 55, near: 0.1, far: 100, ortho: false, orthoHeight: 2 },
    1,
  );
  const texelOf = (world: readonly [number, number, number]): number => {
    const clip = transformPoint(camMatrix, world);
    const x = Math.round(((clip[0] / clip[3]) * 0.5 + 0.5) * 64);
    const y = Math.round((0.5 - (clip[1] / clip[3]) * 0.5) * 64);
    return (y * 64 + x) * 4;
  };
  const centre = texelOf([0, 0, 0]);
  /* throwRatio 3 from 4 units out: beam half-width = 4 × (0.5/3) = 2/3 — so x = 0.9
     is on the grid (±1) and OUTSIDE the beam, while the centre is well inside. */
  const outside = texelOf([0.9, 0, 0]);

  const FLOOR = Math.round(0.8 * 0.12 * 255); // albedo × ambient, no beam
  const FULL = Math.round(0.8 * (0.12 + 1) * 255); // ambient + one full beam

  it("a white beam at nominal distance = one light's worth; outside it, the floor", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const image = await renderPlan(
      flatGraph([{ eye: [0, 0, 4], lookAt: [0, 0, 0], throwRatio: 3, brightness: 1 }]),
    );
    // On-axis at the throw distance: falloff = 1, |N·L| = 1, cookie = white.
    expect([image[centre], image[centre + 1], image[centre + 2]]).toEqual([FULL, FULL, FULL]);
    // §V644's other half: where no beam reaches, the surface is ambient-lit ONLY.
    expect([image[outside], image[outside + 1], image[outside + 2]]).toEqual([FLOOR, FLOOR, FLOOR]);
    savePng("projector-beam.png", image);
  }, 120_000);

  it("two half beams add to one; falloff is (nominal/distance)² exactly, and switchable", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // OVERLAP ADDS: 0.4 + 0.4 lands exactly 0.8 of a light.
    const pose = { eye: [0, 0, 4], lookAt: [0, 0, 0], throwRatio: 3 };
    const overlap = await renderPlan(flatGraph([{ ...pose, brightness: 0.4 }, { ...pose, brightness: 0.4 }]));
    const summed = Math.round(0.8 * (0.12 + 0.8) * 255);
    expect(overlap[centre]).toBe(summed);
    savePng("projector-overlap.png", overlap);

    // FALLOFF: look-at halfway to the surface → nominal 2, distance 4, (2/4)² = 0.25.
    const half = { eye: [0, 0, 4], lookAt: [0, 0, 2], throwRatio: 3, brightness: 1 };
    const faded = await renderPlan(flatGraph([half]));
    expect(faded[centre]).toBe(Math.round(0.8 * (0.12 + 0.25) * 255));

    // §V361's cut: the SAME pose with falloff off — nominal brightness at any range.
    const flat = await renderPlan(flatGraph([{ ...half, falloff: false }]));
    expect(flat[centre]).toBe(FULL);
  }, 240_000);

  it("a pure-red cookie lands red-only light; an unlit material takes none", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const red = await renderPlan(
      flatGraph([{ eye: [0, 0, 4], lookAt: [0, 0, 0], throwRatio: 3, brightness: 1 }], { cookie: true }),
    );
    // r = ambient + full beam; g, b = the beam contributes ZERO there — floor exactly.
    expect([red[centre], red[centre + 1], red[centre + 2]]).toEqual([FULL, FLOOR, FLOOR]);
    savePng("projector-cookie.png", red);

    // §V666: unlit exchanges no light — a beam aimed straight at it changes NOTHING:
    // byte-identical to the same unlit stage with no projector referenced at all.
    const unlit = await renderPlan(
      flatGraph([{ eye: [0, 0, 4], lookAt: [0, 0, 0], throwRatio: 3, brightness: 1 }], { unlit: true }),
    );
    const bare = await renderPlan(flatGraph([], { unlit: true }));
    expect(unlit[centre]).toBe(bare[centre]);
    expect(unlit[centre]).toBeGreaterThan(0);
    expect(unlit[outside]).toBe(bare[outside]);
  }, 240_000);
});

describe("a parapet occludes (T704, §V147)", () => {
  /**
   * The shadow test's stage (T481), re-lit by a projector: a ground plane on xz, a box
   * floating above the origin, the projector throwing STRAIGHT DOWN through the box.
   * Under the box the beam is blocked — the exact ambient floor, through the
   * perspective depth compare. Beside it the beam lands, and toggling occlusion off
   * must not move a single unblocked byte (§V461: the fixtures distinguish).
   */
  const buildGraph = (occlusion: boolean): GraphDocument =>
    ({
      revision: 1,
      nodes: Object.fromEntries(
        [
          node("grid", "pointGrid", { cols: 16, rows: 16, count: 256 }, "grid1"),
          node(
            "flatten",
            "pointKernel",
            {
              capacity: 256,
              attributes: JSON.stringify([
                { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
              ]),
              kernel:
                "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = vec3f(p.position.x * 4.0, 0.0, p.position.y * 4.0);\n  return q;\n}",
            },
            "flatten1",
          ),
          node("ground", "geometry", { mode: "surface" }, "ground1"),
          node("dot", "pointGrid", { cols: 1, rows: 1, count: 1 }, "dot1"),
          node(
            "lift",
            "pointKernel",
            {
              capacity: 1,
              attributes: JSON.stringify([
                { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
              ]),
              kernel:
                "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = vec3f(0.0, 1.0, 0.0);\n  return q;\n}",
            },
            "lift1",
          ),
          node("box", "geometry", { mode: "instances", shape: "box", scale: 0.5 }, "box1"),
          node("cam", "camera", { eye: [0, 2, 4], lookAt: [0, 0, 0] }, "cam1"),
          // Straight down — the T706 pole guard carries the projector's basis here.
          node(
            "proj",
            "projector",
            { eye: [0, 4, 0], lookAt: [0, 0, 0], throwRatio: 1.5, brightness: 1, occlusion },
            "proj1",
          ),
          node(
            "shot",
            "render",
            {
              scenes: "ground1 box1",
              camera: "cam1",
              lights: "",
              projectors: "proj1",
              ambientColor: [1, 1, 1, 1],
              ambientIntensity: 0.12,
            },
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
    }) as never;

  it("under the box: the exact ambient floor; beside it, occlusion on/off is byte-identical", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

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
    const blocked = texelOf([0.3, 0, 0.3]); // under the box's ±0.5 footprint
    const open = texelOf([1, 0, 0]); // in the beam (half-width 4/1.5/2 = 4/3), clear of the box

    const occluded = await renderPlan(buildGraph(true));
    const decal = await renderPlan(buildGraph(false));
    const floor = Math.round(0.8 * 0.12 * 255);

    // The parapet rule: a surface the projector cannot see receives NOTHING.
    expect(occluded[blocked]).toBe(floor);
    // The cut (§V361): occlusion off is the decal that lies — the beam paints through.
    expect(decal[blocked]).toBeGreaterThan(floor + 50);
    // And where nothing blocks, the toggle must not move one byte (§V461).
    expect([occluded[open], occluded[open + 1], occluded[open + 2]]).toEqual([
      decal[open],
      decal[open + 1],
      decal[open + 2],
    ]);
    expect(occluded[open]).toBeGreaterThan(floor + 50);

    savePng("projector-occluded.png", occluded);
    savePng("projector-decal.png", decal);
  }, 240_000);
});
