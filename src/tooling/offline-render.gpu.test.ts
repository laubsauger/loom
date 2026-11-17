import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphOf, instanceNode, node } from "../domain/components/test-support.ts";
import { buildProjectFile } from "../domain/project/project-file.ts";
import { testDocument, testSettings } from "../domain/project/test-support.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import { SHARED_UNIFORMS_WGSL } from "../runtime/backend/shared-uniforms.ts";
import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { linearToSrgb } from "../runtime/export/pixel-format.ts";
import { outputNodeOf, prepareProject, renderFrames, type OutputFrame, type PrepareOptions, type RenderOutcome } from "./offline-render.ts";

/**
 * T1738b — `pnpm render` on a real GPU (§V147: every value exact or derived from the shader).
 *
 *  - `--spp` is a shutter: each output frame is the LINEAR mean of its own sub-frames, which
 *    start at the frame's own time. A sawtooth that ramps over one output frame averages to
 *    3/8, and a level that names the output frame stays whole, so a group one sub-frame off
 *    would show.
 *  - `--quality final` and `--set` change only what this render reads, and exactly as storing
 *    the same values in the document would: the Render node `--quality final` must reach lives
 *    inside a component.
 *  - A Movie File In plays its own file through ffmpeg: frame by frame, from where the timeline
 *    is, round its loop, from its in point when it runs free; a movie on no drawn branch and one
 *    with no reachable file do not stop the render.
 *  - The command itself: a 16-bit PNG holding that value, and the project file untouched.
 *  - T1739b: the sub-frames are summed on the GPU, and that sum is the CPU average of every
 *    sub-frame's readback bit for bit, from one readback per output frame instead of one per
 *    sub-frame.
 *  - T1745b: a render is deterministic from its warm-up's first frame. E1 at 1 s, warmed by
 *    default because its plan holds a feedback pair, is frame 60 of a render from 0 and shows
 *    the ribbon; cold it shows the disc alone. A plan with no state is not warmed, and a
 *    free-running movie starts at the warm-up's first frame.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const sixteen = (linear: number): number => Math.round(linearToSrgb(linear) * 65_535);
const edge = (id: string, from: string, to: string, port = "input"): GraphDocument["edges"][string] => ({
  id,
  source: { nodeId: from, portId: "out" },
  target: { nodeId: to, portId: port },
});

let dawnError: string | undefined;
let dir = "";
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
  dir = mkdtempSync(join(tmpdir(), "loom-render-"));
}, 60_000);
afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});
const needDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
};

function projectText(graph: GraphDocument, settings: ProjectSettings, components: readonly GraphComponentDefinition[] = []): string {
  return buildProjectFile({ document: testDocument({ name: "render-test", graph, settings }), components, now: () => "2026-11-08T00:00:00.000Z" }).text;
}

interface Run {
  readonly output?: string;
  readonly fps: number;
  readonly spp: number;
  readonly first: number;
  readonly count: number;
  readonly warmup?: number;
  readonly averaging?: "gpu" | "cpu";
}

async function render(text: string, run: Run, options: PrepareOptions = {}): Promise<{ frames: OutputFrame[]; notes: string[]; outcome: RenderOutcome }> {
  const project = prepareProject(text, { path: join(dir, "render-test.loom.json"), ...options });
  const frames: OutputFrame[] = [];
  const notes: string[] = [];
  const outcome = await renderFrames({
    project,
    outputNodeId: outputNodeOf(project.document, run.output),
    fps: run.fps,
    spp: run.spp,
    first: run.first,
    count: run.count,
    ...(run.warmup === undefined ? {} : { warmup: run.warmup }),
    ...(run.averaging === undefined ? {} : { averaging: run.averaging }),
    onFrame: (frame) => {
      frames.push(frame);
    },
    onNote: (note) => notes.push(note),
  });
  return { frames, notes, outcome };
}

// --- a sawtooth over each output frame ------------------------------------------------------

/**
 * Output frames at 8 fps. Red ramps over one output frame: at 4 sub-frames it is exactly 0, 1/4,
 * 2/4, 3/4 (times k/32 are exact in f32). Green is the output frame's own number over 8.
 */
const SAW = `${SHARED_UNIFORMS_WGSL}
struct Params {
  gain: f32, // @default 1  Scales the ramp.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = frameU.time * 8.0;
  return vec4f(fract(t) * params.gain, floor(t) / 8.0, 0.0, 1.0);
}`;

