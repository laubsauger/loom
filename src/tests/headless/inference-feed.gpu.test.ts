import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../../runtime/export/image.ts";
import {
  registerInferenceSources,
  registerSyntheticMediaSources,
  renderHeadless,
  syntheticInferenceFrame,
} from "./render-harness.ts";
import { inferenceStandIn } from "../fixtures/inference-stand-in.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";

/**
 * THE INFERENCE FEED, on real hardware (T715/T384).
 *
 * This file's own history is five reader-that-cannot-see rows — T630 (compiler warnings
 * unreturned), T633 (the oracle with no channel resolver), T650 (no media sources), T655
 * (no analyze wiring), T661 (no pointer feed). Every one was a harness rendering plausible
 * pixels while an input sat silently inert, and every one passed its gates for months.
 *
 * All five are closed. This suite exists so inference does not open a sixth, and it is
 * deliberately written as the test those five did NOT have: it asserts that the fed value
 * REACHES THE PIXELS, not merely that a render happened. §V461 applies hard — the broken
 * state would pass everything weaker.
 */

const SIZE = 64;

const SETTINGS = {
  outputResolution: { width: SIZE, height: SIZE },
  // Linear 8-bit would crush the low levels these assertions read back.
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65_535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

function edge(id: string, from: [string, string], to: [string, string]) {
  return { id, source: { nodeId: from[0], portId: from[1] }, target: { nodeId: to[0], portId: to[1] } };
}

/** Noise -> inference -> Output. The inference result IS the picture. */
function inferenceGraph(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      noise: node("noise", "noise", { type: "simplex2d", period: 0.2 }),
      depth: node("depth", "inferenceStandIn"),
      out: node("out", "output"),
    },
    edges: {
      e1: edge("e1", ["noise", "out"], ["depth", "input"]),
      e2: edge("e2", ["depth", "out"], ["out", "input"]),
    },
    groups: {},
  } as never;
}

/** A flat result of one level, so a test can say exactly what the picture should become. */
function flatResult(level: number): Uint8Array {
  const bytes = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    bytes[i * 4] = level;
    bytes[i * 4 + 1] = level;
    bytes[i * 4 + 2] = level;
    bytes[i * 4 + 3] = 255;
  }
  return bytes;
}

async function captured(
  request: {
    graph?: GraphDocument;
    inference?: (nodeId: string, frameIndex: number) => Uint8Array | null;
    frames?: number;
    capture?: number[];
  } = {},
) {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: request.graph ?? inferenceGraph(),
    settings: SETTINGS,
    nodes: [inferenceStandIn],
    frames: request.frames ?? 2,
    capture: request.capture ?? [0, 1],
    ...(request.inference === undefined ? {} : { inference: request.inference }),
  } as never);
  const space = result.plan.outputs.find((o) => o.resourceId === result.outputResourceId)?.space ?? "display";
  return {
    diagnostics: result.diagnostics,
    frames: result.frames.map((frame) =>
      toRgba8(
        {
          width: frame.width,
          height: frame.height,
          format: frame.format,
          rowStride: frame.bytes.length / frame.height,
          bytes: frame.bytes,
        } as never,
        { space } as never,
      ).data,
    ),
  };
}

function meanLuma(rgba: Uint8Array | Uint8ClampedArray): number {
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4) total += rgba[i] ?? 0;
  return total / (rgba.length / 4);
}

