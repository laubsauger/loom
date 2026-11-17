import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { outputNodeOf, prepareProject, renderFrames, type OutputFrame } from "../tooling/offline-render.ts";
import { MUSIC_FEATURES_FLOOR_Y, MUSIC_FEATURES_KICK, MUSIC_FEATURES_LAMPS, MUSIC_FEATURES_STRIP } from "./shaders/music-features.wgsl.ts";

/**
 * E91 MUSIC FEATURES, THE CLAIM (T1805b): each mark on the panel is one output of the
 * MusicFeatures component, and takes its light from that wire.
 *
 * The shipped file, through the load path and the renderer a user's own render takes, from
 * 0 s so the component's followers carry their history. Three marks are read at a pixel:
 *
 *  - the kick bar, at 0.8 of the half-height out from the middle: lit 0.1 s after a kick,
 *    dark 0.45 s after it. The bar reaches 0.1 + 1.6 kick², so 0.8 needs a kick above 0.66;
 *    the pulse reads 0.76 to 0.84 at its peak and 0.35 to 0.40 before the next kick
 *    (`music-features-claims.test.ts`);
 *  - the root strip: at 5.1 s the song is on A, cell 9; at 9.1 s on B minor, cell 11;
 *  - the five lamps, at their middles.
 *
 * AND WITH A WIRE CUT (the edge from the instance to one tap removed, nothing else
 * touched): without `beats` the bar is dark at the kick, and without `notes` the lamps are
 * unlit, while the marks on the other wires stay exactly as they were.
 *
 * MEASURED on the shipped file at 1280 x 720 (16-bit display values, the brightest channel):
 *   kick bar at 0.8        65 503 on the kick     25 088 before the next   24 656 with `beats` cut
 *   root cell              65 503 lit             17 136 to 23 264 unlit
 *   lamp middles, 9.1 s    46 111 to 64 991       18 848 to 21 840 with `notes` cut
 * These are DISPLAY values: an unlit mark still shows the backdrop behind it. The
 * assertions keep a factor of two between lit and unlit.
 *
 * The suite FAILS without Dawn; it never skips.
 */
const FILE = resolve(import.meta.dirname, "../../examples/E91-Music-Features.loom.json");

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

async function shoot(text: string, seconds: number): Promise<OutputFrame> {
  const project = prepareProject(text, { path: FILE });
  const frames: OutputFrame[] = [];
  const fps = 60;
  await renderFrames({
    project,
    outputNodeId: outputNodeOf(project.document, undefined),
    fps,
    spp: 1,
    first: Math.round(seconds * fps),
    count: 1,
    onFrame: (frame) => {
      frames.push(frame);
    },
  });
  return frames[0] as OutputFrame;
}

/** The brightest channel at the shader's `p` (centred, y down, 1 is half the height). */
function at(frame: OutputFrame, x: number, y: number): number {
  const column = Math.round(frame.width / 2 + (x * frame.height) / 2);
  const row = Math.round(frame.height / 2 + (y * frame.height) / 2);
  const offset = (row * frame.width + column) * 4;
  return Math.max(frame.rgba[offset] as number, frame.rgba[offset + 1] as number, frame.rgba[offset + 2] as number);
}
const kickBar = (frame: OutputFrame): number => at(frame, 0.8, MUSIC_FEATURES_FLOOR_Y);
const rootCell = (frame: OutputFrame, pitchClass: number): number => at(frame, MUSIC_FEATURES_STRIP.left + (pitchClass + 0.5) * MUSIC_FEATURES_STRIP.cell, MUSIC_FEATURES_STRIP.y);
const lamps = (frame: OutputFrame): number[] => [0, 1, 2, 3, 4].map((voice) => at(frame, (voice - 2) * MUSIC_FEATURES_LAMPS.spacing, MUSIC_FEATURES_LAMPS.y));