function sawText(): string {
  const graph = graphOf(
    [
      node("seed", "solid", { color: [0, 0, 0, 1] }, { label: "solid_seed" }),
      node("fx", "customWgsl", { source: SAW, gain: 1 }, { label: "fx_saw" }),
      node("out", "output", {}, { label: "output_saw" }),
    ],
    { e1: edge("e1", "seed", "fx"), e2: edge("e2", "fx", "out") },
  );
  return projectText(graph, testSettings({ outputResolution: { width: 4, height: 4 }, fps: 8 }));
}

describe("--spp: a shutter in linear light, one per output frame (T1738b)", () => {
  it("averages each output frame's own four sub-frames: the ramp's linear mean, the frame's own level", async () => {
    needDawn();
    const { frames } = await render(sawText(), { output: "fx_saw", fps: 8, spp: 4, first: 2, count: 3 });
    // Red 0, 1/4, 2/4, 3/4 averages to 3/8 in light. Green is f/8 on all four sub-frames of frame
    // f; a group starting a sub-frame late would carry a quarter of frame f + 1's level.
    expect(frames.map((frame) => [frame.index, frame.rgba[0], frame.rgba[1], frame.rgba[3]])).toEqual(
      [2, 3, 4].map((index) => [index, sixteen(3 / 8), sixteen(index / 8), 65_535]),
    );
    // Not the mean of the display values, which averaging the readback as it comes would give.
    const displayMean = Math.round(((linearToSrgb(0) + linearToSrgb(0.25) + linearToSrgb(0.5) + linearToSrgb(0.75)) / 4) * 65_535);
    expect(frames[0]!.rgba[0]).not.toBe(displayMean);
  }, 120_000);

  it("without --spp an output frame is the instant it starts at", async () => {
    needDawn();
    const { frames } = await render(sawText(), { output: "fx_saw", fps: 8, spp: 1, first: 2, count: 1 });
    expect([frames[0]!.rgba[0], frames[0]!.rgba[1]]).toEqual([0, sixteen(2 / 8)]);
  }, 120_000);
});

// --- a Render node inside a component -------------------------------------------------------

/**
 * The V-groove of `scene-ao.gpu.test.ts`: a grid folded to z = |x| - 1, lit by ambient alone.
 * Its crease is what AO's taps resolve, and its silhouette against black is what SSAA resolves.
 */