describe("an inference node is not inert offline", () => {
  /**
   * THE REGRESSION GUARD. An unfed external texture keeps its contents — black — so
   * without a default stand-in a depth node would render nothing, silently, and every
   * example gate over a document containing one would measure a blank and report green.
   * That is the exact shape of all five rows above.
   */
  it("renders a varied, non-blank picture with no feed supplied at all", async () => {
    if (dawnError !== undefined) return;
    const { frames } = await captured();

    expect(meanLuma(frames[0]!)).toBeGreaterThan(0);
    // Not merely non-black: a flat field would pass that too. The stand-in is banded, so
    // the picture must carry real variation.
    const distinct = new Set<number>();
    for (let i = 0; i < frames[0]!.length; i += 4) distinct.add(frames[0]![i] ?? 0);
    expect(distinct.size).toBeGreaterThan(2);
  });

  it("reports no errors for a document containing an inference node", async () => {
    if (dawnError !== undefined) return;
    const { diagnostics } = await captured();
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("a fed result reaches the pixels", () => {
  /**
   * The assertion the five silent seams lacked. If the feed were ignored, the render
   * would still succeed and still look plausible — so feed two DIFFERENT results and
   * require the pictures to differ.
   */
  it("renders differently for two different fed results", async () => {
    if (dawnError !== undefined) return;
    const dark = await captured({ inference: () => flatResult(20), frames: 1, capture: [0] });
    const bright = await captured({ inference: () => flatResult(220), frames: 1, capture: [0] });

    const darkMean = meanLuma(dark.frames[0]!);
    const brightMean = meanLuma(bright.frames[0]!);

    expect(brightMean).toBeGreaterThan(darkMean);
    // A feed that is actually read moves the picture a lot, not by a rounding error.
    expect(brightMean - darkMean).toBeGreaterThan(50);
  });

  it("gives each node its own result rather than one shared blob", async () => {
    if (dawnError !== undefined) return;
    // Two inference nodes over one source, fed opposite values, differenced. If the feed
    // keyed on anything but the node, both would match and the difference would be black.
    const graph = {
      revision: 1,
      nodes: {
        noise: node("noise", "noise", { type: "simplex2d", period: 0.2 }),
        a: node("a", "inferenceStandIn"),
        b: node("b", "inferenceStandIn"),
        mix: node("mix", "difference"),
        out: node("out", "output"),
      },
      edges: {
        e1: edge("e1", ["noise", "out"], ["a", "input"]),
        e2: edge("e2", ["noise", "out"], ["b", "input"]),
        e3: edge("e3", ["a", "out"], ["mix", "in1"]),
        e4: edge("e4", ["b", "out"], ["mix", "in2"]),
        e5: edge("e5", ["mix", "out"], ["out", "input"]),
      },
      groups: {},
    } as never as GraphDocument;

    const { frames } = await captured({
      graph,
      frames: 1,
      capture: [0],
      inference: (nodeId) => flatResult(nodeId === "a" ? 240 : 10),
    });

    expect(meanLuma(frames[0]!)).toBeGreaterThan(30);
  });
});

describe("replay is deterministic", () => {
  /**
   * The reason gates replay a RESULT instead of running a model: different backends give
   * different numbers for the same input, so inference output is not byte-comparable
   * across machines. A recorded result is, and this is the assertion that buys it.
   */
  it("renders byte-identical frames across two independent runs", async () => {
    if (dawnError !== undefined) return;
    const feed = (nodeId: string, frameIndex: number) =>
      syntheticInferenceFrame(`infer:${nodeId}`, [SIZE, SIZE], frameIndex);

    const first = await captured({ inference: feed });
    const second = await captured({ inference: feed });

    expect(first.frames.length).toBe(2);
    for (let i = 0; i < first.frames.length; i += 1) {
      expect([...second.frames[i]!]).toEqual([...first.frames[i]!]);
    }
  });

  it("advances with the frame, so a take is not a still", async () => {
    if (dawnError !== undefined) return;
    // The default stand-in drifts one band per frame. Sampled once and cached, or keyed on
    // the wrong index, these two frames would be identical — which is precisely how
    // E12-Fluid rendered a still fluid and passed every gate (T661).
    const { frames } = await captured();
    expect([...frames[1]!]).not.toEqual([...frames[0]!]);
  });
});

describe("the media test card does not claim the inference namespace", () => {
  /**
   * §V665, gated DIRECTLY rather than through pixels — and the first version of this test
   * was decorative, which is worth recording because it is the exact failure §V666 names.
   *
   * `registerSyntheticMediaSources` fakes the whole `media:` prefix, and before T715 it
   * registered a card for EVERY external texture whatever its sourceId, so an inference
   * result would have rendered DIAGONAL MAGENTA-AND-CYAN BARS in every Dawn gate. But a
   * PIXEL test cannot see that bug: `registerMediaSource` replaces on re-register and the
   * inference feed runs second, so the overwrite hides it and the test passes either way.
   * Reverting the prefix guard left a pixel-level version of this suite fully green.
   *
   * So the boundary is asserted where it actually lives — in WHICH SOURCE IDS EACH FEED
   * CLAIMS — with a fake backend that records them. When a harness fakes a whole prefix,
   * the prefix is an interface, and an interface is gated by its own shape.
   */
  const plan = {
    resources: [
      { kind: "externalTexture", id: "r1", sourceId: "media:cam", size: [8, 8] },
      { kind: "externalTexture", id: "r2", sourceId: "infer:depth", size: [8, 8] },
      { kind: "buffer", id: "r3" },
    ],
  } as never;
  const graph = { nodes: { cam: { type: "webcam" }, depth: { type: "inferenceStandIn" } } } as never;

  function claimsOf(register: (backend: never, ...rest: never[]) => void, ...rest: unknown[]): string[] {
    const claimed: string[] = [];
    const backend = {
      registerMediaSource: (sourceId: string) => {
        claimed.push(sourceId);
        return () => {};
      },
    };
    (register as unknown as (...args: unknown[]) => void)(backend, plan, ...rest);
    return claimed;
  }

  it("leaves every infer: texture to the inference feed", () => {
    const claimed = claimsOf(registerSyntheticMediaSources as never, graph, () => 0);
    expect(claimed).toEqual(["media:cam"]);
    expect(claimed).not.toContain("infer:depth");
  });

  it("leaves every media: texture to the media feed", () => {
    const claimed = claimsOf(registerInferenceSources as never, () => 0, undefined);
    expect(claimed).toEqual(["infer:depth"]);
    expect(claimed).not.toContain("media:cam");
  });
});

describe("the shipped Depth node renders offline", () => {
  /**
   * The stand-in above proves the SEAM; this proves the NODE the owner can actually place.
   * It uses no `nodes` extension because `depth` is in the catalogue, and no model because
   * a gate replays a result — which is the whole reason the feed exists.
   */
  const depthGraph = {
    revision: 1,
    nodes: {
      noise: node("noise", "noise", { type: "simplex2d", period: 0.2 }),
      depth: node("depth", "depth"),
      out: node("out", "output"),
    },
    edges: {
      e1: edge("e1", ["noise", "out"], ["depth", "input"]),
      e2: edge("e2", ["depth", "out"], ["out", "input"]),
    },
    groups: {},
  } as never as GraphDocument;

  it("compiles and draws the fed result rather than black", async () => {
    if (dawnError !== undefined) return;
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: depthGraph,
      settings: SETTINGS,
      frames: 1,
      capture: [0],
      inference: () => flatResult(200),
    } as never);

    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const space = result.plan.outputs.find((o) => o.resourceId === result.outputResourceId)?.space ?? "display";
    const rgba = toRgba8(
      {
        width: result.frames[0]!.width,
        height: result.frames[0]!.height,
        format: result.frames[0]!.format,
        rowStride: result.frames[0]!.bytes.length / result.frames[0]!.height,
        bytes: result.frames[0]!.bytes,
      } as never,
      { space } as never,
    ).data;
    expect(meanLuma(rgba)).toBeGreaterThan(120);
  });

  it("PRUNES an unwired Depth node, so placing one downloads nothing", async () => {
    if (dawnError !== undefined) return;
    // §V585, on the shipped node: a Depth dropped on the canvas and left unconnected must
    // declare no resources at all — which is what makes "placing it costs nothing" true
    // rather than merely intended, because the app hook tracks only allocated nodes.
    const withOrphan = {
      ...depthGraph,
      nodes: { ...depthGraph.nodes, lonely: node("lonely", "depth") },
    } as never as GraphDocument;

    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: withOrphan,
      settings: SETTINGS,
      frames: 1,
      capture: [0],
      inference: () => flatResult(200),
    } as never);

    const orphanResources = result.plan.resources.filter((r) => r.id.includes("lonely"));
    expect(orphanResources).toEqual([]);
  });
});

