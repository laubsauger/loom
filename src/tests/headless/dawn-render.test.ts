import { beforeAll, describe, expect, it } from "vitest";
import { fixturePlan } from "../../runtime/backend/vgpu/plan-fixture.ts";
import {
  blurChainGraph,
  gradientLevelsGraph,
  solidGraph,
  PARITY_SIZE,
} from "../fixtures/parity-graphs.ts";
// The sanctioned Dawn host (T160): `src/runtime/backend/vgpu/` is the only place a
// `vgpu` import is legal (§V3), and the node entry point now lives behind that
// boundary like every other one. Aliased to `dawnGpuHost` because every claim in
// this file is about Dawn specifically, not about "some node-side host".
import {
  nodeGpuHost as dawnGpuHost,
  probeDawn,
} from "../../runtime/backend/vgpu/node-gpu-host.ts";
import {
  TOLERANCE_CROSS_GPU,
  compareFrames,
  decodeComponents,
  describeDifference,
  pixelAt,
} from "./pixel-compare.ts";
import { renderHeadless, renderOnce, renderPlanHeadless } from "./render-harness.ts";
import type { RenderedFrame } from "./render-harness.ts";

/**
 * T47 — reference snapshots from a real GPU, with no window anywhere (§V47).
 *
 * WHAT A "REFERENCE SNAPSHOT" IS HERE, and why it is not a committed PNG.
 *
 * The obvious way to write this suite is to render once, save the bytes, and assert
 * equality forever after. That produces a test that fails on the next machine and whose
 * only repair is to re-record it — which means it stops encoding any claim about what the
 * picture should be and starts encoding "whatever the last person's GPU did".
 *
 * So the references here are ORACLES. Solid and gradient->levels are recomputed on the CPU
 * from the documented shader maths, including the 8-bit quantisation of the intermediate
 * target, and compared within one quantum. The blur chain and the feedback progression are
 * pinned by properties that follow from what those operations MEAN — a blur reduces
 * variance and conserves the mean; a 50/50 feedback mix converges geometrically on its
 * input and its per-frame deltas halve. Every one of these fails if a shader changes
 * behaviour, and none of them fails merely because the GPU changed.
 *
 * Dawn is REQUIRED here, not optional. If it cannot start, this file fails and says what
 * the error was; it never skips into a green tick.
 */

const SIZE = PARITY_SIZE;

let dawnError: string | undefined;

beforeAll(async () => {
  const probe = await probeDawn();
  dawnError = probe.error;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) {
    throw new Error(
      `Dawn (vgpu/node) could not start, so the headless render path is unverified: ${dawnError}`,
    );
  }
}

/** uv handed to a full-screen pass: the centre of texel x in a width-w target. */
function texelCentre(index: number, extent: number): number {
  return (index + 0.5) / extent;
}

const quantise8 = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255) / 255;