const GROOVE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x, p.position.y, abs(p.position.x) - 1.0);
  return q;
}`;

function sceneText(antialias: string, aoQuality: string): string {
  const attributes = JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]);
  const definition: GraphComponentDefinition = {
    componentId: "grooveScene",
    version: 1,
    name: "GrooveScene",
    graph: graphOf(
      [
        node("grid", "pointGrid", { count: 4096, cols: 64, rows: 64, sizeX: 2, sizeY: 2 }, { label: "grid_groove" }),
        node("fold", "pointKernel", { capacity: 4096, seed: 7, attributes, kernel: GROOVE_KERNEL }, { label: "kernel_fold" }),
        node("geo", "geometry", { mode: "surface" }, { label: "geometry_groove" }),
        node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0], fov: 55, near: 0.1, far: 100 }, { label: "camera_groove" }),
        node("shot", "render", {
          scenes: "geometry_groove", camera: "camera_groove", lights: "", ambientColor: [1, 1, 1, 1], ambientIntensity: 1, background: [0, 0, 0, 1],
          ambientOcclusion: true, antialias, aoQuality,
        }, { label: "render_groove" }),
      ],
      { e1: edge("e1", "grid", "fold", "in"), e2: edge("e2", "fold", "geo", "points") },
    ),
    inputs: [],
    outputs: [{ externalId: "out", label: "Picture", nodeId: "shot", portId: "out" }],
    parameters: [],
  };
  const graph = graphOf(
    [{ ...instanceNode("scene", "grooveScene", 1), label: "groovescene_groove" }, node("out", "output", {}, { label: "output_scene" })],
    { e: edge("e", "scene", "out") },
  );
  return projectText(graph, testSettings({ outputResolution: { width: 64, height: 64 }, fps: 8 }), [definition]);
}

const differing = (a: OutputFrame, b: OutputFrame): number => a.rgba.reduce((count, value, index) => count + (value === b.rgba[index] ? 0 : 1), 0);
const ONE_FRAME: Run = { fps: 8, spp: 1, first: 0, count: 1 };

describe("--quality final reaches a Render node inside a component (T1738b, T1740b's stand-in)", () => {
  it("renders exactly what the document would with SSAA and high AO stored, and not the live picture", async () => {
    needDawn();
    const live = (await render(sceneText("none", "low"), ONE_FRAME)).frames[0]!;
    const final = (await render(sceneText("none", "low"), ONE_FRAME, { quality: "final" })).frames[0]!;
    const stored = (await render(sceneText("ssaa", "high"), ONE_FRAME)).frames[0]!;
    expect(live.rgba.some((value, index) => index % 4 === 0 && value > 30_000)).toBe(true); // the groove is there
    expect(differing(final, stored)).toBe(0);
    expect(differing(final, live)).toBeGreaterThan(0);
    // Each half shows on its own: SSAA with the live AO, and high AO without SSAA, both differ.
    const ssaaOnly = (await render(sceneText("ssaa", "low"), ONE_FRAME)).frames[0]!;
    const highOnly = (await render(sceneText("none", "high"), ONE_FRAME)).frames[0]!;
    expect(differing(final, ssaaOnly)).toBeGreaterThan(0);
    expect(differing(highOnly, live)).toBeGreaterThan(0);
  }, 240_000);
});

// --- Movie File In ----------------------------------------------------------------------------

const FED = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]];
const RED = FED[0]!;
const GREEN = FED[1]!;
const BLUE = FED[2]!;
const WHITE = FED[3]!;

/** A four-frame clip at 8 fps, 4 x 4, lossless RGBA: red, green, blue, white. */
function makeClip(): string {
  const path = join(dir, "clip.mov");
  const frames = Buffer.concat(FED.map((rgba) => Buffer.from(Array.from({ length: 16 }, () => rgba).flat())));
  const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "4x4", "-r", "8", "-i", "-", "-c:v", "png", "-pix_fmt", "rgba", path], { input: frames });
  if (made.error !== undefined || made.status !== 0) throw new Error(`ffmpeg could not make the test clip: ${made.error?.message ?? made.stderr.toString()}`);
  return path;
}

function movieText(file: string, playMode: "timeline" | "freeRun"): string {
  const graph = graphOf(
    [
      node("clip", "movieFileIn", { file, imageFit: "stretch", playMode, extend: "loop" }, {
        label: "movie_clip",
        resolution: { mode: "fixed", width: 4, height: 4 },
        format: { mode: "fixed", format: "rgba8unorm" },
      }),
      // A second player of the same file on a branch nothing draws: it has no texture in the plan.
      node("spare", "movieFileIn", { file }, { label: "movie_spare" }),
      node("out", "output", {}, { label: "output_clip" }),
    ],
    { e: edge("e", "clip", "out") },
  );
  return projectText(graph, testSettings({ outputResolution: { width: 4, height: 4 }, fps: 8 }));
}

const colourOf = (frame: OutputFrame): number[] => [...frame.rgba.subarray(0, 4)].map((value) => Math.round(value / 257));

describe("a Movie File In plays its own file, through ffmpeg (T1738b)", () => {
  let clip = "";
  beforeAll(() => {
    clip = makeClip();
  });
  const clipRun = (first: number, count: number): Run => ({ output: "movie_clip", fps: 8, spp: 1, first, count });

  it("locked to the timeline: each frame in turn, and round its loop", async () => {
    needDawn();
    const { frames } = await render(movieText(clip, "timeline"), clipRun(0, 6));
    expect(frames.map(colourOf)).toEqual([RED, GREEN, BLUE, WHITE, RED, GREEN]);
  }, 120_000);

  it("locked to the timeline: a render from 0.25 s starts where the timeline is", async () => {
    needDawn();
    const { frames } = await render(movieText(clip, "timeline"), clipRun(2, 2));
    expect(frames.map(colourOf)).toEqual([BLUE, WHITE]);
  }, 120_000);

  it("free run: starts at its in point on the render's first frame, and says so", async () => {
    needDawn();
    const { frames, notes } = await render(movieText(clip, "freeRun"), clipRun(2, 2));
    expect(frames.map(colourOf)).toEqual([RED, GREEN]);
    expect(notes.some((note) => note.includes(`"movie_clip" runs free`))).toBe(true);
  }, 120_000);

  it("free run with a warm-up: starts at its in point on the warm-up's first frame (T1745b)", async () => {
    needDawn();
    // One frame stepped unseen, from 0.125 s: the movie shows red there, so frame 2 is its
    // second frame. That run-up frame is numbered −1, and it must fetch a picture of its own.
    const { frames, notes, outcome } = await render(movieText(clip, "freeRun"), { ...clipRun(2, 2), warmup: 0.125 });
    expect(outcome.warmupFrames).toBe(1);
    expect(frames.map(colourOf)).toEqual([GREEN, BLUE]);
    // A run-up frame that uploaded no picture is a GPU validation error at frame −1, which
    // the frames after it would not show.
    expect(outcome.findings.filter((finding) => finding.diagnostic.severity === "error")).toEqual([]);
    expect(notes.some((note) => note.includes(`"movie_clip" runs free`) && note.includes("first stepped frame (0.125 s)"))).toBe(true);
  }, 120_000);

  it("a file this machine cannot reach keeps the test card and names why", async () => {
    needDawn();
    const { frames, notes } = await render(movieText("blob:http://localhost:5173/0d1e#clip.mov", "timeline"), clipRun(0, 1));
    expect(frames).toHaveLength(1);
    expect(notes.some((note) => note.includes(`"movie_clip"`) && note.includes("blob:"))).toBe(true);
  }, 120_000);
});

// --- T1739b: the sum on the GPU ----------------------------------------------------------------

const E1 = readFileSync(join(ROOT, "examples/E1-Feedback-Echo.loom.json"), "utf8");
/** E1's settings: 60 fps (the default), 1280 × 720. */
const E1_FPS = 60;
const E1_SIZE = [1280, 720] as const;

describe("--spp sums sub-frames on the GPU (T1739b)", () => {
  it("is the CPU average of every sub-frame's readback, bit for bit, from one readback per output frame", async () => {
    needDawn();
    // E1 moves a disc ~6 px a sub-frame over a feedback ribbon on a TRANSPARENT ground, so
    // every frame holds thousands of pixels whose alpha is neither 0 nor 1: the premultiplied
    // half of the sum is exercised, not only the colour.
    const run: Run = { fps: E1_FPS, spp: 4, first: 30, count: 2, warmup: 0 };
    const gpu = await render(E1, { ...run, averaging: "gpu" });
    const cpu = await render(E1, { ...run, averaging: "cpu" });
    expect([gpu.outcome.averaged, cpu.outcome.averaged]).toEqual(["gpu", "cpu"]);
    // What it is for: one readback serves the four sub-frames.
    expect([gpu.outcome.readbacks, cpu.outcome.readbacks]).toEqual([2, 8]);
    // §V147, TOLERANCE_EXACT's regime (one device): the tables are the CPU's own, colour times
    // an alpha of 1 is exact, and one f32 addition rounds the same on both sides.
    for (const index of [0, 1]) expect(differing(gpu.frames[index]!, cpu.frames[index]!)).toBe(0);
    const partial = (frame: OutputFrame): number => frame.rgba.filter((value, index) => index % 4 === 3 && value > 0 && value < 65_535).length;
    expect(partial(gpu.frames[0]!)).toBeGreaterThan(1_000);
    // And it is a shutter, not one sub-frame: the same frame with one sample differs.
    const single = await render(E1, { ...run, spp: 1, count: 1 });
    expect(differing(gpu.frames[0]!, single.frames[0]!)).toBeGreaterThan(0);
  }, 240_000);
});

// --- T1745b: the warm-up ------------------------------------------------------------------------

/** The pixel under E1's disc centre at `t` seconds: `lfo_pathx`/`lfo_pathy` (offset + amplitude · sin 2π(f·t + phase)), y down. */
function e1DiscAt(t: number): number {
  const x = 0.5 + 0.3 * Math.sin(2 * Math.PI * (0.31 * t));
  const y = 0.5 + 0.24 * Math.sin(2 * Math.PI * (0.23 * t + 0.25));
  return Math.floor(y * E1_SIZE[1]) * E1_SIZE[0] + Math.floor(x * E1_SIZE[0]);
}
const pixel = (frame: OutputFrame, at: number): number[] => [...frame.rgba.subarray(at * 4, at * 4 + 4)];

describe("a render is deterministic from its warm-up's first frame (T1745b)", () => {
  it("E1 at --at 1 is warmed from 0 s by default and shows its ribbon; cold it shows the disc alone", async () => {
    needDawn();
    const at1: Run = { fps: E1_FPS, spp: 1, first: E1_FPS, count: 1 };
    const warm = await render(E1, at1);
    const cold = await render(E1, { ...at1, warmup: 0 });
    const fromZero = await render(E1, { ...at1, first: 0, count: E1_FPS + 1, warmup: 0 });
    // Read off the plan: E1's one carrier is its Feedback's ping-pong pair.
    expect(warm.outcome.state).toEqual([`feedback "echo"`]);
    expect([warm.outcome.warmupFrames, cold.outcome.warmupFrames]).toEqual([E1_FPS, 0]);
    // The SPEC row's gate: the warmed frame at 1 s IS frame 60 of a render from 0.
    expect(differing(warm.frames[0]!, fromZero.frames[E1_FPS]!)).toBe(0);
    // Where the disc is at 1 s, both draw it whole and the same: the warm-up moved no time.
    const now = e1DiscAt(1);
    expect(pixel(cold.frames[0]!, now)[3]).toBe(65_535);
    expect(pixel(warm.frames[0]!, now)).toEqual(pixel(cold.frames[0]!, now));
    // Where it was a quarter second earlier (64 px away, past the disc's soft edge), the cold
    // frame holds nothing at all and the warm one holds the ribbon.
    const before = e1DiscAt(0.75);
    expect(pixel(cold.frames[0]!, before)).toEqual([0, 0, 0, 0]);
    expect(pixel(warm.frames[0]!, before)[3]).toBeGreaterThan(0);
    // The ribbon as a whole: pixels the cold frame leaves empty and the warm one lights, many
    // times the disc's own cover.
    const covered = (frame: OutputFrame): number => frame.rgba.filter((value, index) => index % 4 === 3 && value > 0).length;
    const ribbon = warm.frames[0]!.rgba.filter((value, index) => index % 4 === 3 && value > 0 && cold.frames[0]!.rgba[index] === 0).length;
    expect(ribbon).toBeGreaterThan(5 * covered(cold.frames[0]!));
    expect(warm.notes.some((note) => note.startsWith("warm-up: frames 0 to 59"))).toBe(true);
  }, 240_000);

  it("a plan with no state is not warmed, because its frame at T is the same either way", async () => {
    needDawn();
    const plain = await render(sawText(), { output: "fx_saw", fps: 8, spp: 1, first: 2, count: 1 });
    const warmed = await render(sawText(), { output: "fx_saw", fps: 8, spp: 1, first: 2, count: 1, warmup: 0.25 });
    expect([plain.outcome.state, plain.outcome.warmupFrames, warmed.outcome.warmupFrames]).toEqual([[], 0, 2]);
    expect(differing(plain.frames[0]!, warmed.frames[0]!)).toBe(0);
  }, 120_000);
});

// --- the command ------------------------------------------------------------------------------

/** Reads the 16-bit RGBA PNG `encodePng16` writes (rows filtered None or Up). */
function readPng16(bytes: Buffer): { width: number; height: number; rgba: Uint16Array } {
  let offset = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect([body[8], body[9]]).toEqual([16, 6]); // 16 bits, RGBA
    }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 8;
  const rgba = new Uint16Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start]!;
    expect([0, 2]).toContain(filter);
    const row = Uint8Array.from(raw.subarray(start + 1, start + 1 + stride));
    if (filter === 2) for (let x = 0; x < stride; x += 1) row[x] = (row[x]! + previous[x]!) & 0xff;
    for (let i = 0; i < width * 4; i += 1) rgba[y * width * 4 + i] = (row[i * 2]! << 8) | row[i * 2 + 1]!;
    previous = row;
  }
  return { width, height, rgba };
}

describe("pnpm render, the command (T1738b)", () => {
  it("writes the still --at, --spp and --set ask for as a 16-bit PNG, and does not touch the project", () => {
    needDawn();
    const project = join(dir, "saw.loom.json");
    writeFileSync(project, sawText());
    const before = readFileSync(project, "utf8");
    const png = join(dir, "saw.png");
    const run = spawnSync(
      process.execPath,
      ["--import", "./src/tooling/alias-hooks.ts", "src/tooling/render-project.ts", project, "--at", "0.5", "--spp", "4", "--output", "fx_saw", "--set", "fx_saw.gain=0.5", "--out", png],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const image = readPng16(readFileSync(png));
    expect([image.width, image.height]).toEqual([4, 4]);
    // 0.5 s at 8 fps is frame 4. Gain 0.5 halves the ramp: the linear mean of 0, 1/8, 2/8, 3/8 is 3/16.
    expect([...image.rgba.subarray(0, 4)]).toEqual([sixteen(3 / 16), sixteen(4 / 8), 0, 65_535]);
    expect(readFileSync(project, "utf8")).toBe(before);
  }, 120_000);
});
