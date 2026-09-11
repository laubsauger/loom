import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * T1296 — §V640'S TRIPLE, WHERE A GATE CAN READ IT.
 *
 * §V640 records how hard the environment lands on a subject's OUTLINE against its BODY,
 * and the ratio is the reading: above 1 the term prefers the silhouette (a rim), below 1
 * it prefers the interior (fill wearing a rim's name). Three arms were measured — E13's
 * curved prism at 10.2×, E33's lobed goo at 1.8×, E33's flat emblem at 0.74× — and the
 * flat one is the number the E68 art direction rests on, because "a temple of flat slabs
 * gets no reflections from this renderer" is that figure restated.
 *
 * ⚑ TWO OF THE THREE LIVED ONLY IN PROSE, AND SO THEY ROTTED SILENTLY. E13's arm is a
 * test (`prism.gpu.test.ts`) and survived. E33's two were measured ad hoc at 154ddf1 and
 * written into `E33-Obol.md`'s table — nothing ran them, so when §T1289 changed the
 * environment term from a dimming to a blur, both went stale and no gate said a word. That
 * is the §V957 shape again, arriving through prose rather than through a missing script:
 * **a number that lives only in a document is a number nothing checks.**
 *
 * ⚑ AND THE BLOCKER WAS AN INSTRUMENT, NOT A DIFFICULTY. §V640's method needs an OBJECT
 * MASK, and E33's bloom lights every pixel in the frame above any sane threshold, so the
 * mask swallows the image (measured: 897744 of 921600 pixels "interior", which is the
 * frame minus its own 6 px border). E13 solved exactly this with two handles — mute the
 * bloom, turn the drawn backdrop off — and E33 had neither. They are ported here rather
 * than re-invented (§V676: re-deriving a method produces a third set of numbers for one
 * invariant and makes the record worse).
 */

function e33() {
  const file = listExamples().find((entry) => entry.fileName === "E33-Obol.loom.json");
  if (file === undefined) throw new Error("E33-Obol.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

interface Frame {
  readonly w: number;
  readonly h: number;
  readonly d: Uint8Array | Uint8ClampedArray;
}

function param(graph: GraphDocument, id: string, key: string, value: unknown): void {
  const node = graph.nodes[id];
  if (node === undefined) throw new Error(`E33 has no \`${id}\` node`);
  (node.parameters as Record<string, unknown>)[key] = value;
}

/**
 * THE BLOOM, MUTED — E13's handle, ported (`prism.gpu.test.ts`).
 *
 * `cut1` is the Level that thresholds the picture before `veil1` blurs it and `bloom1`
 * adds it back. Pushing its window above every value in the frame makes it emit black, so
 * the add adds nothing: the real chain still runs, no pass is removed, and nothing
 * downstream has to know. Without this a 34 px blur smears the silhouette's own light
 * across the body it is being compared against, and the ring/interior split stops being a
 * split at all.
 */
function muteBloom(graph: GraphDocument): void {
  param(graph, "cut", "blacklevel", 4);
  param(graph, "cut", "whitelevel", 5);
}

/** E13's other handle: the environment as LIGHT only, never drawn behind the subject. */
function soloBackdropOff(graph: GraphDocument): void {
  param(graph, "shot", "showEnvironment", false);
}

/**
 * THE SUBJECT, SOLOED — and this is E13's third handle, which took a measurement to find.
 *
 * `soloPrism` names ONE scene (`scenes: "solid1"`) so the frame contains the subject and
 * nothing else. E33 renders `cyc1 body1 shards1`, and `cyc1` is a CYCLORAMA — a lit plaster
 * wall filling the frame behind the object. With bloom muted and the backdrop off, the mask
 * still covered all 921600 pixels, because the thing lighting them was never the bloom: it
 * was a wall that is legitimately part of the scene.
 *
 * So the environment cut moves that wall too, and every one of its pixels is a real |Δ|
 * with no silhouette to belong to. Dropping it is what leaves an object to have an outline
 * and a body — which is the whole of §V640's method — and it is the same edit E13 makes,
 * not a new one.
 */
function soloBody(graph: GraphDocument): void {
  /* `body1 shards1`, not `body1`: T716/T724 moved the emblem INTO the tiles — at the
     emblem end the disc is made of `shards1` and the body behind it is barely lit, so
     soloing the body alone left 8 lit pixels and an empty interior. The cyclorama is the
     only thing dropped, because it is the only thing that is not the subject. */
  param(graph, "shot", "scenes", "body1 shards1");
  /* AND THE BACKGROUND GOES BLACK, which E13 gets for free and E33 does not. §V640's mask
     is "lit above 1 of 255", and E33's background is [0.008, 0.009, 0.013] — about 25/255
     once display-encoded, so every pixel in the frame passes the threshold on the colour
     alone. It cannot touch the measurement: both arms carry the same background, so it
     cancels in every |Δ| and changes only which pixels are called subject. */
  param(graph, "shot", "background", [0, 0, 0, 1]);
}

/**
 * The environment cut, and it is NOT the same edit E13 makes.
 *
 * E13 sets `environmentIntensity` on the render node. E33's is a DRIVEN slot (`envrest1`
 * feeds it), and a driven slot beats the static underneath it — so writing 0 there would
 * change nothing and the "unwired" arm would silently be the wired one, which is the
 * §V288 shape that would have made this whole measurement a lie. Replacing the parameter
 * outright removes the slot with it.
 */
function environmentOff(graph: GraphDocument): void {
  const shot = graph.nodes["shot"];
  if (shot === undefined) throw new Error("E33 has no `shot` node");
  (shot.parameters as Record<string, unknown>)["environmentIntensity"] = 0;
}

async function shoot(frameIndex: number, mutate: (graph: GraphDocument) => void): Promise<Frame> {
  const { document, result } = e33();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate(graph);
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: frameIndex + 1,
    capture: [frameIndex],
    animate: true,
    outputNodeId: "out",
    ...(result.components ? { components: result.components } : {}),
  });
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const frame = rendered.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  const space = rendered.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
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
  return { w: image.width, h: image.height, d: image.data };
}

const luma = (frame: Frame, pixel: number): number =>
  0.2126 * (frame.d[pixel * 4] ?? 0) + 0.7152 * (frame.d[pixel * 4 + 1] ?? 0) + 0.0722 * (frame.d[pixel * 4 + 2] ?? 0);

/** Four-neighbour erosion, `radius` times — §V640's own 6 px split (E13's code). */
function erode(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  let current = mask;
  for (let step = 0; step < radius; step += 1) {
    const next = new Uint8Array(current.length);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const at = y * w + x;
        next[at] =
          current[at] === 1 && current[at - 1] === 1 && current[at + 1] === 1 && current[at - w] === 1 && current[at + w] === 1
            ? 1
            : 0;
      }
    }
    current = next;
  }
  return current;
}

