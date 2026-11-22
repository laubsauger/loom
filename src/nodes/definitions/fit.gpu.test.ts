import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode, NodeResolutionOverride, ProjectSettings } from "../../domain/types/graph.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu`
// import is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../tests/headless/pixel-compare.ts";

/**
 * Fit and Resolution on a real device (T1824b, T1825b, §V147): exact pixels, no tolerance.
 *
 * The input is 8 x 4 (2:1) and every texel SAYS which it is: red (i + 1) / 16, green
 * (j + 1) / 16, blue 1 on every fourth column (i = 0, 4) and 0 elsewhere, alpha 1. Every
 * value is a multiple of 1/16 or of 1/32, which half-float holds exactly and the shader's
 * f32 weights (1, 0.75, 0.5, 0.25) keep exact, so each output pixel is asserted to be
 * precisely the texel, the blend or the average the mode means. A texel's values are never
 * zero, so the transparent background cannot be mistaken for a dark texel.
 *
 * Project 16 x 16, square, so Fit's default size (the project's) is a different aspect from
 * its input's.
 */

const SIDE = 16;
const IN_W = 8;
const IN_H = 4;

const settings: ProjectSettings = {
  outputResolution: { width: SIDE, height: SIDE },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const TEXELS = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, vec2f(0.5), 0.0);
  let texel = floor(position.xy);
  let line = select(0.0, 1.0, (u32(texel.x) % 4u) == 0u);
  return vec4f((texel + vec2f(1.0)) / 16.0, line, max(base.a, 1.0));
}`;

type Pixel = readonly [number, number, number, number];

/** What the fixture holds at texel (i, j), clamped to the image as a held edge reads it. */
function texel(i: number, j: number): Pixel {
  const x = Math.min(Math.max(i, 0), IN_W - 1);
  const y = Math.min(Math.max(j, 0), IN_H - 1);
  return [(x + 1) / 16, (y + 1) / 16, x % 4 === 0 ? 1 : 0, 1];
}

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}, resolution?: NodeResolutionOverride): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(resolution === undefined ? {} : { resolution }) };
}

function graph(type: string, parameters: Record<string, ParameterValue>, resolution?: NodeResolutionOverride): GraphDocument {
  return {
    revision: 1,
    nodes: {
      seed: node("seed", "solid", { color: [0, 0, 0, 1] }),
      fix: node("fix", "customWgsl", { source: TEXELS }, { mode: "fixed", width: IN_W, height: IN_H }),
      fx: node("fx", type, parameters, resolution),
      out: node("out", "output"),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "fix", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fix", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

interface Picture {
  readonly width: number;
  readonly height: number;
  at(x: number, y: number): Pixel;
}

async function render(type: string, parameters: Record<string, ParameterValue>, resolution?: NodeResolutionOverride, nodeId = "fx"): Promise<Picture> {
  const result = await renderHeadless({ host: nodeGpuHost(), graph: graph(type, parameters, resolution), settings, frames: 1, capture: [0], outputNodeId: nodeId });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[0]!;
  const pixels = decodeComponents(frame.bytes, frame.format);
  return {
    width: frame.width,
    height: frame.height,
    at: (x, y) => {
      const i = (y * frame.width + x) * 4;
      return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
    },
  };
}

/** Every pixel against the model, with its coordinates in the message. */
function expectEvery(picture: Picture, model: (x: number, y: number) => Pixel): void {
  for (let y = 0; y < picture.height; y += 1) {
    for (let x = 0; x < picture.width; x += 1) {
      expect({ x, y, value: picture.at(x, y) }).toEqual({ x, y, value: model(x, y) });
    }
  }
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);
const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
};

const BLUE: Pixel = [0, 0, 1, 1];
const CLEAR: Pixel = [0, 0, 0, 0];
const NEAREST = { smoothing: "nearest" } as const;

describe("Fit on a real device (T1824b)", () => {
  it("the input is what the fixture says it is", async () => {
    requireDawn();
    const input = await render("fit", {}, undefined, "fix");
    expect([input.width, input.height]).toEqual([IN_W, IN_H]);
    expectEvery(input, texel);
  }, 60_000);

  /**
   * Fit Best, 8 x 4 into the 16 x 16 project frame: scale 2, placed 16 x 8 at row 4. Rows
   * 0-3 and 12-15 are exactly the background, the eight between are the whole input, each
   * texel two by two.
   */
  it("Fit Best keeps the whole input and leaves exact border rows of the background", async () => {
    requireDawn();
    const fitted = await render("fit", { ...NEAREST, bgcolor: [0, 0, 1, 1] });
    expect([fitted.width, fitted.height]).toEqual([SIDE, SIDE]);
    expectEvery(fitted, (x, y) => (y < 4 || y >= 12 ? BLUE : texel(Math.floor(x / 2), Math.floor((y - 4) / 2))));
  }, 60_000);

  it("the background is transparent by default", async () => {
    requireDawn();
    const fitted = await render("fit", NEAREST);
    for (const y of [0, 3, 12, 15]) for (let x = 0; x < SIDE; x += 1) expect(fitted.at(x, y)).toEqual(CLEAR);
  }, 60_000);

  it("Justify places the input: top puts the bars below, bottom above", async () => {
    requireDawn();
    const top = await render("fit", { ...NEAREST, justifyv: "top" });
    expectEvery(top, (x, y) => (y >= 8 ? CLEAR : texel(Math.floor(x / 2), Math.floor(y / 2))));
    const bottom = await render("fit", { ...NEAREST, justifyv: "bottom" });
    expectEvery(bottom, (x, y) => (y < 8 ? CLEAR : texel(Math.floor(x / 2), Math.floor((y - 8) / 2))));
  }, 60_000);

  /**
   * Fit Outside: scale 4, placed 32 x 16 at column -8, so the output shows texel columns 2-5,
   * each four wide. Two columns are cropped off EACH side: symmetric.
   */
  it("Fit Outside covers the output and crops the overhang symmetrically", async () => {
    requireDawn();
    const covered = await render("fit", { ...NEAREST, fit: "fitoutside" });
    expectEvery(covered, (x, y) => texel(Math.floor((x + 8) / 4), Math.floor(y / 4)));
    // Symmetric: the first visible column is the input's third, the last its third from last.
    expect(covered.at(0, 0)[0]).toBe(3 / 16);
    expect(covered.at(SIDE - 1, 0)[0]).toBe((IN_W - 2) / 16);
  }, 60_000);

  it("Fit Horizontal and Fit Vertical match one axis each (here, Best and Outside)", async () => {
    requireDawn();
    const horizontal = await render("fit", { ...NEAREST, fit: "fithorz" });
    expectEvery(horizontal, (x, y) => (y < 4 || y >= 12 ? CLEAR : texel(Math.floor(x / 2), Math.floor((y - 4) / 2))));
    const vertical = await render("fit", { ...NEAREST, fit: "fitvert" });
    expectEvery(vertical, (x, y) => texel(Math.floor((x + 8) / 4), Math.floor(y / 4)));
  }, 60_000);

  it("Fill stretches the input to the output", async () => {
    requireDawn();
    const filled = await render("fit", { ...NEAREST, fit: "fill" });
    expectEvery(filled, (x, y) => texel(Math.floor(x / 2), Math.floor(y / 4)));
  }, 60_000);

  /**
   * Native Resolution, interpolating: 8 x 4 centred in 16 x 16 at (4, 6), one texel per pixel.
   * Into 15 x 15 the centred origin would be (3.5, 5.5), which would blend every pixel with
   * its neighbour; whole pixels put it at (3, 5) and keep the texels exact.
   */
  it("Native Resolution is the input pixel for pixel, on whole pixels even with odd slack", async () => {
    requireDawn();
    const even = await render("fit", { fit: "nativeres" });
    expectEvery(even, (x, y) => (x >= 4 && x < 12 && y >= 6 && y < 10 ? texel(x - 4, y - 6) : CLEAR));
    const odd = await render("fit", { fit: "nativeres" }, { mode: "fixed", width: 15, height: 15 });
    expect([odd.width, odd.height]).toEqual([15, 15]);
    expectEvery(odd, (x, y) => (x >= 3 && x < 11 && y >= 5 && y < 9 ? texel(x - 3, y - 5) : CLEAR));
  }, 60_000);

  /** Fit Best's bars filled by the input itself instead of a colour. */
  it("Extend fills the bars by holding, repeating or mirroring the input", async () => {
    requireDawn();
    const placed = (x: number, y: number) => texel(Math.floor(x / 2), Math.floor((y - 4) / 2));
    const hold = await render("fit", { ...NEAREST, extend: "hold" });
    expectEvery(hold, (x, y) => placed(x, Math.min(Math.max(y, 4), 11)));
    // Repeat: the placed image is 8 rows tall, and the bars continue it with that period.
    const repeat = await render("fit", { ...NEAREST, extend: "repeat" });
    expectEvery(repeat, (x, y) => placed(x, y < 4 ? y + 8 : y >= 12 ? y - 8 : y));
    // Mirror: the bars are the image reflected about its own top and bottom edges.
    const mirror = await render("fit", { ...NEAREST, extend: "mirror" });
    expectEvery(mirror, (x, y) => placed(x, y < 4 ? 7 - y : y >= 12 ? 23 - y : y));
  }, 60_000);
});

describe("Resolution on a real device (T1825b)", () => {
  /** Half by default, Average Pixels: each output texel is the mean of a 2 x 2 block. */
  it("halves the input by default, each pixel the mean of the four it covers", async () => {
    requireDawn();
    const half = await render("resolution", {});
    expect([half.width, half.height]).toEqual([IN_W / 2, IN_H / 2]);
    expectEvery(half, (x, y) => [(2 * x + 1.5) / 16, (2 * y + 1.5) / 16, x % 2 === 0 ? 0.5 : 0, 1]);
  }, 60_000);

  /**
   * A quarter: Average sees the one-texel line in every block of four columns (0.25); a
   * linear sample at the block's centre reads columns 4x+1 and 4x+2 and misses it (0), and so
   * does Nearest (column 4x+2). That is the aliasing the average exists to remove.
   */
  it("at a quarter, Average Pixels keeps a thin line that Interpolate and Nearest drop", async () => {
    requireDawn();
    const quarter: NodeResolutionOverride = { mode: "scale", factor: 0.25 };
    const average = await render("resolution", {}, quarter);
    expect([average.width, average.height]).toEqual([2, 1]);
    expectEvery(average, (x) => [(4 * x + 2.5) / 16, 2.5 / 16, 0.25, 1]);
    const linear = await render("resolution", { smoothing: "linear" }, quarter);
    expectEvery(linear, (x) => [(4 * x + 2.5) / 16, 2.5 / 16, 0, 1]);
    const nearest = await render("resolution", NEAREST, quarter);
    expectEvery(nearest, (x) => texel(4 * x + 2, 2));
  }, 60_000);

  it("at 2X, Nearest repeats each texel two by two", async () => {
    requireDawn();
    const doubled = await render("resolution", NEAREST, { mode: "scale", factor: 2 });
    expect([doubled.width, doubled.height]).toEqual([IN_W * 2, IN_H * 2]);
    expectEvery(doubled, (x, y) => texel(Math.floor(x / 2), Math.floor(y / 2)));
  }, 60_000);

  /**
   * At 2X, Interpolate: output pixel x samples the input at x / 2 + 0.25, a quarter or three
   * quarters between two texel centres, held at the edges. Red and green ramp with the index,
   * so the blend is the index read there; blue is the line blended with its neighbour.
   */
  it("at 2X, Interpolate Pixels blends the two nearest texels on each axis, held at the edges", async () => {
    requireDawn();
    const doubled = await render("resolution", { smoothing: "linear" }, { mode: "scale", factor: 2 });
    const along = (x: number, n: number) => Math.min(Math.max(x / 2 - 0.25, 0), n - 1);
    const line = (x: number) => {
      const t = along(x, IN_W);
      const i = Math.floor(t);
      const f = t - i;
      return texel(i, 0)[2] * (1 - f) + texel(i + 1, 0)[2] * f;
    };
    expectEvery(doubled, (x, y) => [(along(x, IN_W) + 1) / 16, (along(y, IN_H) + 1) / 16, line(x), 1]);
  }, 60_000);
});

describe("Fit's Transform page on a real device (T1826b)", () => {
  /**
   * The reason the transform lives on Fit. Fit Outside places the input 32 x 16 at column -8
   * and crops texel columns 0-1 and 6-7. Translate x 0.5 (half of 16, 8 pixels) moves the
   * placed image right BEFORE the crop, so columns 0-3 show — two columns a Transform node
   * after the Fit could never get back, because they were never in its input.
   */
  it("Translate slides a Fit Outside across what it would crop", async () => {
    requireDawn();
    const slid = await render("fit", { ...NEAREST, fit: "fitoutside", t: [0.5, 0] });
    expectEvery(slid, (x, y) => texel(Math.floor(x / 4), Math.floor(y / 4)));
    expect(slid.at(0, 0)[0]).toBe(1 / 16);
  }, 60_000);

  /**
   * Same names, same signs, same maths as the Transform node: with Fill at the input's own
   * size and Hold on both, every pixel-aligned move gives the same picture to the bit. Each
   * case lands every sample on a texel centre, where Transform's bilinear sampler and Fit's
   * Nearest agree exactly (8 x 4: whole-pixel translates, a pivot on a pixel corner, turns by
   * a multiple of 90 degrees, a negative-scale flip).
   */
  it.each([
    { t: [0.25, 0.5] },
    { r: 180 },
    { r: 90, p: [0.125, 0] },
    { s: [-1, 1] },
    { r: 90, t: [0.125, -0.25], xord: "trs" },
  ])("matches the Transform node exactly for %j", async (move) => {
    requireDawn();
    const fit = await render("fit", { ...NEAREST, fit: "fill", extend: "hold", ...move }, { mode: "input" });
    const transform = await render("transform", { extend: "hold", ...move });
    expect([fit.width, fit.height]).toEqual([transform.width, transform.height]);
    expectEvery(fit, (x, y) => transform.at(x, y));
  }, 60_000);

  it("a rotated Fit Best fills what the turned image uncovers with the background", async () => {
    requireDawn();
    // Fit Best: 16 x 8 at row 4. Turned 90 degrees about the centre it stands 8 x 16 at
    // column 4: the left and right four columns are background, every row is image.
    const turned = await render("fit", { ...NEAREST, r: 90, bgcolor: [0, 0, 1, 1] });
    for (let y = 0; y < SIDE; y += 1) {
      for (const x of [0, 3, 12, 15]) expect({ x, y, v: turned.at(x, y) }).toEqual({ x, y, v: BLUE });
      for (const x of [4, 11]) expect(turned.at(x, y)).not.toEqual(BLUE);
    }
  }, 60_000);
});
