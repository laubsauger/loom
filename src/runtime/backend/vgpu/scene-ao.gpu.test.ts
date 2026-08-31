import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T624 on a REAL device, with §V147 exact values.
 *
 * The subject is a V-shaped GROOVE: a 64×64 grid folded to `z = |x| − 1`, so two flat
 * walls face each other along a crease at x = 0, facing the camera. Nothing else is in
 * the scene, there are no lights, and ambient is 1.0 — which makes the lit result
 * exactly `albedo × occlusion`, and turns every claim about AO into an assertion about
 * a byte rather than about a look.
 *
 * Three things are pinned, and the third is the one that matters:
 *
 *  1. UNOCCLUDED IS EXACTLY UNCHANGED. Mid-wall, where the surface is planar and every
 *     tap lies in its own tangent plane, the byte with AO on equals the byte with AO
 *     off. An AO that dimmed the whole frame — the commonest way to make one "work" —
 *     fails here and nowhere else.
 *  2. INTENSITY 0 IS EXACTLY OFF. The passes still run and the map is still bound, so
 *     this separates "the value is zero" from "the plumbing is dead".
 *  3. THE CREASE IS DARKER, MEASURABLY. A groove is the shape AO exists for.
 *
 * Together (1) and (3) are two-sided: a no-op passes (1) and fails (3); a global dimmer
 * passes (3) and fails (1).
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

/* The fold. `p.position.xy` is the grid's own plane; z carries it into the groove. */
const GROOVE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x, p.position.y, abs(p.position.x) - 1.0);
  return q;
}`;

function grooveGraph(renderParams: Record<string, unknown>): GraphDocument {
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
        node("grid", "pointGrid", { count: 4096, cols: 64, rows: 64, sizeX: 2, sizeY: 2 }, "grid1"),
        node(
          "fold",
          "pointKernel",
          {
            capacity: 4096,
            seed: 7,
            attributes: JSON.stringify([
              { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            ]),
            kernel: GROOVE_KERNEL,
          },
          "fold1",
        ),
        node("geo", "geometry", { mode: "surface" }, "geo1"),
        node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0], fov: 55, near: 0.1, far: 100 }, "cam1"),
        node(
          "shot",
          "render",
          {
            scenes: "geo1",
            camera: "cam1",
            // No lights on purpose: ambient alone makes the byte arithmetic exact.
            lights: "",
            ambientColor: [1, 1, 1, 1],
            ambientIntensity: 1,
            background: [0, 0, 0, 1],
            ...renderParams,
          },
          "shot1",
        ),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "fold", portId: "in" } },
      e2: { id: "e2", source: { nodeId: "fold", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

const registry = createNodeRegistry(allNodeDefinitions).view();

async function renderGroove(renderParams: Record<string, unknown>): Promise<Uint8Array> {
  const plan = compileGraph({ graph: grooveGraph(renderParams), settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
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

/** Red channel at a pixel; the material is grey, so one channel is the whole story. */
const at = (bytes: Uint8Array, x: number, y: number): number => bytes[(y * 64 + x) * 4] ?? -1;

/* The crease projects to x = 32 (the camera is on the groove's axis); the left wall
   reaches the silhouette near x = 11.5, so x = 20 is mid-wall — far enough from the
   crease that a 0.35-world-unit search radius (~6 px here) never reaches it. */
const CREASE_X = 32;
const WALL_X = 20;
const ROW = 32;

describe("T624: ambient occlusion darkens a crease and leaves flat surfaces exact (§V147)", () => {
  it("mid-wall is unchanged to the byte, intensity 0 is exactly off, the crease is darker", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const off = await renderGroove({});
    // albedo 0.8 × ambient 1.0, no lights, no occlusion → 204 everywhere on the groove.
    expect(at(off, WALL_X, ROW)).toBe(204);
    expect(at(off, CREASE_X, ROW)).toBe(204);

    const on = await renderGroove({ ambientOcclusion: true, aoRadius: 0.35, aoIntensity: 1 });
    // (1) A planar wall occludes nothing: exactly the unoccluded byte, not "about" it.
    expect(at(on, WALL_X, ROW)).toBe(204);
    // (3) The crease is where the two walls see each other. Measured on Dawn: 146
    // against the unoccluded 204, i.e. ~0.28 occluded at a right angle, which is the
    // Alchemy estimator's normalisation doing its job rather than a tuned constant.
    expect(at(on, CREASE_X, ROW)).toBeLessThan(180);
    expect(at(on, CREASE_X, ROW)).toBeGreaterThan(100);

    // (2) The value knob, with the plumbing untouched: the passes run, the map is bound,
    // and the picture is the unoccluded one to the byte across the whole row.
    const zero = await renderGroove({ ambientOcclusion: true, aoRadius: 0.35, aoIntensity: 0 });
    for (let x = 14; x <= 50; x += 1) {
      expect(at(zero, x, ROW), `x=${x}`).toBe(at(off, x, ROW));
    }
  }, 240_000);

  it("the occlusion is a GRADIENT out of the crease, not a step, and the background is untouched", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const on = await renderGroove({ ambientOcclusion: true, aoRadius: 0.35, aoIntensity: 1 });

    // Walking out of the crease, occlusion releases monotonically over the search
    // radius. A hard step here would mean the falloff term is dead.
    const crease = at(on, CREASE_X, ROW);
    const near = at(on, CREASE_X + 3, ROW);
    const mid = at(on, CREASE_X + 6, ROW);
    expect(crease).toBeLessThan(near);
    expect(near).toBeLessThan(mid);
    expect(mid).toBeLessThanOrEqual(204);

    // Background pixels are outside the groove's silhouette; the AO resolve returns
    // them unoccluded and the backdrop is drawn before the lit pass anyway, so a dark
    // halo around the object — screen-space AO's signature failure — cannot appear.
    expect(at(on, 1, ROW)).toBe(0);
    expect(at(on, 62, ROW)).toBe(0);
  }, 240_000);
});
