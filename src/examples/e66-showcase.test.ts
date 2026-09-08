import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { featureTrackLength, readFeatureFrame } from "../domain/audio/feature-track.ts";
import { storedStaticValue } from "../domain/parameters/slots.ts";
import { analyseOffline } from "../app/audio-offline-analysis.ts";
import { AUDIO_DETECTOR_DEFAULTS } from "../nodes/definitions/audio.ts";
import {
  SHOWCASE_BEAT,
  SHOWCASE_BEAT_FILE,
  SHOWCASE_BEAT_OFFSET_SECONDS,
  renderShowcaseBeat,
  showcaseBarStart,
} from "./build-showcase-beat.ts";
import { meterDocument } from "./documents/meter.ts";

/**
 * T1236 — THE SHOWCASE CLIP IS WHAT ITS LEGEND SAYS IT IS.
 *
 * E66's `.md` tells the reader what plays in which bar and what the detector counts, and
 * those sentences are only worth reading because the clip is generated: `SHOWCASE_BEAT`
 * states the grid, `renderShowcaseBeat()` renders it, and this file holds the three
 * statements of that grid — the generator's constants, its docblock, the `.md` table —
 * against each other and against the shipped detector's own count. A drum moved in the
 * generator without the legend moving reddens here; so does a detector change that stops
 * counting the clip the legend describes.
 *
 * The count is measured the way the app measures it: `analyseOffline` at 60 fps with
 * `AUDIO_DETECTOR_DEFAULTS`, which is exactly the walk `shipped-clip-audio.ts` feeds the
 * example gates. The numbers are EXACT (§V147): 56 kicks, 28 snares, 75 hats, and zero of
 * anything in the two silent bars.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FPS = 60;

/** One walk for the file; the render is pure and the walk is ~1 s. */
const analysis = analyseOffline(renderShowcaseBeat(), SHOWCASE_BEAT.sampleRate, FPS, AUDIO_DETECTOR_DEFAULTS);
const frames = Array.from({ length: featureTrackLength(analysis.track) }, (_, index) =>
  readFeatureFrame(analysis.track, index),
);

/** Sum of a count lane over 1-based bars `from..to` inclusive. */
function countInBars(lane: "kickCount" | "snareCount" | "hatCount" | "onsetCount", from: number, to: number): number {
  const start = showcaseBarStart(from);
  const end = showcaseBarStart(to + 1);
  let total = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const seconds = index / FPS;
    if (seconds >= start && seconds < end) total += frames[index]![lane];
  }
  return total;
}

const { bars, hatsDropped, silence, openHatFrom, beatsPerBar } = SHOWCASE_BEAT;
const playedBars = bars - (silence.to - silence.from + 1);

describe("T1236 — the showcase clip counts exactly what the legend says", () => {
  it("is measuring a real walk of the whole clip", () => {
    // A guard on the guard: the track covers the file, and the file is the stated length —
    // `analyseOffline` records `ceil(samples / samplesPerFrame) + 1` frames, so the frame
    // AT the file's end reads a record and not SILENCE.
    const seconds = (SHOWCASE_BEAT.leadInBeats + bars * beatsPerBar) * (60 / SHOWCASE_BEAT.bpm);
    expect(frames.length).toBe(Math.ceil(seconds * FPS) + 1);
    expect(analysis.track.fps).toBe(FPS);
  });

  it("56 kicks, 28 snares, 75 hats — the numbers the .md and the README quote", () => {
    expect(countInBars("kickCount", 1, bars)).toBe(playedBars * beatsPerBar); // 56
    expect(countInBars("snareCount", 1, bars)).toBe(playedBars * 2); // 28
    // Closed hats on eighths: 8 per bar in 1–4 and in bar 11; 7 from 12 on, because the
    // open hat on the last off-beat rings through the next downbeat.
    const closedHatBars = hatsDropped.from - 1;
    const hats = closedHatBars * 8 + 8 + (bars - openHatFrom) * 7;
    expect(hats).toBe(75);
    expect(countInBars("hatCount", 1, bars)).toBe(hats);
  });

  it("the hats are gone for exactly the dropped bars, and everything is gone for the silence", () => {
    expect(countInBars("hatCount", hatsDropped.from, hatsDropped.to)).toBe(0);
    expect(countInBars("kickCount", hatsDropped.from, hatsDropped.to)).toBe((hatsDropped.to - hatsDropped.from + 1) * beatsPerBar);
    for (const lane of ["kickCount", "snareCount", "hatCount", "onsetCount"] as const) {
      expect(countInBars(lane, silence.from, silence.to), lane).toBe(0);
    }
    // The open-hat bars: the first carries all eight closed hats (nothing rang into its
    // downbeat), every later one carries seven.
    expect(countInBars("hatCount", openHatFrom, openHatFrom)).toBe(8);
    for (let bar = openHatFrom + 1; bar <= bars; bar += 1) expect(countInBars("hatCount", bar, bar), `bar ${String(bar)}`).toBe(7);
  });

  it("the lead-in is silent, so the first kick is beat one and not frame zero", () => {
    expect(countInBars("onsetCount", 0, 0)).toBe(0);
  });
});

