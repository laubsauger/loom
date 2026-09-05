import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { renderHeadless, type RenderedFrame } from "../tests/headless/render-harness.ts";
import type { ColorSpace } from "../domain/types/ports.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * B186 — E2 AND E24'S CLAIMS. A REACTION-DIFFUSION IS A PATTERN, OR IT IS A FIXED POINT.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * E2 is one of the oldest examples in the catalogue and it predates the claims
 * discipline, so nothing anywhere asserted its PICTURE. It rendered black in the app for
 * a long time and every gate stayed green, which is the whole reason this file exists.
 *
 * ## What the concept requires, and why "it moved" is not enough
 *
 * Gray-Scott has a uniform fixed point: U saturated, V zero, everywhere. Nothing in it
 * is broken — it is the equations evolving a state that has nothing to evolve. A field
 * sitting on it is smooth, dark and DEAD, and it still passes a look baseline's motion
 * term through the animated chemistry map underneath it, which keeps changing colour
 * while the chemistry does nothing. So the claim has to be about STRUCTURE: a field that
 * is patterned (a wide spread between its dark and its bright), and whose pattern is
 * still being rewritten late in the run.
 *
 * ## THE LOAD RITE IS THE THING THAT BROKE IT, so the claim is stated across it
 *
 * The app runs T552's document-boundary rite — `resetTemporalHistory(undefined, {
 * buffers: true })` — before the first frame of every document it opens.
 * `renderHeadless` never did, so every offline gate started this simulation from FRESH
 * textures while every user started it from CLEARED ones. Those were not the same state:
 * a clear wrote vgpu's default `[0, 0, 0, 1]`, an allocation is zeroed. The kernel's
 * re-seed flag is `alpha < 0.5`, so in the app it never seeded, U ramped to 1 through
 * the feed term, V stayed 0 and the picture was the fixed point (§B186; the byte-level
 * statement is `runtime/backend/vgpu/reset-boundary.gpu.test.ts`).
 *
 * The first claim below is therefore the one that would have caught it, and it is exact
 * rather than a threshold (§V147): a cleared pair and a fresh pair are the same state,
 * so the same document rendered across the rite and without it is the same computation
 * and must come back BYTE FOR BYTE identical. Nothing about that assertion has to be
 * tuned, and it fails the moment the two entrances diverge again for any reason.
 */

const FRAMES = 181;
const CAPTURE = [60, 180] as const;
/* Small enough to run twice per example, and it changes nothing about the simulation:
   both documents PIN their Feedback pair to 512×512 (§V50/§V51), so the chemistry runs
   at its shipped resolution whatever the output is sampled at. */
const PROBE = { width: 192, height: 108 } as const;

function example(fileName: string) {
  const file = listExamples().find((entry) => entry.fileName === fileName);
  if (file === undefined) throw new Error(`${fileName} is not shipped`);
  return requireExample(file);
}

const srgbToLinear = (byte: number): number => {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
};

/** Linear luma per pixel, decoded through the PLAN's own output space (§V618). */
function lumaOf(frame: RenderedFrame, space: ColorSpace): Float64Array {
  const image = toRgba8(
    {
      width: frame.width,
      height: frame.height,
      format: frame.format,
      bytes: frame.bytes,
      rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
    },
    { space },
  );
  const out = new Float64Array(image.data.length / 4);
  for (let at = 0, pixel = 0; at < image.data.length; at += 4, pixel += 1) {
    out[pixel] =
      0.2126 * srgbToLinear(image.data[at] ?? 0) +
      0.7152 * srgbToLinear(image.data[at + 1] ?? 0) +
      0.0722 * srgbToLinear(image.data[at + 2] ?? 0);
  }
  return out;
}

const quantile = (luma: Float64Array, at: number): number => {
  const sorted = Float64Array.from(luma).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(at * sorted.length))] ?? 0;
};

const meanAbsoluteDifference = (a: Float64Array, b: Float64Array): number => {
  let sum = 0;
  for (let pixel = 0; pixel < a.length; pixel += 1) sum += Math.abs((a[pixel] ?? 0) - (b[pixel] ?? 0));
  return sum / a.length;
};

async function render(fileName: string, runTheLoadRite: boolean) {
  const { document } = example(fileName);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document.graph,
    settings: { ...document.settings, outputResolution: { ...PROBE } },
    frames: FRAMES,
    capture: [...CAPTURE],
    fps: 60,
    animate: true,
    ...(runTheLoadRite ? { beforeFrames: (control) => control.resetTemporalHistory() } : {}),
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  expect(errors, `${fileName} rendered with errors`).toEqual([]);
  const space = result.plan.outputs[0]?.space ?? "linear";
  return {
    frames: result.frames,
    early: lumaOf(result.frames[0] as RenderedFrame, space),
    late: lumaOf(result.frames[1] as RenderedFrame, space),
  };
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/**
 * Both documents carry `GRAY_SCOTT_WGSL` VERBATIM, so they share the band, the seed and
 * the fault; a class of one here was never a class of one.
 */
const SUBJECTS = [
  "E2-Reaction-Diffusion.loom.json",
  "E24-Audio-Reaction-Diffusion.loom.json",
] as const;

/**
 * THE STRUCTURE CLAIM IS E2'S ALONE, AND THAT IS A MEASUREMENT, NOT AN OVERSIGHT.
 *
 * Both documents were run against the fixed point (the fix reverted by hand, then restored by hand)
 * and against the healthy field, at this probe, frame 180:
 *
 *              brightest   p999−p001   lit>0.25   motion(60→180)
 *   E2  dead     0.0645      0.0000      0.0000       0.02053
 *   E2  alive    0.9592      0.8631      0.3804       0.21586
 *   E24 dead     0.9975      0.9830      0.0228       0.03307
 *   E24 alive    0.9975      0.9893      0.0407       0.04402
 *
 * E24's frame is a colony sitting inside a beat-driven ring burst, and the rings are the
 * bright, moving, wide-spanning part of it. With the chemistry dead its OUTPUT is still
 * bright, still spans the palette and still moves — every structural threshold that would
 * separate the two rows sits inside a factor of two, which is a number tuned to a build
 * rather than a claim about a concept. So E24 is covered by the EXACT claim above, which
 * failed loudly on both examples when the fix was reverted, and its picture claim is
 * declined here in writing rather than fitted.
 *
 * E2's own motion row is the §V147 lesson restated: a DEAD Gray-Scott field still measures
 * 0.02053 of frame-to-frame motion, because the animated chemistry map underneath keeps
 * recolouring a picture that is not changing. Motion is kept below as a claim about the
 * simulation still running, with its floor set well clear of what a fixed point produces —
 * it is corroboration for the structure claims, never a substitute for them.
 */
const E2 = {
  fileName: "E2-Reaction-Diffusion.loom.json",
  brightest: 0.5,
  spread: 0.4,
  lit: 0.1,
  motion: 0.1,
} as const;

describe("B186 — the reaction-diffusion pair carries a pattern, on the app's open path", () => {
  for (const fileName of SUBJECTS) {
    const name = fileName.replace(".loom.json", "");

    it(
      `${name}: opening the document is the same computation as never resetting (byte-exact)`,
      async () => {
        if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
        const withRite = await render(fileName, true);
        const without = await render(fileName, false);
        for (let index = 0; index < CAPTURE.length; index += 1) {
          const a = withRite.frames[index] as RenderedFrame;
          const b = without.frames[index] as RenderedFrame;
          expect(
            Array.from(a.bytes),
            `frame ${CAPTURE[index]}: the boundary rite changed the render. A cleared ` +
              `temporal resource must be indistinguishable from a fresh one (§B186).`,
          ).toEqual(Array.from(b.bytes));
        }
      },
      600_000,
    );
  }

  it(
    `${E2.fileName.replace(".loom.json", "")}: the field is PATTERNED and still evolving, after the load rite`,
    async () => {
      if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
      const { early, late } = await render(E2.fileName, true);

      // 1. PATTERNED. A fixed point is one value everywhere; a Gray-Scott pattern has
      //    filaments that reach the top of the palette over a dark bed. Dead: 0.0645.
      let brightest = 0;
      for (const value of late) if (value > brightest) brightest = value;
      expect(
        brightest,
        "E2 never reaches the bright end of its palette — a flat field does that",
      ).toBeGreaterThan(E2.brightest);
      // Dead: 0.0000 — the fixed point is ONE value, so its span is nothing at all.
      expect(
        quantile(late, 0.999) - quantile(late, 0.001),
        "E2 spans almost no luma: the field is uniform, which is the fixed point",
      ).toBeGreaterThan(E2.spread);

      // 2. NOT SMOOTH. Spread alone can come from one bright corner, so count the
      //    pattern: a real Gray-Scott field puts a healthy minority of pixels well
      //    above the bed (0.3804), and a fixed point puts NONE there (0.0000).
      let lit = 0;
      for (const value of late) if (value > 0.25) lit += 1;
      expect(
        lit / late.length,
        "E2 has essentially no lit structure — the field settled",
      ).toBeGreaterThan(E2.lit);

      // 3. STILL EVOLVING at three seconds. Alive 0.21586, dead 0.02053 — see the note
      //    above for why this floor is high and why it is not the load-bearing one.
      expect(
        meanAbsoluteDifference(early, late),
        `E2 stopped changing between frames ${CAPTURE[0]} and ${CAPTURE[1]}`,
      ).toBeGreaterThan(E2.motion);
    },
    600_000,
  );
});
