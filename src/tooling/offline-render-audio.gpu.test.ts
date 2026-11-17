import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphOf, node } from "../domain/components/test-support.ts";
import { buildProjectFile } from "../domain/project/project-file.ts";
import { testDocument, testSettings } from "../domain/project/test-support.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { SHARED_UNIFORMS_WGSL } from "../runtime/backend/shared-uniforms.ts";
import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { outputNodeOf, prepareProject, renderFrames, type OutputFrame } from "./offline-render.ts";

/**
 * T1754b — `pnpm render` HEARS an Audio File In, on Dawn, through ffmpeg.
 *
 * The file: A4 for a second, D5 for a second, half a second of silence — pure sines, so the
 * Chroma node's reading is exact: class 9 alone, then class 2 alone, then nothing. The picture
 * is those two classes as red and green and the source's own `level` as blue, so a pixel says
 * which second of the FILE the frame heard.
 *
 *  - locked to the timeline, each frame hears the file at the timeline's own second, wherever
 *    the render starts;
 *  - in free run the file starts at its in point on the render's first stepped frame, as a
 *    free-running movie does, and the render says so;
 *  - two renders are the same bytes;
 *  - a microphone and a file that is not on this machine render silence AND say why — before
 *    this row every audio node rendered silence here and nothing said anything.
 */
const FPS = 8;
const SAMPLE_RATE = 48_000;

let dawnError: string | undefined;
let dir = "";
let wav = "";
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
  dir = mkdtempSync(join(tmpdir(), "loom-render-audio-"));
  wav = join(dir, "a-then-d.wav");
  writeFileSync(wav, toneWav());
}, 60_000);
afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});
const needDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
};

/** A4 for 1 s, D5 for 1 s, silence for 0.5 s: mono 32-bit float WAV at 48 kHz, which ffmpeg passes through untouched. */
/** `scale` multiplies every sample in float32: `toneWav(0.1)` is the file a -20 dB trim of `toneWav()` is analysed as (T1769b). */
function toneWav(scale = 1): Buffer {
  const count = SAMPLE_RATE * 2.5;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + count * 4, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(count * 4, 40);
  const samples = new Float32Array(count);
  const d5 = 440 * 2 ** (5 / 12);
  for (let i = 0; i < SAMPLE_RATE; i += 1) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  for (let i = SAMPLE_RATE; i < SAMPLE_RATE * 2; i += 1) samples[i] = 0.5 * Math.sin((2 * Math.PI * d5 * i) / SAMPLE_RATE);
  return Buffer.concat([header, Buffer.from(samples.map((sample) => sample * scale).buffer)]);
}

/** Red: the A class. Green: the D class. Blue: the source node's own level. */
const HEARD = `${SHARED_UNIFORMS_WGSL}
struct Params {
  a: f32, // @default 0  The A class.
  d: f32, // @default 0  The D class.
  level: f32, // @default 0  The source's level.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(params.a, params.d, params.level, 1.0);
}`;

const reads = (source: string): never =>
  ({ mode: "expression", bindings: { expression: { kind: "expression", source }, static: { kind: "static", value: 0 } } }) as never;
const edge = (id: string, from: string, to: string): GraphDocument["edges"][string] => ({
  id,
  source: { nodeId: from, portId: "out" },
  target: { nodeId: to, portId: "input" },
});

function projectText(source: { readonly type: "audioFileIn" | "audioIn"; readonly parameters: Record<string, string | number> }): string {
  const graph = graphOf(
    [
      node("sound", source.type, source.parameters, { label: "audiofile_tone" }),
      // Raw readings: no follower between the file and the pixel.
      node("notes", "audioChroma", { attack: 0, release: 0 }, { label: "chroma_tone" }),
      node("seed", "solid", { color: [0, 0, 0, 1] }, { label: "solid_seed" }),
      node(
        "fx",
        "customWgsl",
        {
          source: HEARD,
          a: reads("op('chroma_tone').chan.chroma9"),
          d: reads("op('chroma_tone').chan.chroma2"),
          level: reads("op('audiofile_tone').chan.level"),
        },
        { label: "fx_heard" },
      ),
      node("out", "output", {}, { label: "output_heard" }),
    ],
    { e1: edge("e1", "seed", "fx"), e2: edge("e2", "fx", "out") },
  );
  return buildProjectFile({
    document: testDocument({ name: "render-audio-test", graph, settings: testSettings({ outputResolution: { width: 4, height: 4 }, fps: FPS }) }),
    components: [],
    now: () => "2026-11-12T00:00:00.000Z",
  }).text;
}

const fileText = (file: string, playMode: "timeline" | "freeRun"): string => projectText({ type: "audioFileIn", parameters: { file, playMode, extend: "black" } });

async function render(text: string, first: number, count: number, warmup?: number): Promise<{ frames: OutputFrame[]; notes: string[] }> {
  const project = prepareProject(text, { path: join(dir, "render-audio-test.loom.json") });
  const frames: OutputFrame[] = [];
  const notes: string[] = [];
  await renderFrames({
    project,
    outputNodeId: outputNodeOf(project.document, undefined),
    fps: FPS,
    spp: 1,
    first,
    count,
    ...(warmup === undefined ? {} : { warmup }),
    onFrame: (frame) => {
      frames.push(frame);
    },
    onNote: (note) => notes.push(note),
  });
  return { frames, notes };
}