/** The shipped file with the wire into one tap removed. */
function withoutWireInto(text: string, tap: string): string {
  const parsed = JSON.parse(text) as { graph: { nodes: Record<string, { id: string; label?: string }>; edges: Record<string, { target: { nodeId: string } }> } };
  const target = Object.values(parsed.graph.nodes).find((node) => node.label === tap);
  if (target === undefined) throw new Error(`the file has no ${tap} node`);
  const wires = Object.entries(parsed.graph.edges).filter(([, wire]) => wire.target.nodeId === target.id);
  if (wires.length !== 1) throw new Error(`${tap} has ${String(wires.length)} wires in, expected the one from the component`);
  delete parsed.graph.edges[wires[0]![0]];
  return JSON.stringify(parsed);
}

describe("E91 Music Features — claims", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it("the bar is wide on the kick and back before the next; the root cell follows the chord; the lamps are lit", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    // The geometry this test reads the bar by: 0.8 is inside its reach at a full kick, outside it at rest.
    expect(MUSIC_FEATURES_KICK.rest).toBeLessThan(0.8);
    expect(MUSIC_FEATURES_KICK.rest + MUSIC_FEATURES_KICK.travel).toBeGreaterThan(0.8);

    const text = readFileSync(FILE, "utf8");
    // Beats are every 0.5 s: 9.1 s is 0.1 s after a kick, 9.45 s is 0.05 s before the next.
    const onKick = await shoot(text, 9.1);
    const beforeKick = await shoot(text, 9.45);
    console.log(`kick bar at 0.8: ${String(kickBar(onKick))} on the kick, ${String(kickBar(beforeKick))} before the next`);
    expect(kickBar(onKick)).toBeGreaterThan(40_000);
    expect(kickBar(onKick)).toBeGreaterThan(2 * kickBar(beforeKick));

    // The progression: A at 5.1 s (the second chord), B minor at 9.1 s (the third).
    const onA = await shoot(text, 5.1);
    const cells = (frame: OutputFrame): number[] => Array.from({ length: 12 }, (_, pitchClass) => rootCell(frame, pitchClass));
    console.log(`root cells at 5.1 s: ${cells(onA).join(" ")}; at 9.1 s: ${cells(onKick).join(" ")}`);
    const litCell = (frame: OutputFrame): number => cells(frame).indexOf(Math.max(...cells(frame)));
    expect(litCell(onA)).toBe(9);
    expect(litCell(onKick)).toBe(11);
    expect(rootCell(onA, 9)).toBeGreaterThan(2 * rootCell(onKick, 9));
    expect(rootCell(onKick, 11)).toBeGreaterThan(2 * rootCell(onA, 11));

    console.log(`lamps at 9.1 s: ${lamps(onKick).join(" ")}`);
    expect(Math.min(...lamps(onKick))).toBeGreaterThan(20_000);
  }, 480_000);

  it("with the wire into a tap cut, that mark goes out and the others do not move", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const text = readFileSync(FILE, "utf8");
    const whole = await shoot(text, 9.1);

    const noBeats = await shoot(withoutWireInto(text, "select_beats"), 9.1);
    console.log(`without beats: kick bar ${String(kickBar(noBeats))} (was ${String(kickBar(whole))}); lamps ${lamps(noBeats).join(" ")}`);
    expect(kickBar(whole)).toBeGreaterThan(2 * kickBar(noBeats));
    expect(lamps(noBeats)).toEqual(lamps(whole));
    expect(rootCell(noBeats, 11)).toBe(rootCell(whole, 11));

    const noNotes = await shoot(withoutWireInto(text, "select_notes"), 9.1);
    console.log(`without notes: lamps ${lamps(noNotes).join(" ")} (were ${lamps(whole).join(" ")}); kick bar ${String(kickBar(noNotes))}`);
    expect(Math.min(...lamps(whole))).toBeGreaterThan(2 * Math.max(...lamps(noNotes)));
    expect(kickBar(noNotes)).toBe(kickBar(whole));
  }, 480_000);
});
