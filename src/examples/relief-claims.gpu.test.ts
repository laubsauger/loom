import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * T797 — E27's claims, and every one of them is measured on a DARK SOURCE.
 *
 * The owner's report was "relief when driving with camera and a rather dark image is kind
 * a boring". Nothing in the catalogue could have caught it: every gate, every look pass
 * and the whole look baseline render this file's understudy, and **the understudy is
 * LIT**. That is why the behaviour shipped, and it is why this file exists — a fixture
 * that cannot tell apart the thing its test asserts is not a fixture (§V461).
 *
 * THE DARK FIXTURE. The same understudy, one fourteenth of the light: `bed1.brightness`
 * and `swell1.fillcolor` both scaled by 0.14. Deliberately a SCALE and nothing else — the
 * picture, its shape, its motion and its timing are untouched, so any difference these
 * tests measure is the graph's response to LEVEL and cannot be a response to content.
 *
 * Read display-encoded off the Output's own space (§V618), at the project resolution,
 * because additive point density is resolution-dependent (§V627).
 */

const DIM = 0.14;

/** The mechanism under test: relief ∝ luminance, so a dark room has no relief. */
const FLAT_CEILING = 0.03;
/** What the rebuilt file must clear on the same dark input. */
const LIVELY_FLOOR = 0.12;