/**
 * A class reading exactly 1, as a 16-bit display value. The output stores the display-encoded
 * value in a half float, and the GPU's encode of 1.0 lands a hair under it, which a half holds
 * as its largest value below one: 1 − 2⁻¹¹. Anything from there up is "full"; a class at 0.99
 * would read 65,2xx and fail.
 */
const FULL = Math.round((1 - 2 ** -11) * 65_535);

/** What a frame heard: "A", "D", "silence", or the raw pixel when it is none of those. */
function heard(frame: OutputFrame): string {
  const [a, d, level] = frame.rgba;
  if ((a as number) >= FULL && d === 0 && (level as number) > 0) return "A";
  if (a === 0 && (d as number) >= FULL && (level as number) > 0) return "D";
  if (a === 0 && d === 0 && level === 0) return "silence";
  return `${String(a)}/${String(d)}/${String(level)}`;
}

describe("pnpm render hears an Audio File In (T1754b)", () => {
  it("locked to the timeline: each frame hears the file at the timeline's own second, and a second render is the same bytes", async () => {
    needDawn();
    const { frames, notes } = await render(fileText(wav, "timeline"), 0, 20);
    // A frame reads the window CENTRED on it (§T1752b): 0 s, 0.5 s and 0.875 s lie inside the
    // A (the last one's window ends before the D begins), 1.5 s inside the D, 2.375 s in silence.
    expect([1, 4, 7, 12, 19].map((index) => heard(frames[index] as OutputFrame))).toEqual(["A", "A", "A", "D", "silence"]);
    // Frame 0 itself: the pitch class is already there (its window reaches forward into the
    // note) and the source's own level is not yet (its window looks back, at nothing).
    expect([...(frames[0] as OutputFrame).rgba.subarray(0, 3)]).toEqual([FULL, 0, 0]);
    expect(notes.some((note) => note.includes(`Audio File In "audiofile_tone": heard 2.50 s`) && note.includes("tonal pass on"))).toBe(true);

    const again = await render(fileText(wav, "timeline"), 0, 20);
    expect(again.frames.map((frame) => [...frame.rgba])).toEqual(frames.map((frame) => [...frame.rgba]));
  }, 180_000);

  it("locked to the timeline: a cold render from 1.5 s hears the D — a position on the timeline, not a history", async () => {
    needDawn();
    const { frames } = await render(fileText(wav, "timeline"), 12, 1, 0);
    expect(frames.map(heard)).toEqual(["D"]);
  }, 120_000);

  it("free run: the file starts at its in point on the render's first frame, and the render says so", async () => {
    needDawn();
    // The timeline is at 1.5 s, where a locked file sounds the D. The file, running free, is
    // at its own 0: the A, and still the A half a second in.
    const { frames, notes } = await render(fileText(wav, "freeRun"), 12, 5, 0);
    expect([heard(frames[1] as OutputFrame), heard(frames[4] as OutputFrame)]).toEqual(["A", "A"]);
    expect(notes.some((note) => note.includes(`Audio File In "audiofile_tone" runs free`) && note.includes("first stepped frame (1.500 s)"))).toBe(true);
  }, 120_000);

  it("T1769b — the node's Input Gain reaches the render: the file at -20 dB renders the pixels of the same file a tenth as loud, and says so", async () => {
    needDawn();
    const quiet = join(dir, "a-then-d-quiet.wav");
    writeFileSync(quiet, toneWav(0.1));
    const locked = (file: string, inputGain: number): string => projectText({ type: "audioFileIn", parameters: { file, playMode: "timeline", extend: "black", inputGain } });
    const pixels = (frames: OutputFrame[]): number[][] => frames.map((frame) => [...frame.rgba]);

    const trimmed = await render(locked(wav, -20), 0, 8);
    const tenth = await render(locked(quiet, 0), 0, 8);
    const untrimmed = await render(locked(wav, 0), 0, 8);
    // The blue channel is the source's `level`: the trimmed file's is the quiet file's, to the bit.
    expect(pixels(trimmed.frames)).toEqual(pixels(tenth.frames));
    // Cut the trim and the level is ten times as high: a different picture.
    expect((untrimmed.frames[4] as OutputFrame).rgba[2]).toBeGreaterThan((trimmed.frames[4] as OutputFrame).rgba[2] as number);
    expect((trimmed.frames[4] as OutputFrame).rgba[2]).toBeGreaterThan(0);
    expect(trimmed.notes.some((note) => note.includes("heard 2.50 s") && note.includes("input gain -20 dB"))).toBe(true);
    expect(untrimmed.notes.some((note) => note.includes("input gain"))).toBe(false);
  }, 180_000);

  it("a file this machine cannot reach renders silence and names why", async () => {
    needDawn();
    const { frames, notes } = await render(fileText("blob:http://localhost:5173/0d1e#tone.wav", "timeline"), 4, 1, 0);
    expect(frames.map(heard)).toEqual(["silence"]);
    expect(notes.some((note) => note.includes(`"audiofile_tone"`) && note.includes("blob:") && note.includes("read silence"))).toBe(true);
  }, 120_000);

  it("a microphone renders silence and says an offline render has none", async () => {
    needDawn();
    const { frames, notes } = await render(projectText({ type: "audioIn", parameters: {} }), 4, 1, 0);
    expect(frames.map(heard)).toEqual(["silence"]);
    expect(notes.some((note) => note.includes("microphone") && note.includes("read silence"))).toBe(true);
  }, 120_000);
});
