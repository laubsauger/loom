import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument } from "../domain/types/graph.ts";
import type { ParameterSlot } from "../domain/types/parameters.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_OFFSET_SECONDS, showcaseBarStart } from "./build-showcase-beat.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";
import { shippedClipAudio } from "./shipped-clip-audio.ts";

/**
 * E66 METER — THE CLAIMS, ONE PER LANE (T1236, §V953).
 *
 * The example's sentence is "every lane the analysis publishes owns one visible thing", and
 * a sentence like that is ten claims, not one: for each lane, what changes in the frame
 * when the lane is CUT — its expression detached and the parameter held at its retained
 * value — and, where the legend says so, in which direction it moves the picture between
 * two moments of the clip. Every render below HEARS the clip through the same seam the
 * example gates use (`shipped-clip-audio.ts`), so a claim here is about the frame a viewer
 * of the shipped document sees under the timeline lock.
 *
 * WHERE THE MOMENTS COME FROM. The clip is generated on a grid (`build-showcase-beat.ts`),
 * so "just after the snare on 2 of bar 3", "mid bar 6, hats dropped" and "deep in the
 * silence" are frame numbers derived from `SHOWCASE_BEAT`, not frames somebody picked by
 * looking. The silence is the control for every count lane: two seconds after the last
 * drum a 250 ms release has decayed below one byte, so a cut count lane and the shipped one
 * must render the SAME bytes there — and a lane that still differed would be reading
 * something other than the clip.
 *
 * WHERE THE PICTURE IS READ. Regions are in the picture's own aspect-corrected radius from
 * the centre, in pixels of the render height: the core and the hand live inside the ring's
 * hole (r < 48), the ring is the annulus 48…60 the two circles leave, and the sparks and
 * the backdrop are everywhere. "Differs only in the annulus" is therefore a shape claim on
 * the set of differing pixels, which is what separates "the snare flashes the ring" from
 * "the snare changes the frame somewhere".
 */

const SIZE = { width: 320, height: 180 };
const FPS = 60;
const CENTRE = { x: SIZE.width / 2, y: SIZE.height / 2 };

const SECONDS_PER_BEAT = 60 / SHOWCASE_BEAT.bpm;
const SECONDS_PER_BAR = SECONDS_PER_BEAT * SHOWCASE_BEAT.beatsPerBar;
/** Frame index of 1-based `beat` of 1-based `bar`, plus `afterMs`. */
const frameAt = (bar: number, beat: number, afterMs: number): number =>
  Math.round(((showcaseBarStart(bar) + (beat - 1) * SECONDS_PER_BEAT) + afterMs / 1000) * FPS);

/** The moments. Bar 3 is full, bar 6 has no hats, bar 10 is silence. */
const MOMENTS = {
  /** 50 ms after beat 1 of bar 3: a kick and an onset, no snare. */
  kickOn: frameAt(3, 1, 50),
  /** 400 ms after beat 1 of bar 3: the kick's release has run four fifths of the way. */
  kickOff: frameAt(3, 1, 400),
  /** 50 ms after beat 2 of bar 3: the snare. */
  snareOn: frameAt(3, 2, 50),
  /** 400 ms after beat 1 of bar 6: hats dropped, the same point in the bar as `kickOff`. */
  noHats: frameAt(6, 1, 400),
  /** 3.2 s into the silence, before the bed swells back in over bar 10's last beat. */
  silence: frameAt(10, 3, -100),
} as const;

const LAST_FRAME = Math.max(...Object.values(MOMENTS));

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function e66() {
  const file = listExamples().find((entry) => entry.fileName === "E66-Meter.loom.json");
  if (file === undefined) throw new Error("E66-Meter.loom.json is not shipped");
  return requireExample(file);
}

/**
 * CUT a lane: switch the slot's mode to `static`, so the parameter reads its retained value
 * and the expression is still in the file — the same state the inspector's mode toggle
 * produces, and what a host with no audio effectively sees.
 */
function cut(graph: GraphDocument, nodeId: string, ...keys: string[]): void {
  const node = graph.nodes[nodeId];
  if (node === undefined) throw new Error(`no node "${nodeId}"`);
  for (const key of keys) {
    const slot = node.parameters[key] as ParameterSlot | undefined;
    if (slot === undefined || typeof slot !== "object" || !("bindings" in slot)) {
      throw new Error(`"${key}" on "${nodeId}" is not a bound slot`);
    }
    if (slot.mode !== "expression") throw new Error(`"${key}" on "${nodeId}" is not driven by an expression`);
    node.parameters = { ...node.parameters, [key]: { ...slot, mode: "static" } };
  }
}