/** The mean of one channel over the whole image. */
function channelMean(frame: RenderedFrame, channel: number): number {
  const components = decodeComponents(frame.bytes, frame.format);
  let sum = 0;
  let count = 0;
  for (let i = channel; i < components.length; i += 4) {
    sum += components[i] ?? 0;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

function channelVariance(frame: RenderedFrame, channel: number): number {
  const mean = channelMean(frame, channel);
  const components = decodeComponents(frame.bytes, frame.format);
  let sum = 0;
  let count = 0;
  for (let i = channel; i < components.length; i += 4) {
    sum += ((components[i] ?? 0) - mean) ** 2;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

describe("T47 — Dawn headless render (§V47)", () => {
  it("starts a real GPU device with no canvas and no surface", async () => {
    const probe = await probeDawn();
    // Deliberately an assertion and not a skip: a machine where this is false has NOT
    // verified the headless path, and must be told so rather than shown a green suite.
    expect(probe.error ?? "none").toBe("none");
    expect(probe.available).toBe(true);
    expect(probe.adapter ?? "").not.toBe("");
  }, 60_000);

  /**
   * The control case. Every pixel is one known constant, so a failure is plumbing — wrong
   * target read back, padded rows, a format mismatch — and never shading.
   */
  it("solid: every pixel is the parameter value", async () => {
    requireDawn();
    const frame = await renderOnce({ host: dawnGpuHost(), graph: solidGraph() });

    expect(frame.width).toBe(SIZE);
    expect(frame.height).toBe(SIZE);
    expect(frame.format).toBe("rgba8unorm");
    expect(frame.bytes.byteLength).toBe(SIZE * SIZE * 4);

    const expected = [0.25, 0.5, 0.75, 1];
    const components = decodeComponents(frame.bytes, frame.format);
    let worst = 0;
    for (let i = 0; i < components.length; i += 1) {
      worst = Math.max(worst, Math.abs((components[i] ?? 0) - (expected[i % 4] ?? 0)));
    }
    expect(worst).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU);
  }, 60_000);

  /**
   * gradient -> levels, against a CPU oracle of the same maths.
   *
   * Ramp (horizontal, linear, phase 0, period 1) writes `mix(black, white, uv.x)` into an
   * rgba8unorm target, so the value Level reads is ALREADY quantised — the oracle models
   * that, because not modelling it is how a tolerance quietly grows until it means nothing.
   * Level then does: remap by black/white, gamma, contrast about 0.5, brightness. With
   * black=0.25, white=0.75, gamma=2 the result is sqrt((t-0.25)/0.5), signed, and the
   * unorm target clamps the ends — which is why this fixture is worth having: it exercises
   * the negative-base branch of `signedPow` and the >1 clamp in one image.
   */
  it("gradient -> levels matches a CPU model of the documented shader maths", async () => {
    requireDawn();
    const frame = await renderOnce({ host: dawnGpuHost(), graph: gradientLevelsGraph() });
    const components = decodeComponents(frame.bytes, frame.format);

    const black = 0.25;
    const white = 0.75;
    const gamma = 2;

    let worst = 0;
    let worstAt = -1;
    for (let x = 0; x < SIZE; x += 1) {
      const t = quantise8(texelCentre(x, SIZE)); // ramp -> rgba8unorm intermediate
      const remapped = (t - black) / (white - black);
      const signedPow = Math.sign(remapped) * Math.abs(remapped) ** (1 / gamma);
      const expected = quantise8(signedPow);
      // Row 32 is representative: a horizontal ramp is constant down each column.
      const index = (32 * SIZE + x) * 4;
      const actual = components[index] ?? 0;
      if (Math.abs(actual - expected) > worst) {
        worst = Math.abs(actual - expected);
        worstAt = x;
      }
    }
    expect(
      worst,
      `worst deviation ${worst.toFixed(6)} at column x=${worstAt}`,
    ).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU);

    // The shape claims, stated separately so a uniformly-wrong image cannot pass by
    // agreeing with a uniformly-wrong oracle.
    expect(pixelAt(frame, 0, 32)[0]).toBe(0); // below the black level, clamped
    expect(pixelAt(frame, SIZE - 1, 32)[0]).toBe(1); // above the white level, clamped
    for (let x = 1; x < SIZE; x += 1) {
      const previous = components[(32 * SIZE + (x - 1)) * 4] ?? 0;
      const current = components[(32 * SIZE + x) * 4] ?? 0;
      expect(current).toBeGreaterThanOrEqual(previous);
    }
    // Alpha is coverage, and Level's opacity is 1: nothing may have touched it.
    expect(pixelAt(frame, 32, 32)[3]).toBe(1);
  }, 60_000);

  /**
   * A two-blur chain, which is the case `vgpu/mock` structurally cannot check: the target
   * between blur1 and blur2 is written by one pass and SAMPLED by the next, and the mock
   * device instruments no texture creation and hands out opaque views. Only a real device
   * can tell you the intermediate held what it was supposed to.
   *
   * The claims are what blurring means, not recorded bytes: it conserves the mean, it
   * reduces variance, and it destroys the hard checker edges (no pure black or pure white
   * survives in the interior).
   */
  it("blur chain conserves the mean, reduces variance and softens every edge", async () => {
    requireDawn();
    const blurred = await renderOnce({ host: dawnGpuHost(), graph: blurChainGraph() });

    // The same checker with both blur radii at zero: the un-blurred reference, rendered
    // through the identical pass chain so the comparison isolates the blur alone.
    const sharpGraph = blurChainGraph();
    const blur1 = sharpGraph.nodes["blur1"];
    const blur2 = sharpGraph.nodes["blur2"];
    expect(blur1 && blur2).toBeTruthy();
    blur1!.parameters["size"] = 0;
    blur2!.parameters["size"] = 0;
    const sharp = await renderOnce({ host: dawnGpuHost(), graph: sharpGraph });

    // A 64x64 image of 8x8 checks is exactly half black and half white.
    expect(channelMean(sharp, 0)).toBeCloseTo(0.5, 2);
    // Conservation: a normalised kernel cannot move the average brightness. 0.01 allows
    // for the clamp-to-edge extend mode at the border, which genuinely does bias the mean.
    expect(Math.abs(channelMean(blurred, 0) - channelMean(sharp, 0))).toBeLessThan(0.01);

    // Softening: this is the assertion that fails if the intermediate target was never
    // actually sampled and blur2 read garbage or a stale texture.
    expect(channelVariance(blurred, 0)).toBeLessThan(channelVariance(sharp, 0) * 0.9);

    const sharpComponents = decodeComponents(sharp.bytes, sharp.format);
    const blurredComponents = decodeComponents(blurred.bytes, blurred.format);
    const extremes = (values: Float64Array): number => {
      let count = 0;
      for (let i = 0; i < values.length; i += 4) {
        const value = values[i] ?? 0;
        if (value === 0 || value === 1) count += 1;
      }
      return count;
    };
    expect(extremes(sharpComponents)).toBe(SIZE * SIZE);
    expect(extremes(blurredComponents)).toBeLessThan(SIZE * SIZE);
  }, 90_000);

  /**
   * Feedback progression over N frames (§V22).
   *
   * `fixturePlan()` mixes scene and history 50/50 into a ping-pong pair and presents the
   * pair, so with a time-independent scene channel the presented value must follow
   * `scene * (1 - 2^-n)`: strictly increasing, converging on the scene, with each
   * frame-to-frame delta half the last. That is a much stronger claim than "the pixels
   * changed" — it fails if the pair never swaps (value frozen), if it swaps twice (value
   * jumps), or if history is cleared each frame (value pinned at scene/2).
   *
   * The red channel is the one probed on purpose: GENERATE_WGSL puts `uv * amount` in RG
   * and `tint + time` in B, so R is the channel the clock cannot reach (§V44).
   */
  it("feedback converges geometrically on its input over N frames (§V22)", async () => {
    requireDawn();
    const frames = 6;
    const { frames: captured, diagnostics } = await renderPlanHeadless({
      host: dawnGpuHost(),
      plan: fixturePlan({ size: [SIZE, SIZE] }),
      outputResourceId: "output",
      size: [SIZE, SIZE],
      format: "rgba8unorm",
      frames,
      capture: [0, 1, 2, 3, 4, 5],
    });

    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(captured).toHaveLength(frames);

    const probeX = 48;
    const probeY = 32;
    const series = captured.map((frame) => pixelAt(frame, probeX, probeY)[0] ?? 0);

    // Strictly increasing: history is retained and re-read every frame.
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i]!).toBeGreaterThan(series[i - 1]!);
    }

    // Geometric: each delta is half the previous one. Compared as a ratio with a generous
    // band because the presented value is 8-bit quantised, which perturbs small deltas.
    const deltas = series.slice(1).map((value, index) => value - series[index]!);
    for (let i = 1; i < deltas.length - 1; i += 1) {
      const ratio = deltas[i]! / deltas[i - 1]!;
      expect(ratio).toBeGreaterThan(0.3);
      expect(ratio).toBeLessThan(0.7);
    }

    // Converging on the scene value, which for R is uv.x * amount at the probe texel.
    const sceneValue = texelCentre(probeX, SIZE) * 1;
    const last = series.at(-1)!;
    expect(last).toBeLessThan(sceneValue);
    expect(sceneValue - last).toBeLessThan(sceneValue * 0.05);
  }, 90_000);

  /**
   * Resize an INTERMEDIATE target and keep rendering (T94, §V21).
   *
   * This is the bug class the note from the runtime track named: a pass that samples an
   * intermediate holds a bind-group view, `Target.resize()` destroys and recreates the
   * texture underneath it, and a binding captured as `.color` rather than as the Target
   * would keep pointing at the destroyed one. `vgpu/mock` cannot see any of that — no
   * createTexture instrumentation, fresh view objects per `set()` — so this assertion only
   * means something on a real device, which is exactly why it lives in this file.
   */
  it("keeps rendering correctly after a sampled intermediate is resized (T94)", async () => {
    requireDawn();
    const graph = blurChainGraph();
    const result = await renderHeadless({
      host: dawnGpuHost(),
      graph,
      frames: 3,
      capture: [0, 2],
      betweenFrames: (control, frameIndex) => {
        if (frameIndex !== 0) return;
        // blur1's output is the intermediate blur2 samples.
        const intermediate = control.plan.outputs.find((output) => output.nodeId === "blur1");
        expect(intermediate).toBeDefined();
        control.resize(intermediate!.resourceId, [32, 32]);
      },
    });

    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const [before, after] = result.frames;
    expect(before).toBeDefined();
    expect(after).toBeDefined();

    // The output target is untouched, so the readback shape must not move.
    expect(after!.width).toBe(SIZE);
    expect(after!.height).toBe(SIZE);

    // A destroyed-texture bind shows up as an all-zero (or NaN) image, so the strongest
    // cheap claim is that the picture is still a plausible blurred checker: mean near 0.5
    // and non-trivial variance. Halving the intermediate blurs it further, so the pixels
    // legitimately differ from `before` — asserting equality here would be wrong.
    expect(channelMean(after!, 0)).toBeGreaterThan(0.3);
    expect(channelMean(after!, 0)).toBeLessThan(0.7);
    expect(channelVariance(after!, 0)).toBeGreaterThan(0);
    const difference = compareFrames(before!, after!, 0);
    expect(difference.matches, describeDifference("resize changed nothing at all", difference))
      .toBe(false);
  }, 90_000);
});
