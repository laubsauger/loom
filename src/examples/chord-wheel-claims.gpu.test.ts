import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { outputNodeOf, prepareProject, renderFrames, type OutputFrame } from "../tooling/offline-render.ts";

/**
 * E90 CHORD WHEEL — THE CLAIM (T1757b): the picture is WHICH NOTES SOUND.
 *
 * The shipped file, through the load path and the renderer a user's own render takes. A
 * wedge is read at its middle, the root's rim just outside it, and the claims are the ones
 * the file's name makes:
 *
 *  - at 0.3 s the progression is on its first chord, D major: the D, F sharp and A wedges
 *    are lit, the six classes no note or partial of that chord lands on are at the unlit
 *    floor, and the rim is on D;
 *  - at 3.2 s it has moved to A major: the rim is on A and no longer on D — a chord change
 *    moves the picture;
 *  - WITH THE WIRE CUT (Tone Pattern's Amount at 0, nothing else touched) every wedge is at
 *    the floor and there is no rim: the lamps were the notes, not a decoration.
 *
 * MEASURED on the shipped file at 1280 x 720 (16-bit display values, the brightest channel):
 *   lit wedges at 0.3 s        D 57 695   F sharp 34 527   A 41 887
 *   the six silent classes     13 000 to 13 488   (the unlit lamp's own glow)
 * These are DISPLAY values: 34 527 against 13 488 is a wedge about eight times brighter in light.
 *
 * The suite FAILS without Dawn; it never skips.
 */
const FILE = resolve(import.meta.dirname, "../../examples/E90-Chord-Wheel.loom.json");
const D_MAJOR = [2, 6, 9];
const A_MAJOR = [9, 1, 4];
/** The classes no note or partial of D major lands on: its notes' fifths and thirds are A, F sharp, C sharp, A sharp and E. */
const SILENT_UNDER_D = [0, 3, 5, 7, 8, 11];

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

/** The brightest channel at radius `radius` (in the shader's units: 1 is half the height) in the middle of wedge `pitchClass`. */
function at(frame: OutputFrame, pitchClass: number, radius: number): number {
  const angle = (pitchClass / 12) * 2 * Math.PI;
  const x = Math.round(frame.width / 2 + ((radius * Math.sin(angle)) / 2) * frame.height);
  const y = Math.round(frame.height / 2 - ((radius * Math.cos(angle)) / 2) * frame.height);
  const offset = (y * frame.width + x) * 4;
  return Math.max(frame.rgba[offset] as number, frame.rgba[offset + 1] as number, frame.rgba[offset + 2] as number);
}
const WEDGE = 0.6;
const RIM = 0.86;

describe("E90 Chord Wheel — claims", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it("the lit wedges are the chord's notes, the rim is on its root, and a chord change moves both", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const text = readFileSync(FILE, "utf8");
    const first = await shoot(text, 0.3);
    const lit = D_MAJOR.map((pitchClass) => at(first, pitchClass, WEDGE));
    const unlit = SILENT_UNDER_D.map((pitchClass) => at(first, pitchClass, WEDGE));
    console.log(`0.3 s: D / F sharp / A ${lit.join(" / ")}; the six silent classes ${unlit.join(" / ")}`);
    // Every chord tone's wedge is more than twice the display value of the brightest silent one.
    expect(Math.min(...lit)).toBeGreaterThan(2 * Math.max(...unlit));
    // The root is the strongest class (the bass, the triad's root and the lead all sound it): full scale.
    expect(lit[0]).toBe(Math.max(...Array.from({ length: 12 }, (_, pitchClass) => at(first, pitchClass, WEDGE))));
    // The rim: on D and nowhere else.
    expect(at(first, 2, RIM)).toBeGreaterThan(50_000);
    expect([0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((pitchClass) => at(first, pitchClass, RIM))).toEqual(new Array(11).fill(0));

    // The second bar is A major: the rim has moved to A, and A's own triad is what is lit.
    const second = await shoot(text, 3.2);
    expect(at(second, 9, RIM)).toBeGreaterThan(50_000);
    expect(at(second, 2, RIM)).toBe(0);
    const unlitUnderA = [0, 2, 3, 5, 7, 10].map((pitchClass) => at(second, pitchClass, WEDGE));
    expect(Math.min(...A_MAJOR.map((pitchClass) => at(second, pitchClass, WEDGE)))).toBeGreaterThan(2 * Math.max(...unlitUnderA));
  }, 240_000);

  it("with the wire cut — Tone Pattern's Amount at 0, nothing else touched — every lamp is at the floor and there is no rim", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const text = readFileSync(FILE, "utf8");
    const parsed = JSON.parse(text) as { graph: { nodes: Record<string, { label?: string; parameters: Record<string, unknown> }> } };
    const song = Object.values(parsed.graph.nodes).find((node) => node.label === "tones_song");
    expect(song, "the file has no tones_song node").toBeDefined();
    song!.parameters["amount"] = 0;
    const silent = await shoot(JSON.stringify(parsed), 0.3);
    const playing = await shoot(text, 0.3);
    const wedges = Array.from({ length: 12 }, (_, pitchClass) => at(silent, pitchClass, WEDGE));
    // The floor is the unlit lamp's own glow: every wedge equals what a silent class reads while the song plays.
    expect(Math.max(...wedges)).toBeLessThanOrEqual(Math.max(...SILENT_UNDER_D.map((pitchClass) => at(playing, pitchClass, WEDGE))) + 2_000);
    expect(Array.from({ length: 12 }, (_, pitchClass) => at(silent, pitchClass, RIM))).toEqual(new Array(12).fill(0));
    // And the same pixels DO differ with the song on: this is the edge, not a constant.
    expect(at(playing, 2, WEDGE)).toBeGreaterThan(3 * (wedges[2] as number));
  }, 240_000);
});
