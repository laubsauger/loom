import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS, type GraphDocument } from "../../domain/types/graph.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { pixelAt } from "./pixel-compare.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T1737b — A PRE-RENDERED CLIP PLAYS ON A SURFACE IN ONE OFFLINE RENDER, on a real GPU.
 *
 * The harness fed a Movie File In one still (`pictures`, uploaded once and held), so putting a
 * clip on the perfumery pillar meant one whole render per frame: about 2–3 s each, an hour for a
 * 42 s walkthrough. `movies` asks for the frame being stepped and advances the media frameId with
 * it, so the backend uploads every frame. The claim is about pixels: three frames fed red, green
 * and blue come out red, green and blue, and the same feed given as a still holds its first frame,
 * which is what the clip looked like before this row.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const SIZE = 16;
const FED = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]] as const;
const graph: GraphDocument = {
  revision: 1,
  groups: {},
  nodes: {
    movie_clip: {
      id: "movie_clip", label: "movie_clip", type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 },
      parameters: { imageFit: "fill" },
      resolution: { mode: "fixed", width: SIZE, height: SIZE }, format: { mode: "fixed", format: "rgba8unorm" },
    },
    out: { id: "out", label: "output_clip", type: "output", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {} },
  },
  edges: { e: { id: "e", source: { nodeId: "movie_clip", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
};
const solid = (size: readonly [number, number], rgba: readonly number[]): Uint8Array => {
  const bytes = new Uint8Array(size[0] * size[1] * 4);
  for (let i = 0; i < bytes.length; i += 4) bytes.set(rgba, i);
  return bytes;
};
const render = (feed: "movies" | "pictures") =>
  renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width: SIZE, height: SIZE } },
    frames: FED.length,
    capture: FED.map((_, index) => index),
    fps: 30,
    outputNodeId: "out",
    ...(feed === "movies"
      ? { movies: { movie_clip: (size: readonly [number, number], frame: number) => solid(size, FED[frame]!) } }
      : { pictures: { movie_clip: (size: readonly [number, number]) => solid(size, FED[0]) } }),
  });
const middle = (frame: Awaited<ReturnType<typeof render>>["frames"][number]) =>
  pixelAt(frame, SIZE >> 1, SIZE >> 1).map((value) => Math.round(value * 255));

describe("movies: a fed clip advances frame by frame (T1737b)", () => {
  it("shows each fed frame in its own rendered frame", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const result = await render("movies");
    expect(result.frames.map(middle)).toEqual(FED.map((rgba) => [...rgba]));
  }, 60_000);

  it("a still in `pictures` holds its first frame, which is why a clip needed one render per frame", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const result = await render("pictures");
    expect(result.frames.map(middle)).toEqual(FED.map(() => [...FED[0]]));
  }, 60_000);
});