function e27() {
  const file = listExamples().find((entry) => entry.fileName === "E27-Relief.loom.json");
  if (file === undefined) throw new Error("E27-Relief.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/** THE DARK ROOM. One scale on the understudy's two halves; nothing else moves. */
function dimmed(graph: GraphDocument): void {
  const bed = graph.nodes["bed"];
  const swell = graph.nodes["swell"];
  if (bed === undefined || swell === undefined) throw new Error("E27 lost `bed`/`swell`");
  const brightness = (bed.parameters as Record<string, unknown>)["brightness"];
  if (typeof brightness !== "number") throw new Error("`bed1.brightness` is not a number");
  (bed.parameters as Record<string, unknown>)["brightness"] = brightness * DIM;
  const fill = (swell.parameters as Record<string, unknown>)["fillcolor"];
  if (!Array.isArray(fill)) throw new Error("`swell1.fillcolor` is not a colour");
  (swell.parameters as Record<string, unknown>)["fillcolor"] = [
    (fill[0] as number) * DIM,
    (fill[1] as number) * DIM,
    (fill[2] as number) * DIM,
    1,
  ];
}

/**
 * OPEN THE EXPOSURE LOOP — the control that makes this a crossing rather than a picture.
 * `norm1.whitelevel` goes back to a static 1.0, which is exactly what the file did before
 * T797 (and exactly what it silently falls back to if `roofsafe1` is ever renamed, since
 * a measured channel IS its node's name, §V129).
 */
function unmetered(graph: GraphDocument): void {
  const norm = graph.nodes["norm"];
  if (norm === undefined) throw new Error("E27 lost `norm`");
  (norm.parameters as Record<string, unknown>)["whitelevel"] = 1;
}

/** Cut the motion out of the height, leaving luminance alone in alpha. */
function stillHeight(graph: GraphDocument): void {
  const edge = (graph.edges as Record<string, { source: { nodeId: string; portId: string } }>)[
    "e-stir-heat"
  ];
  if (edge === undefined) throw new Error("E27 lost `e-stir-heat`");
  edge.source = { nodeId: "norm", portId: "out" };
}

/** T809: one parameter, by node id, so a mutator reads as the knob it turns. */
function setParameter(graph: GraphDocument, nodeId: string, key: string, value: unknown): void {
  const node = graph.nodes[nodeId];
  if (node === undefined) throw new Error(`E27 lost \`${nodeId}\``);
  (node.parameters as Record<string, unknown>)[key] = value;
}

/**
 * T809 — THE CONTROL FOR THE IDENTITY CLAIM. Both driven bindings are replaced by plain
 * numbers, so the audio chain and the colour LFO are still in the graph, still in the
 * plan and still compiled, but nothing they publish can reach a pixel. If the shipped
 * file (both knobs at zero) does not render the SAME BYTES as this, then "optional" is a
 * promise rather than a gate.
 */
function severed(graph: GraphDocument): void {
  setParameter(graph, "lift", "value1", 0);
  setParameter(graph, "coat", "offset", 0);
}

/** T809: the audio knob — the gain the shipped file holds at 0. */
function audioAt(gain: number): (graph: GraphDocument) => void {
  return (graph) => setParameter(graph, "bgain", "operand", gain);
}

/**
 * T809: the colour knob, sampled at a chosen point of its swing. The LFO's own `phase`
 * moves where in the cycle frame 90 lands, so one 91-frame render reaches an extreme of a
 * 29-second sweep — 0.1975 is the top of it and 0.6975 the bottom.
 */
function colourAt(amplitude: number, phase: number): (graph: GraphDocument) => void {
  return (graph) => {
    setParameter(graph, "cycle", "amplitude", amplitude);
    setParameter(graph, "cycle", "phase", phase);
  };
}

/** Both mutators, in order. */
function both(...steps: ReadonlyArray<(graph: GraphDocument) => void>): (graph: GraphDocument) => void {
  return (graph) => {
    for (const step of steps) step(graph);
  };
}

interface Reading {
  /** Mean display-encoded luma, 0..1. The "is there a picture" number. */
  readonly mean: number;
  /** Fraction of pixels above half. The "does it reach the palette's top" number. */
  readonly bright: number;
  /** Per-pixel mean |Δ| against another frame, filled by `compare`. */
  readonly luma: Float64Array;
}

async function shoot(
  mutate: (graph: GraphDocument) => void,
  frame: number,
): Promise<Reading> {
  const { document } = e27();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate(graph);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: frame + 1,
    capture: [frame],
    animate: true,
    outputNodeId: "out",
    fps: 60,
  });
  expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  const captured = result.frames[0];
  if (captured === undefined) throw new Error("no frame");
  const space = result.plan.outputs.find((entry) => entry.nodeId === "out")?.space ?? "linear";
  const image = toRgba8(
    {
      width: captured.width,
      height: captured.height,
      format: captured.format,
      bytes: captured.bytes,
      rowStride: captured.width * (BYTES_PER_PIXEL[captured.format] ?? 8),
    },
    { space },
  );
  const luma = new Float64Array(image.data.length / 4);
  let sum = 0;
  let bright = 0;
  for (let at = 0, pixel = 0; at < image.data.length; at += 4, pixel += 1) {
    const value =
      (0.2126 * (image.data[at] ?? 0) +
        0.7152 * (image.data[at + 1] ?? 0) +
        0.0722 * (image.data[at + 2] ?? 0)) /
      255;
    luma[pixel] = value;
    sum += value;
    if (value > 0.5) bright += 1;
  }
  return { mean: sum / luma.length, bright: bright / luma.length, luma };
}

/** Mean per-pixel |Δ| between two readings of the same size. */
function compare(a: Reading, b: Reading): number {
  let total = 0;
  for (let at = 0; at < a.luma.length; at += 1) total += Math.abs((a.luma[at] ?? 0) - (b.luma[at] ?? 0));
  return total / a.luma.length;
}

/** T809: how many pixels differ AT ALL — the identity claim's own number. */
function differing(a: Reading, b: Reading): number {
  let count = 0;
  for (let at = 0; at < a.luma.length; at += 1) {
    if ((a.luma[at] ?? 0) !== (b.luma[at] ?? 0)) count += 1;
  }
  return count;
}

