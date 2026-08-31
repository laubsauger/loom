import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T659 on a REAL device, with §V147 exact values.
 *
 * The subject is a small quad hanging in front of an environment, with the BACKGROUND
 * colour set to something the environment is not. That is the whole point: §V461 wants
 * both ends, and "the sky looks about right" cannot tell a drawn environment from a
 * clear colour that happens to be similar. Here the clear colour is deep blue and the
 * environment is red, so one byte separates the two answers.
 *
 * Four claims, and the fourth is the one an eye would miss:
 *
 *  1. OFF IS EXACTLY THE BACKGROUND. The sky byte equals the Background colour, to the
 *     byte, with an environment wired — the state every shipped environment scene is in.
 *  2. ON IS EXACTLY THE ENVIRONMENT. The sky byte becomes the environment's texel.
 *  3. THE INTENSITY REACHES IT. Halving `environmentIntensity` halves the sky.
 *  4. DEPTH IS UNTOUCHED. The object's own pixels are byte-identical on and off, so the
 *     background is behind everything and has not eaten the frame. A background pass
 *     that drew over the scene, or that stopped writing 0.999, passes (1)–(3) happily.
 *
 * A second case pins the equirect MAPPING rather than the fetch: a vertical ramp sky
 * must get DARKER upward in the frame, because v = acos(y)/π puts ramp position 0 at
 * the zenith. A mapping mirrored top-to-bottom passes every test above.
 */

const SIZE = 64;

const SETTINGS = {
  outputResolution: { width: SIZE, height: SIZE },
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

/* A flat 0.5-unit card at z = 0, dead centre, so the frame is mostly sky. */
const CARD_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x * 0.25, p.position.y * 0.25, 0.0);
  return q;
}`;

function skyGraph(
  renderParams: Record<string, unknown>,
  sky: { type: "solid" | "ramp"; parameters: Record<string, unknown> },
): GraphDocument {
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
        node("grid", "pointGrid", { count: 1024, cols: 32, rows: 32, sizeX: 2, sizeY: 2 }, "grid1"),
        node(
          "flat",
          "pointKernel",
          {
            capacity: 1024,
            seed: 7,
            attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
            kernel: CARD_KERNEL,
          },
          "flat1",
        ),
        node("mat", "materialUnlit", { color: [0, 1, 0, 1] }, "mat1"),
        node("geo", "geometry", { mode: "surface", material: "mat1" }, "geo1"),
        node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0], fov: 55, near: 0.1, far: 100 }, "cam1"),
        node("sky", sky.type, sky.parameters, "sky1"),
        node(
          "shot",
          "render",
          {
            scenes: "geo1",
            camera: "cam1",
            lights: "",
            ambientColor: [1, 1, 1, 1],
            ambientIntensity: 1,
            // Deep blue: nothing like the red environment, and nothing like black.
            background: [0, 0, 0.6, 1],
            ...renderParams,
          },
          "shot1",
        ),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "flat", portId: "in" } },
      e2: { id: "e2", source: { nodeId: "flat", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      e4: { id: "e4", source: { nodeId: "sky", portId: "out" }, target: { nodeId: "shot", portId: "environment" } },
    },
    groups: {},
  } as never;
}

const registry = createNodeRegistry(allNodeDefinitions).view();

async function render(
  renderParams: Record<string, unknown>,
  sky: { type: "solid" | "ramp"; parameters: Record<string, unknown> } = {
    type: "solid",
    parameters: { color: [1, 0, 0, 1] },
  },
): Promise<Uint8Array> {
  const plan = compileGraph({ graph: skyGraph(renderParams, sky), settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [SIZE, SIZE],
    });
    const image = await backend.readOutput("target:shot:out");
    return image.bytes;
  } finally {
    backend.dispose();
  }
}

const texel = (bytes: Uint8Array, x: number, y: number): readonly [number, number, number] => [
  bytes[(y * SIZE + x) * 4] ?? -1,
  bytes[(y * SIZE + x) * 4 + 1] ?? -1,
  bytes[(y * SIZE + x) * 4 + 2] ?? -1,
];

/* The card spans roughly the middle third; (2, 2) is sky, (32, 32) is card. */
const SKY = [2, 2] as const;
const CARD = [32, 32] as const;

describe("T659: the background comes from the environment TEXTURE, or from the colour (§V147)", () => {
  it("off is the Background byte, on is the environment byte, and the object never moves", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // (1) An environment is WIRED here and the sky is still the Background colour, which
    // is exactly what a wired environment looked like before T659. The byte is 81, not
    // 153: `background` is a DISPLAY-space parameter and 0.6 display is 0.3185 linear
    // (§V56/§V470 — the number you type is not the number the target holds).
    const off = await render({});
    expect(texel(off, ...SKY)).toEqual([0, 0, 81]);

    // (2) Switched on, the same pixel is the environment's own texel: red, full.
    const on = await render({ showEnvironment: true });
    expect(texel(on, ...SKY)).toEqual([255, 0, 0]);

    // (3) The intensity reaches the background: 0.5 × 1.0 → 128 (round-half-up of 127.5).
    const dim = await render({ showEnvironment: true, environmentIntensity: 0.5 });
    expect(texel(dim, ...SKY)).toEqual([128, 0, 0]);

    // (4) Depth untouched. The card is unlit green over an ambient of 1, so it is the
    // same byte in all three; a background that drew OVER the scene, or that stopped
    // writing 0.999, changes exactly this pixel and nothing above.
    expect(texel(on, ...CARD)).toEqual(texel(off, ...CARD));
    expect(texel(dim, ...CARD)).toEqual(texel(off, ...CARD));
    expect(texel(off, ...CARD)).toEqual([0, 255, 0]);
  }, 240_000);

  it("the equirect mapping puts ramp position 0 at the ZENITH, not at the horizon", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    /* A vertical ramp black → white. v = acos(direction.y)/π, so looking UP reads the
       ramp's start and looking DOWN reads its end: the frame must brighten downward.
       A mirrored mapping — the single likeliest way to get this wrong — inverts it. */
    const bytes = await render(
      { showEnvironment: true },
      {
        type: "ramp",
        parameters: {
          type: "vertical",
          interp: "linear",
          stops: [
            { position: 0, color: [0, 0, 0, 1] },
            { position: 1, color: [1, 1, 1, 1] },
          ],
        },
      },
    );
    const top = texel(bytes, 2, 1)[0];
    const middle = texel(bytes, 2, SIZE / 2)[0];
    const bottom = texel(bytes, 2, SIZE - 2)[0];
    expect(top).toBeLessThan(middle);
    expect(middle).toBeLessThan(bottom);
    // And it is a real gradient, not two flat halves: the camera looks along the
    // horizon with a 55° fov, so the visible band straddles v = 0.5 and the ends are
    // measurably apart. Measured on Dawn: 94 (top) / 126 (middle) / 157 (bottom).
    expect(bottom - top).toBeGreaterThan(30);
  }, 240_000);
});