interface Split {
  readonly ring: number;
  readonly interior: number;
  readonly room: number;
  readonly ratio: number;
  readonly ringPixels: number;
  readonly interiorPixels: number;
}

/** §V640's measurement, verbatim: mean |Δ| luma split by a 6 px erosion of the mask. */
async function v640Split(frameIndex: number): Promise<Split> {
  const isolate = (graph: GraphDocument): void => {
    muteBloom(graph);
    soloBackdropOff(graph);
    soloBody(graph);
  };
  const lit = await shoot(frameIndex, isolate);
  const dark = await shoot(frameIndex, (graph) => {
    isolate(graph);
    environmentOff(graph);
  });

  const mask = new Uint8Array(lit.w * lit.h);
  for (let pixel = 0; pixel < mask.length; pixel += 1) mask[pixel] = luma(lit, pixel) > 1 ? 1 : 0;
  const interiorMask = erode(mask, lit.w, lit.h, 6);

  let ring = 0;
  let ringPixels = 0;
  let interior = 0;
  let interiorPixels = 0;
  let room = 0;
  let roomPixels = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const delta = Math.abs(luma(lit, pixel) - luma(dark, pixel));
    if (mask[pixel] !== 1) {
      room += delta;
      roomPixels += 1;
      continue;
    }
    if (interiorMask[pixel] === 1) {
      interior += delta;
      interiorPixels += 1;
    } else {
      ring += delta;
      ringPixels += 1;
    }
  }
  const ringMean = ring / Math.max(ringPixels, 1);
  const interiorMean = interior / Math.max(interiorPixels, 1);
  return {
    ring: ringMean,
    interior: interiorMean,
    room: room / Math.max(roomPixels, 1),
    ratio: ringMean / Math.max(interiorMean, 1e-6),
    ringPixels,
    interiorPixels,
  };
}