describe("E27 sets its own exposure, and a dark room still gets a relief (T797)", () => {
  /**
   * THE LEAD CLAIM, and it is a PAIR because a single number cannot say "rescued".
   *
   * The unmetered arm is the shipped file before T797: `norm1` at a static white point,
   * the source arriving one fourteenth as bright, and every point in the sheet compressed
   * into a band near zero — a flat navy rectangle. The metered arm is the same graph with
   * `roof1` allowed to say how bright the frame actually is.
   *
   * Measured on Dawn while writing this: 0.0163 unmetered against 0.1977 metered, and
   * bright pixels 0.00% against 9.5%. The thresholds sit far from both.
   */
  it("recovers a dark source that the open loop leaves flat", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const open = await shoot((graph) => {
      dimmed(graph);
      unmetered(graph);
    }, 90);
    const closed = await shoot(dimmed, 90);

    // Measured 0.0163: the report, reproduced. A flat, near-black plate.
    expect(open.mean).toBeLessThan(FLAT_CEILING);
    expect(open.bright).toBeLessThan(0.001);
    // Measured 0.1977 and 9.5% — past what the LIT understudy reads (0.1713 before T797).
    expect(closed.mean).toBeGreaterThan(LIVELY_FLOOR);
    expect(closed.bright).toBeGreaterThan(0.02);
  }, 240_000);

  /**
   * THE READING THAT WAS WRONG, ASSERTED SO IT STAYS CORRECTED.
   *
   * The natural intuition — the owner's, and it was mine until the frame said otherwise —
   * is that a dark scene has little luminance but plenty of motion, so the motion term
   * carries the frame exactly where the luminance term is starved. It does not: a frame
   * difference of a dark picture is dark by the same factor. Motion is not an alternative
   * to the exposure, it is DOWNSTREAM of it.
   *
   * Measured: 0.0163 with the motion rig and the loop open, against 0.0159 with neither —
   * a 2% difference on a number that has to move by an order of magnitude to matter. This
   * is the assertion that stops someone "simplifying" `norm1` away on the grounds that
   * E41 proved motion is enough.
   */
  it("is NOT rescued by the motion term alone — a dark difference is still dark", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const motionOnly = await shoot((graph) => {
      dimmed(graph);
      unmetered(graph);
    }, 90);
    const neither = await shoot((graph) => {
      dimmed(graph);
      unmetered(graph);
      stillHeight(graph);
    }, 90);

    expect(motionOnly.mean).toBeLessThan(FLAT_CEILING);
    expect(neither.mean).toBeLessThan(FLAT_CEILING);
    // Both flat, and indistinguishably so: under a tenth of the gap the metering opens.
    expect(Math.abs(motionOnly.mean - neither.mean)).toBeLessThan(0.01);
  }, 240_000);

  /**
   * AND THE MOTION TERM IS NOT DECORATION EITHER, once the exposure is closed.
   *
   * The same frame with `stir1` bypassed differs by a mean 0.073 per pixel over more than
   * a third of the frame (measured 0.0734 / 55.5% above 5/255 at 1280x720). Asserted as a
   * COMPARISON rather than a level, because §V712's lesson is that a still frame's summary
   * statistics read identically with the wiring mis-owned.
   */
  it("adds real height where the picture moves, on top of the exposure", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const withMotion = await shoot(dimmed, 90);
    const without = await shoot((graph) => {
      dimmed(graph);
      stillHeight(graph);
    }, 90);

    expect(withMotion.mean).toBeGreaterThan(LIVELY_FLOOR);
    expect(without.mean).toBeGreaterThan(LIVELY_FLOOR);
    // The height changed, not just the exposure.
    expect(compare(withMotion, without)).toBeGreaterThan(0.02);
  }, 240_000);

  /**
   * FRAME 0 HAS NO FLASH, and this is the gate for §V769's thumbnail against §V732's
   * transient.
   *
   * A Cache tap reads the oldest slice WRITTEN (§V229) — and on frame 0 nothing has been
   * written, so it reads black and a difference taken against the live source is the whole
   * picture. Before `now1` was put on the near side, frame 0 measured 0.256 against a
   * steady 0.178: the sheet opened over-lifted and blown, which is exactly the transient
   * §V732 records being baked into a baseline and passing.
   *
   * Asserted as frame 0 AGAINST frame 2, because the absolute level is what the look
   * baseline already guards; what this test is for is that the two agree.
   */
  it("opens on its subject rather than on the cache's empty first difference", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const first = await shoot(() => {}, 0);
    const settled = await shoot(() => {}, 2);

    // Measured 0.1752 against 0.1738 — under 2%. The pre-`now1` file ran +44%.
    expect(first.mean / settled.mean).toBeGreaterThan(0.85);
    expect(first.mean / settled.mean).toBeLessThan(1.15);
  }, 240_000);
});