interface Image {
  readonly data: Uint8Array;
}

type Shot = Record<number, Image>;

/** Render the shipped document, optionally mutated, capturing every moment in one pass. */
async function shoot(mutate?: (graph: GraphDocument) => void): Promise<Shot> {
  const { document, result } = e66();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate?.(graph);
  const audio = shippedClipAudio(graph, FPS);
  if (audio === undefined) throw new Error("E66 binds no shipped clip");
  const capture = [...new Set(Object.values(MOMENTS))].sort((a, b) => a - b);
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: { ...SIZE } },
    frames: LAST_FRAME + 1,
    capture,
    outputNodeId: "out",
    fps: FPS,
    animate: true,
    components: result.components!,
    audio,
  });
  const errors = rendered.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const space = rendered.plan.outputs.find((o) => o.nodeId === "out")?.space ?? "linear";
  const shot: Shot = {};
  for (const frame of rendered.frames) {
    shot[frame.frameIndex] = toRgba8(
      { width: frame.width, height: frame.height, format: frame.format, bytes: frame.bytes, rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8) },
      { space },
    );
  }
  return shot;
}

/** Aspect-corrected distance from the centre, in pixels of the render height. */
function radiusOf(pixel: number): number {
  const x = (pixel % SIZE.width) + 0.5 - CENTRE.x;
  const y = Math.floor(pixel / SIZE.width) + 0.5 - CENTRE.y;
  return Math.hypot(x, y);
}

/** Clockwise angle from twelve o'clock, in degrees 0…360, of a pixel about the centre. */
function angleOf(pixel: number): number {
  const x = (pixel % SIZE.width) + 0.5 - CENTRE.x;
  const y = Math.floor(pixel / SIZE.width) + 0.5 - CENTRE.y;
  return ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
}

/** The ring's hole, the ring itself, and everything outside it — see the docblock. */
const HOLE = 48;
const RING_OUTER = 60;

/** Pixels whose rgb differs by more than one byte in any channel between two images. */
function differing(a: Image, b: Image): number[] {
  const out: number[] = [];
  for (let at = 0, pixel = 0; at < a.data.length; at += 4, pixel += 1) {
    if (
      Math.abs(a.data[at]! - b.data[at]!) > 1 ||
      Math.abs(a.data[at + 1]! - b.data[at + 1]!) > 1 ||
      Math.abs(a.data[at + 2]! - b.data[at + 2]!) > 1
    ) out.push(pixel);
  }
  return out;
}

function identical(a: Image, b: Image): boolean {
  return differing(a, b).length === 0;
}

const lin = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lumaAt = (image: Image, pixel: number): number =>
  0.2126 * lin(image.data[pixel * 4]!) + 0.7152 * lin(image.data[pixel * 4 + 1]!) + 0.0722 * lin(image.data[pixel * 4 + 2]!);