describe("the shipped Pose node renders offline", () => {
  /**
   * Pose's result texture is rgba16float at 17x1 — EIGHT bytes per texel, where depth's
   * is four. The harness stand-in emits four, so this is the gate that catches a feed
   * whose byte count silently disagrees with the format it is filling.
   */
  const poseGraph = {
    revision: 1,
    nodes: {
      cam: node("cam", "noise", { type: "simplex2d", period: 0.2 }),
      pose: node("pose", "pose"),
      out: node("out", "output"),
    },
    edges: {
      e1: edge("e1", ["cam", "out"], ["pose", "input"]),
      e2: edge("e2", ["pose", "out"], ["out", "input"]),
    },
    groups: {},
  } as never as GraphDocument;

  it("does not break on the DEFAULT stand-in, whose bytes are sized for rgba8", async () => {
    if (dawnError !== undefined) return;
    // No `inference` feed, so every infer: texture gets the synthetic banded ramp — which
    // is written at four bytes per texel. Pose's is eight. If the upload path cannot cope,
    // this is where it says so rather than in a silent black frame months from now.
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: poseGraph,
      settings: SETTINGS,
      frames: 1,
      capture: [0],
    } as never);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("compiles and renders a pose document without error", async () => {
    if (dawnError !== undefined) return;
    const keypoints = new Uint8Array(17 * 8);
    const view = new DataView(keypoints.buffer);
    for (let i = 0; i < 17; i += 1) {
      view.setUint16(i * 8, 0x3800, true); // x = 0.5 in half float
      view.setUint16(i * 8 + 2, 0x3800, true); // y = 0.5
      view.setUint16(i * 8 + 4, 0x3c00, true); // confidence = 1
      view.setUint16(i * 8 + 6, 0x3c00, true); // alpha = 1
    }
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: poseGraph,
      settings: SETTINGS,
      frames: 1,
      capture: [0],
      inference: () => keypoints,
    } as never);

    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