/**
 * T809 — THE TWO OPTIONAL ADDITIONS, AND "OPTIONAL" IS A GATE HERE RATHER THAN A PROMISE.
 *
 * Owner: "optional audio reactivity to drive relief in some way would be cool and also
 * some sort color rotation". E43 Splice's `amount = 0` identity claim is the pattern
 * (§V147): a feature that ships OFF is only honestly off if the frame with it in the graph
 * is the frame without it, byte for byte — and the file it has to leave alone is the one
 * §T797 tuned two hours earlier, on BOTH of its fixtures.
 *
 * Two knobs, and each is a single number:
 *   - `kick1.operand` (0) — the low band's gain onto `lift1.value1`, which is the kernel's
 *     LIFT AMPLITUDE. Not the exposure: `norm1`'s white point belongs to `roof1`, and a
 *     second driver there would fight the normalisation this file just gained (§V730).
 *   - `cycle1.amplitude` (0) — an LFO onto `coat1.offset`, which slides the picture along
 *     the ramp. Colour only: `braid1` carries the shape in alpha (T503), so this drive
 *     cannot reach the geometry, the exposure, or the motion path.
 *
 * Both are measured on the LIT understudy and on §T797's ×0.14 dark fixture, because "the
 * lit one still reads as the picture it does now" and "the dark one is not made worse" are
 * two different claims and a gate that renders one of them cannot see the other (§V461).
 */