/** Mean linear luma over the pixels a predicate on (radius, angle) selects. */
function meanLuma(image: Image, where: (r: number, angle: number) => boolean): number {
  let sum = 0;
  let count = 0;
  for (let pixel = 0; pixel < SIZE.width * SIZE.height; pixel += 1) {
    if (!where(radiusOf(pixel), angleOf(pixel))) continue;
    sum += lumaAt(image, pixel);
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/** Pixels the sharp core saturates: red at the top of the range, which only the core's fill reaches. */
function coreArea(image: Image): number {
  let area = 0;
  for (let pixel = 0; pixel < SIZE.width * SIZE.height; pixel += 1) {
    if (image.data[pixel * 4]! >= 250 && radiusOf(pixel) < HOLE) area += 1;
  }
  return area;
}

/** Mean hue, in degrees, of the pixels a predicate selects — read off the mean rgb. */
function meanHue(image: Image, where: (r: number, angle: number) => boolean): number {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let pixel = 0; pixel < SIZE.width * SIZE.height; pixel += 1) {
    if (!where(radiusOf(pixel), angleOf(pixel))) continue;
    r += image.data[pixel * 4]!;
    g += image.data[pixel * 4 + 1]!;
    b += image.data[pixel * 4 + 2]!;
    count += 1;
  }
  r /= count;
  g /= count;
  b /= count;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((hue * 60) + 360) % 360;
}

/** The clockwise angle the hand should be at: 360 × barPhase, from the declared grid. */
function handAngleAt(frameIndex: number): number {
  const seconds = frameIndex / FPS;
  const bars = (seconds - SHOWCASE_BEAT_OFFSET_SECONDS) / SECONDS_PER_BAR;
  return ((bars - Math.floor(bars)) * 360) % 360;
}

/** The brightest one-degree ray through the band 30…46, where the hand lies clear of the core. */
function brightestRay(image: Image): number {
  let best = 0;
  let bestLuma = -1;
  for (let angle = 0; angle < 360; angle += 1) {
    const luma = meanLuma(image, (r, a) => r >= 30 && r <= 46 && Math.abs(((a - angle + 540) % 360) - 180) < 1);
    if (luma > bestLuma) {
      bestLuma = luma;
      best = angle;
    }
  }
  return best;
}

const angularGap = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe("E66 Meter — every lane owns one visible thing (T1236)", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  let shipped: Shot;
  beforeAll(async () => {
    if (dawnError !== undefined) return;
    shipped = await shoot();
  }, 120_000);

  it("the moments are where the grid says: bar 3 is full, bar 6 has no hats, bar 10 is silent", () => {
    expect(SHOWCASE_BEAT.hatsDropped.from).toBeLessThanOrEqual(6);
    expect(SHOWCASE_BEAT.hatsDropped.to).toBeGreaterThanOrEqual(6);
    expect(SHOWCASE_BEAT.silence.from).toBeLessThanOrEqual(10);
    expect(SHOWCASE_BEAT.silence.to).toBeGreaterThanOrEqual(10);
    expect(3).toBeLessThan(SHOWCASE_BEAT.hatsDropped.from);
  });

  it("hits.snareCount → the RING: cutting it dims the annulus on the snare and nothing outside it; in the silence it changes nothing", { timeout: 120_000 }, async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const noSnare = await shoot((graph) => cut(graph, "snap", "brightness"));
    const changed = differing(shipped[MOMENTS.snareOn]!, noSnare[MOMENTS.snareOn]!);
    expect(changed.length).toBeGreaterThan(400);
    const outside = changed.filter((pixel) => radiusOf(pixel) < HOLE - 2 || radiusOf(pixel) > RING_OUTER + 2);
    expect(outside, "the snare touched something other than the ring").toEqual([]);
    // What the lane ADDS to the annulus — the halo also reaches it, so the ring is the
    // difference against the cut render, not the annulus's own luma. 50 ms after the snare
    // the release is at 0.82 of a white ring; 50 ms after the kick on 1, the last snare
    // (bar 2, beat 4) is 566 ms gone and at 0.10.
    const annulus = (r: number) => r >= HOLE + 2 && r <= RING_OUTER - 2;
    const ringOn = meanLuma(shipped[MOMENTS.snareOn]!, annulus) - meanLuma(noSnare[MOMENTS.snareOn]!, annulus);
    const ringOff = meanLuma(shipped[MOMENTS.kickOn]!, annulus) - meanLuma(noSnare[MOMENTS.kickOn]!, annulus);
    expect(ringOn).toBeGreaterThan(0.3);
    expect(ringOff).toBeLessThan(0.12);
    expect(ringOff).toBeGreaterThan(0.02);
    expect(identical(shipped[MOMENTS.silence]!, noSnare[MOMENTS.silence]!)).toBe(true);
  });

  it("hits.hatCount → the SPARKS: cutting it removes a sparse scatter across the whole frame in bar 3, and nothing in bar 6 or the silence", { timeout: 120_000 }, async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const noHats = await shoot((graph) => cut(graph, "hats", "brightness"));
    const changed = differing(shipped[MOMENTS.kickOn]!, noHats[MOMENTS.kickOn]!);
    const share = changed.length / (SIZE.width * SIZE.height);
    expect(share).toBeGreaterThan(0.005);
    expect(share).toBeLessThan(0.08);
    // Sparks, not a patch: every quadrant has some.
    const quadrants = new Set(changed.map((pixel) => `${String(pixel % SIZE.width < CENTRE.x)}${String(Math.floor(pixel / SIZE.width) < CENTRE.y)}`));
    expect(quadrants.size).toBe(4);
    expect(identical(shipped[MOMENTS.noHats]!, noHats[MOMENTS.noHats]!), "hats dropped in bar 6, yet the lane drew").toBe(true);
    expect(identical(shipped[MOMENTS.silence]!, noHats[MOMENTS.silence]!)).toBe(true);
  });

  it("hits.onsetCount → the BACKDROP: cutting it darkens the whole field just after a drum, and nothing in the silence", { timeout: 120_000 }, async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const noFlash = await shoot((graph) => cut(graph, "flash", "brightness"));
    const changed = differing(shipped[MOMENTS.kickOn]!, noFlash[MOMENTS.kickOn]!);
    expect(changed.length / (SIZE.width * SIZE.height)).toBeGreaterThan(0.9);
    const field = (r: number) => r > RING_OUTER + 4;
    expect(meanLuma(shipped[MOMENTS.kickOn]!, field)).toBeGreaterThan(1.5 * meanLuma(noFlash[MOMENTS.kickOn]!, field));
    expect(identical(shipped[MOMENTS.silence]!, noFlash[MOMENTS.silence]!)).toBe(true);
  });

  it("hits.kickCount → the CORE's jump: the saturated disc grows more from 400 ms after the beat to 50 ms after it than the bass alone grows it", { timeout: 120_000 }, async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const noKick = await shoot((graph) => cut(graph, "kick", "s.x", "s.y"));
    // The low band hears the kick too, so the cut disc still breathes between the two
    // moments (`levels.low` is the next claim); the jump is what the scale adds ON TOP: a
    // factor 1.35² = 1.82 at the peak against 1 + 0.35·e^(−0.4/0.25) = 1.07 at 400 ms.
    const shippedRatio = coreArea(shipped[MOMENTS.kickOn]!) / coreArea(shipped[MOMENTS.kickOff]!);
    const cutRatio = coreArea(noKick[MOMENTS.kickOn]!) / coreArea(noKick[MOMENTS.kickOff]!);
    expect(shippedRatio).toBeGreaterThan(1.3 * cutRatio);
    const changed = differing(shipped[MOMENTS.kickOn]!, noKick[MOMENTS.kickOn]!);
    expect(changed.length).toBeGreaterThan(400);
    // The jump is the disc's, and its blur follows it into the annulus; nothing past the ring.
    expect(changed.filter((pixel) => radiusOf(pixel) < HOLE).length).toBeGreaterThan(0.8 * changed.length);
    expect(changed.filter((pixel) => radiusOf(pixel) > RING_OUTER + 2), "the kick reached past the ring").toEqual([]);
    expect(identical(shipped[MOMENTS.silence]!, noKick[MOMENTS.silence]!)).toBe(true);
  });

  it("levels.low → the CORE's radius: the disc in a full bar is several times the disc in the silence, and cut, the two are the same", { timeout: 120_000 }, async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const noLow = await shoot((graph) => cut(graph, "core", "radius.x", "radius.y"));
    const shippedRatio = coreArea(shipped[MOMENTS.kickOff]!) / coreArea(shipped[MOMENTS.silence]!);
    const cutRatio = coreArea(noLow[MOMENTS.kickOff]!) / coreArea(noLow[MOMENTS.silence]!);
    expect(shippedRatio).toBeGreaterThan(3);
    // Only the kick's tail (1.07 at 400 ms) separates the two cut discs.
    expect(cutRatio).toBeLessThan(1.2);
    expect(cutRatio).toBeGreaterThan(0.95);
  });

  it("levels.level → the HALO's spread: in a full bar the light reaches further out than with the size held, and in the silence it stays closer in", { timeout: 120_000 }, async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const noSpread = await shoot((graph) => cut(graph, "halo", "size"));
    // A blur moves light outward without adding any: a wider one lifts the far band and a
    // narrower one leaves it, so the band OUTSIDE the disc reads the spread. In a full bar
    // the disc reaches ~26 px, so 30…48 is outside it; in the silence it is ~9 px and
    // 12…24 is outside it — and there the HELD size (24) is the wider of the two.
    const loudBand = (r: number) => r >= 30 && r <= HOLE;
    const quietBand = (r: number) => r >= 12 && r <= 24;
    expect(meanLuma(shipped[MOMENTS.kickOff]!, loudBand)).toBeGreaterThan(1.3 * meanLuma(noSpread[MOMENTS.kickOff]!, loudBand));
    expect(1.15 * meanLuma(shipped[MOMENTS.silence]!, quietBand)).toBeLessThan(meanLuma(noSpread[MOMENTS.silence]!, quietBand));
  });

  it("levels.high → the HALO's brightness: at the held value while the hats play, half of it once they drop — and cut, it does not dim", { timeout: 120_000 }, async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const noGlow = await shoot((graph) => cut(graph, "glow", "brightness"));
    // The rank normaliser puts the snare's top end at 1 and the hats at about 0.5 (`high` is
    // the band's level, not its count), so in a full bar the lane sits at the retained
    // brightness; the thing it OWNS is the drop in bars 5–8. Read in the band between the
    // disc and the hole, where the halo is not clipped.
    const halo = (r: number) => r >= 30 && r <= HOLE;
    const full = meanLuma(shipped[MOMENTS.kickOff]!, halo) / meanLuma(noGlow[MOMENTS.kickOff]!, halo);
    const dropped = meanLuma(shipped[MOMENTS.noHats]!, halo) / meanLuma(noGlow[MOMENTS.noHats]!, halo);
    expect(full).toBeGreaterThan(0.85);
    expect(full).toBeLessThan(1.3);
    expect(dropped).toBeLessThan(0.65);
    expect(differing(shipped[MOMENTS.noHats]!, noGlow[MOMENTS.noHats]!).length).toBeGreaterThan(400);
  });

  it("levels.centroid → the HALO's hue: warmer once the hats drop than while they play, and cut, the hue holds", { timeout: 120_000 }, async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const noTint = await shoot((graph) => cut(graph, "tint", "hueoffset"));
    const halo = (r: number) => r >= 40 && r <= 46;
    const full = meanHue(shipped[MOMENTS.kickOff]!, halo);
    const dropped = meanHue(shipped[MOMENTS.noHats]!, halo);
    expect(angularGap(full, dropped)).toBeGreaterThan(20);
    // Warmer = a smaller hue angle on the red side of yellow.
    expect(((full - dropped + 360) % 360) < 180).toBe(true);
    expect(angularGap(meanHue(noTint[MOMENTS.kickOff]!, halo), meanHue(noTint[MOMENTS.noHats]!, halo))).toBeLessThan(6);
  });

  it("clip1.barPhase → the HAND's angle: the brightest ray is at 360 × barPhase from the declared grid at every moment, and cut, it is at twelve", { timeout: 120_000 }, async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const noSweep = await shoot((graph) => cut(graph, "sweep", "r"));
    for (const [name, frame] of Object.entries(MOMENTS)) {
      expect(angularGap(brightestRay(shipped[frame]!), handAngleAt(frame)), name).toBeLessThan(3);
      expect(angularGap(brightestRay(noSweep[frame]!), 0), `${name}, cut`).toBeLessThan(3);
    }
    // The moments are not all at the same phase, or the claim above would be one number.
    expect(angularGap(handAngleAt(MOMENTS.kickOn), handAngleAt(MOMENTS.snareOn))).toBeGreaterThan(60);
  });

  it("clip1.beatPhase → the HAND's brightness: brighter than the held value just after a beat, dimmer 400 ms on", { timeout: 120_000 }, async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const noTick = await shoot((graph) => cut(graph, "tick", "brightness"));
    const alongHand = (frame: number) => (r: number, a: number) =>
      r >= 30 && r <= 46 && angularGap(a, handAngleAt(frame)) < 1;
    expect(meanLuma(shipped[MOMENTS.kickOn]!, alongHand(MOMENTS.kickOn))).toBeGreaterThan(
      1.2 * meanLuma(noTick[MOMENTS.kickOn]!, alongHand(MOMENTS.kickOn)),
    );
    expect(meanLuma(shipped[MOMENTS.kickOff]!, alongHand(MOMENTS.kickOff))).toBeLessThan(
      0.8 * meanLuma(noTick[MOMENTS.kickOff]!, alongHand(MOMENTS.kickOff)),
    );
  });
});