describe("E33 Obol — §V640's triple, on E13's instrument (T1296)", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  /**
   * THE MASK IS A MASK, which is the thing that was broken and the reason this file exists.
   *
   * Asserted before either arm, because every number below is meaningless if the isolation
   * did not take: without the two handles the object mask covered 897744 of 921600 pixels
   * — the whole frame minus its own border — and the "interior" mean was an average over
   * the sky. A subject that is a sane fraction of the frame is what makes the split a
   * split.
   */
  it("the isolation handles produce an object mask, not a lit frame", async () => {
    const goo = await v640Split(484);
    const covered = goo.ringPixels + goo.interiorPixels;
    expect(covered).toBeGreaterThan(1000);
    // Well under a third of the frame: the subject, not the sky.
    expect(covered).toBeLessThan(921600 / 3);
  }, 300_000);

  /**
   * §V640'S TWO E33 ARMS, MEASURED — and the headline is that the shipped numbers were an
   * ARTEFACT OF THE INSTRUMENT rather than a fact about the renderer.
   *
   * The md's table records goo 45.8 / 25.9 (1.8×) and emblem 14.5 / 19.5 (0.74×), measured
   * ad hoc at 154ddf1 with an isolation nobody wrote down. On the instrument above — E13's
   * handles, ported, with every deviation named — the same two frames read:
   *
   *              ring      interior   ratio
   *   goo    f484  120.4      45.8     2.63x
   *   emblem f0     24.9      22.4     1.11x
   *
   * ⚑ SO THE FLAT ARM IS NOT 0.74x AND NEVER WAS FILL-DOMINATED ON THIS INSTRUMENT. That
   * matters beyond this file: "a temple of flat slabs gets no reflections from this
   * renderer" is 0.74x restated, and it is an input to an art-direction decision. What a
   * documented isolation measures is ~1.1 — the environment lands very slightly harder on
   * the outline than in the body, which is neither a rim nor fill but roughly even.
   *
   * ⚑ AND §T1289 IS NOT WHAT MOVED THEM. Measured on THIS instrument with the pre-T1289
   * term temporarily restored (a sharp sample dimmed by `1 − roughness`) and then put back:
   *
   *              before (dim)          after (blur)         ratio change
   *   goo    2.619x (115.0 / 43.9)   2.627x (120.4 / 45.8)     +0.3%
   *   emblem 1.126x (23.7 / 21.0)    1.111x (24.9 / 22.4)      −1.4%
   *
   * The blur raised the environment's absolute contribution about 5% on both subjects and
   * left both RATIOS where they were. So the difference between 0.74x and 1.11x is the
   * instrument, not the change — which is exactly why §V640's triple now lives in a test.
   */
  it("the goo rims and the flat emblem is roughly even — §V640's two E33 arms", async () => {
    const goo = await v640Split(484);
    const emblem = await v640Split(0);

    /* THE GOO RIMS. Above 1 by a wide margin: the environment lands 2.6x harder on the
       silhouette than in the body, which is what §V640 calls a rim. The fence is well
       under the measured 2.63 so ordinary drift does not trip it, and well over the 1.8
       §V640 calls the weakest thing still worth the word. */
    expect(goo.ratio).toBeGreaterThan(2.0);

    /* THE FLAT EMBLEM DOES NOT. It sits near 1 — neither a rim nor fill — and the fence is
       a BAND rather than a floor, because both directions are findings: falling under 1
       would mean flats went fill-dominated (the E68 premise), and climbing toward the goo's
       2.6 would mean a flat surface started rimming, which §V640 says it cannot. */
    expect(emblem.ratio).toBeGreaterThan(0.9);
    expect(emblem.ratio).toBeLessThan(1.4);

    /* And the room stays dark: with the cyclorama soloed out there is nothing else in the
       frame for the environment to light, so a non-zero here means the isolation leaked. */
    expect(goo.room).toBe(0);
    expect(emblem.room).toBe(0);
  }, 600_000);
});