describe("E27's optional audio and colour rotation are OFF at zero, and real above it (T809)", () => {
  /**
   * THE IDENTITY CLAIM, and it is the whole reason the word "optional" is allowed in the
   * row. The control is not "the same file rendered twice" — it is the same file with both
   * DRIVEN BINDINGS replaced by plain numbers, so the audioPattern, the two valueMaths and
   * the LFO are all still in the graph and in the plan, and only their reach is cut.
   *
   * Measured on Dawn while writing this: 0 differing pixels of 921,600, at frame 0 and at
   * frame 90, on both fixtures. Frame 0 is in because §V769 says frame 0 is what a user
   * sees on open and because §T797's `now1` guard lives there — an addition that perturbed
   * the cache ring would show up there first.
   */
  it("is BYTE-IDENTICAL to the file T797 left, on the lit understudy and on the dark fixture", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    for (const [name, base] of [["lit", () => {}], ["dark", dimmed]] as const) {
      for (const frame of [0, 90]) {
        const shipped = await shoot(base, frame);
        const control = await shoot(both(base, severed), frame);
        expect({ arm: name, frame, differing: differing(shipped, control) }).toEqual({
          arm: name,
          frame,
          differing: 0,
        });
      }
    }
  }, 900_000);

  /**
   * AND THE KNOB IS NOT DEAD, which is the assertion that stops the one above being
   * vacuous — §V147 twice over, since an identity claim passes perfectly with the wiring
   * broken.
   *
   * The claim is RHYTHM, not level: the low band rests at 0.713 in the analyser's dB
   * domain (T701) and `bsub1` subtracts exactly that, so between kicks the drive is
   * essentially zero and ON the kick it is the band's full 0.26 excursion. Frames are
   * chosen against 112 bpm at 60 fps — a beat is 32.14 frames, so frame 97 is 0.02 of a
   * beat past the strike and frame 90 is 0.80 of a beat into the decay.
   *
   * Measured at gain 1: mean |Δ| luma 0.0746 on the strike against 0.0110 off it (lit),
   * and 0.0914 on the strike (dark). The dark fixture moves MORE, not less — the driver is
   * a synthesized pattern, so unlike §T797's motion term it is not starved by a dark
   * source, and the auto-gain has already put the height field in full range for it to
   * scale.
   */
  it("answers the KICK when the gain is turned up, and both fixtures get it", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const litRest = await shoot(() => {}, 97);
    const litKick = await shoot(audioAt(1), 97);
    // Measured 0.0746 — a quarter of the frame's own mean, from one number.
    expect(compare(litRest, litKick)).toBeGreaterThan(0.03);

    const litOffBeatRest = await shoot(() => {}, 90);
    const litOffBeat = await shoot(audioAt(1), 90);
    // Measured 0.0110 against the strike's 0.0746: it BREATHES on the beat rather than
    // sitting on. A drive that had lost its rest subtraction would read the same at both.
    expect(compare(litOffBeatRest, litOffBeat)).toBeLessThan(0.03);
    expect(compare(litRest, litKick)).toBeGreaterThan(compare(litOffBeatRest, litOffBeat) * 3);

    const darkRest = await shoot(dimmed, 97);
    const darkKick = await shoot(both(dimmed, audioAt(1)), 97);
    // Measured 0.0914, and the frame still clears §T797's floor rather than blowing past
    // it: audio scales the LIFT, so it moves geometry, not exposure.
    expect(compare(darkRest, darkKick)).toBeGreaterThan(0.03);
    expect(darkKick.mean).toBeGreaterThan(LIVELY_FLOOR);
  }, 900_000);

  /**
   * THE COLOUR SWEEP, AND ITS TWO ENDS BOTH HAVE TO SURVIVE THE DARK FIXTURE.
   *
   * `coat1.offset` slides the picture along the ramp and CLAMPS at the ends — Lookup's
   * shader is `clamp(index * scale + offset, 0, 1)`. That clamp is the reason this is what
   * ships rather than a true wrap-around rotation of `palette1.phase`: this ramp is
   * monotone in luminance by design (T503), a wrap makes it non-monotone, and the .md
   * records what four phases of that looked like. A slide keeps the monotone mapping, so
   * the relief stays legible at every point of the swing.
   *
   * Measured at amplitude 0.1: mean |Δ| luma 0.0464 at the bottom of the swing and 0.0485
   * at the top (lit), 0.0405 at the bottom (dark) — and the DARK frame at the cool end
   * still reads 0.1641 mean, well clear of §T797's 0.12 floor and nowhere near the 0.03
   * that flat-navy failure measured. That last number is the one that matters: sliding the
   * palette DOWN is the move that could have walked a dark frame back into the failure
   * §T797 just fixed, and it does not.
   */
  it("moves the colour at both ends of its swing without walking the dark case back to flat", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const litRest = await shoot(() => {}, 90);
    const litDown = await shoot(colourAt(0.1, 0.6975), 90);
    const litUp = await shoot(colourAt(0.1, 0.1975), 90);
    // Measured 0.0464 and 0.0485. Both ends move, and the picture is not just dimming:
    // the swing is symmetric about the shipped frame.
    expect(compare(litRest, litDown)).toBeGreaterThan(0.02);
    expect(compare(litRest, litUp)).toBeGreaterThan(0.02);
    expect(litDown.mean).toBeLessThan(litRest.mean);
    expect(litUp.mean).toBeGreaterThan(litRest.mean);

    const darkDown = await shoot(both(dimmed, colourAt(0.1, 0.6975)), 90);
    // Measured 0.1641 against the 0.0159 the report reproduced. Cooler, still a relief.
    expect(darkDown.mean).toBeGreaterThan(LIVELY_FLOOR);
    expect(darkDown.bright).toBeGreaterThan(0.02);
  }, 900_000);
});
