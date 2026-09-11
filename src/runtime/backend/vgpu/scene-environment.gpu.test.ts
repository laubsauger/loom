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
  sky: { type: "solid" | "ramp" | "checker"; parameters: Record<string, unknown> },
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
  sky: { type: "solid" | "ramp" | "checker"; parameters: Record<string, unknown> } = {
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

/**
 * T1289 — ROUGHNESS BLURS THE REFLECTION, AND THE CLAIM IS ONE A DIMMER FAILS.
 *
 * What shipped before this row scaled the environment term by `(1 − roughness)`: a mirror
 * and a brushed surface sampled the SAME TEXEL and differed only in brightness. "Rough
 * metal reads dark rather than soft" is the whole complaint, and it is why a claim of the
 * form "the rough one is different from the smooth one" would be worthless here — the old
 * code passes that too. So the instrument has to separate a BLUR from a DIM.
 *
 * It does it with two statistics over the object's own pixels, against a CHECKER sky whose
 * whole content is high-frequency detail:
 *
 *   - the coefficient of variation (stdev / mean) must COLLAPSE with roughness. That is
 *     what blurring a detailed reflection does and what dimming one cannot: scaling every
 *     pixel by `(1 − roughness)` divides stdev and mean by the same number and leaves the
 *     ratio exactly where it was.
 *   - the MEAN must survive. A blur redistributes energy, it does not remove it, so a
 *     rough surface stays roughly as bright as a smooth one. A dim is precisely the case
 *     where the mean falls with roughness, which is the defect being removed.
 *
 * Together they are a shape, not a magnitude, and the old behaviour fails both halves in
 * opposite directions — which is the §T1285 "plateaus bit-identical" idea applied to a
 * statistic rather than to a region.
 */
describe("T1289: the environment blurs with roughness, it does not dim (§V147)", () => {
  const CHECKER = { type: "checker" as const, parameters: { size: [16, 8], color1: [0, 0, 0, 1], color2: [1, 1, 1, 1] } };

  /** Mean and coefficient of variation of luma over the card, which is the middle third. */
  const cardStats = (bytes: Uint8Array): { mean: number; cv: number } => {
    const values: number[] = [];
    const from = Math.floor((SIZE * 2) / 5);
    const to = SIZE - from;
    for (let y = from; y < to; y += 1) {
      for (let x = from; x < to; x += 1) {
        const at = (y * SIZE + x) * 4;
        values.push(0.2126 * (bytes[at] ?? 0) + 0.7152 * (bytes[at + 1] ?? 0) + 0.0722 * (bytes[at + 2] ?? 0));
      }
    }
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
    return { mean, cv: Math.sqrt(variance) / Math.max(mean, 1e-6) };
  };

  /** The same card, but wearing a metal so the environment actually reflects off it. */
  const metalGraph = (roughness: number, taps?: number): GraphDocument => {
    const graph = skyGraph({ environmentIntensity: 1, ambientIntensity: 0, ...(taps === undefined ? {} : { environmentTaps: taps }) }, CHECKER);
    const mat = (graph.nodes as Record<string, { type: string; parameters: Record<string, unknown> }>)["mat"];
    if (mat === undefined) throw new Error("the sky fixture lost its material node");
    mat.type = "materialPbr";
    mat.parameters = { color: [1, 1, 1, 1], metallic: 1, roughness };
    return graph;
  };

  const shootMetal = async (roughness: number, taps?: number): Promise<Uint8Array> => {
    const plan = compileGraph({ graph: metalGraph(roughness, taps), settings: SETTINGS, registry, capabilities: CAPABILITIES });
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
  };

  it("a rough surface loses the sky's DETAIL and keeps its LIGHT", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const sharp = cardStats(await shootMetal(0));
    const rough = cardStats(await shootMetal(1));

    // There is detail to lose: a mirror of a checker is not a flat colour. Measured 1.61.
    expect(sharp.cv).toBeGreaterThan(1.0);
    /* THE BLUR: the reflection's structure collapses. A `(1 - roughness)` DIM divides
       stdev and mean by the same number and leaves this ratio exactly where it was, so
       this is the half the old behaviour fails. */
    expect(rough.cv).toBeLessThan(sharp.cv * 0.75);
    /* THE LIGHT SURVIVES: a blur redistributes energy rather than removing it. The old
       behaviour fails this in the other direction — at roughness 1 its term was multiplied
       by zero, so the mean went to the ambient floor. */
    expect(rough.mean).toBeGreaterThan(sharp.mean * 0.6);
  }, 180_000);

  /**
   * T1289 — WHAT THE TAP COUNT BUYS, measured, because §T1293 is gated on it.
   *
   * The cone is 8 taps by default and the obvious worry is that it under-samples. Measured
   * on the same fixture at roughness 1: 8 taps read mean 52.97 / cv 0.934, and 32 taps —
   * four times the work — read mean 63.17 / cv 0.912.
   *
   * So the extra taps buy BRIGHTNESS, not smoothness: the structure barely moves (2%)
   * while the mean rises 19%. A sparse cone is a biased estimate of the lobe's energy more
   * than it is a noisy one, and that is the useful thing to know before anyone builds a
   * prefiltered pyramid — the pyramid's advantage is not "less noise", it is that a
   * properly filtered level integrates the whole lobe instead of eight points of it.
   *
   * This asserts the SHAPE of that relationship rather than the two numbers: more taps
   * must not make the reflection darker, and must not make it substantially sharper. If
   * either changes, the cone's behaviour changed and §T1293's premise moved with it.
   */
  it("more taps buy brightness, not sharpness — which is what §T1293 is gated on", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const eight = cardStats(await shootMetal(1, 8));
    const thirtyTwo = cardStats(await shootMetal(1, 32));
    expect(thirtyTwo.mean).toBeGreaterThan(eight.mean);
    // Within a tenth: the blur is as blurred at 8 taps as it is at 32.
    expect(Math.abs(thirtyTwo.cv - eight.cv)).toBeLessThan(eight.cv * 0.1);
  }, 180_000);
});