describe("T1236 — the three statements of the grid agree", () => {
  const docblock = readFileSync(join(HERE, "build-showcase-beat.ts"), "utf8").split("*/")[0]!;
  const legend = readFileSync(join(ROOT, "examples", "E66-Meter.md"), "utf8");
  const range = (r: { from: number; to: number }) => `${String(r.from)}–${String(r.to)}`;

  it("the generator's docblock states the constants' grid", () => {
    expect(docblock).toContain(`${String(SHOWCASE_BEAT.bpm)} BPM`);
    expect(docblock).toContain(`${String(bars)} bars`);
    expect(docblock).toContain(`${SHOWCASE_BEAT_OFFSET_SECONDS.toFixed(3)} s`);
    expect(docblock).toMatch(new RegExp(`bars\\s+${range(hatsDropped)}\\s+HATS DROPPED`));
    expect(docblock).toMatch(new RegExp(`bars\\s+${range(silence)}\\s+SILENCE`));
    expect(docblock).toMatch(new RegExp(`bars\\s+${String(openHatFrom)}–${String(bars)}\\s+full again, with an OPEN hat`));
    expect(docblock).toContain("56 kicks");
    expect(docblock).toContain("28 snares");
    expect(docblock).toContain("75 hats");
  });

  it("the .md legend states the same grid and the same three counts", () => {
    expect(legend).toContain(`${String(SHOWCASE_BEAT.bpm)} BPM`);
    expect(legend).toContain(`then ${String(bars)} bars`);
    expect(legend).toContain(`Beat one is at ${SHOWCASE_BEAT_OFFSET_SECONDS.toFixed(3)} s`);
    expect(legend).toMatch(new RegExp(`^\\| ${range(hatsDropped)} \\| hats dropped \\|$`, "m"));
    expect(legend).toMatch(new RegExp(`^\\| ${range(silence)} \\| silence \\|$`, "m"));
    expect(legend).toMatch(new RegExp(`^\\| ${String(openHatFrom)}–${String(bars)} \\| full again, with an open hat`, "m"));
    expect(legend).toContain("**56 kicks**, **28 snares** and **75 hats**");
  });

  it("E66 declares the tempo the generator states, on the file the generator writes", () => {
    const clip = Object.values(meterDocument.graph.nodes).find((node) => node.type === "audioFileIn");
    expect(clip).toBeDefined();
    const read = (key: string) => storedStaticValue(clip!.parameters[key]);
    expect(read("file")).toBe(SHOWCASE_BEAT_FILE);
    expect(read("tempoMode")).toBe("declared");
    expect(read("bpm")).toBe(SHOWCASE_BEAT.bpm);
    expect(read("beatsPerBar")).toBe(beatsPerBar);
    expect(read("beatOffset")).toBe(Math.round(SHOWCASE_BEAT_OFFSET_SECONDS * 1000) / 1000);
    expect(read("playMode")).toBe("timeline");
  });

  it("the encoded clip ships at the address the document binds", () => {
    const encoded = join(ROOT, "public", SHOWCASE_BEAT_FILE);
    expect(existsSync(encoded), encoded).toBe(true);
    // ~485 KB when it landed; a WAV at this address would be 3 MB and a regression of T1236's size condition.
    expect(statSync(encoded).size).toBeLessThan(600_000);
  });
});
