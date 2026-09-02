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

/**
 * A flat result for the SHIPPED Depth node, whose result texture is `r32float` (T959).
 *
 * Separate from `flatResult` below, and the split is the bug this file was carrying: the
 * shipped node's external texture stopped being RGBA bytes when T959 made it float, and
 * the byte fixture kept being fed to it. 200,200,200,255 read as one float32 is a
 * denormal — effectively zero — so the gate asserted a bright picture, got black, and
 * said "expected 0 to be greater than 120" without ever naming the format. The stand-in
 * node is still 8-bit, so it keeps the byte fixture; a fixture shared between two nodes
 * with different formats is one that must disagree with one of them.
 */
function flatDepthResult(level: number): Uint8Array {
  const floats = new Float32Array(SIZE * SIZE).fill(level);
  return new Uint8Array(floats.buffer);
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
      inference: () => flatDepthResult(0.8),
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

  /**
   * T965 — THE OUTPUT PARAMETERS, ON REAL HARDWARE, BY EXACT VALUE.
   *
   * "Near Is Bright" and "Output Range" are uniform writes on the blit pass, which is the
   * only reason they can be dialled at all — done in the worker's encoder they would cost
   * a re-run of a multi-second model per drag. A uniform that is DECLARED and never bound
   * reads as zero and produces a plausible picture, so this feeds ONE known depth and
   * asserts the exact luma each setting must produce rather than "it changed".
   */
  /** Renders the shipped node with one flat fed depth, and reports the mean output byte. */
  const drawDepth = async (parameters: GraphNode["parameters"], level: number) => {
    const graph = {
      ...depthGraph,
      nodes: { ...depthGraph.nodes, depth: node("depth", "depth", parameters) },
    } as never as GraphDocument;
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph,
      settings: SETTINGS,
      frames: 1,
      capture: [0],
      inference: () => flatDepthResult(level),
    } as never);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const space = result.plan.outputs.find((o) => o.resourceId === result.outputResourceId)?.space ?? "display";
    const frame = result.frames[0]!;
    const rgba = toRgba8(
      {
        width: frame.width,
        height: frame.height,
        format: frame.format,
        rowStride: frame.bytes.length / frame.height,
        bytes: frame.bytes,
      } as never,
      { space } as never,
    ).data;
    return { mean: meanLuma(rgba), space: space as string };
  };

  /**
   * The byte a given LINEAR value must land on once the output has been encoded.
   *
   * Computed rather than pasted, because the assertion has to survive the output space
   * being either: a hard-coded 231 would silently start measuring the transfer function
   * instead of the parameter the moment the working format changed.
   */
  const expectedByte = (linear: number, space: string): number => {
    // `transferForSpace` (image.ts): every declared space but `data` is srgb-encoded on
    // the way to bytes, so the exception is the one to test for, not the rule.
    const encoded =
      space === "data"
        ? linear
        : linear <= 0.0031308
          ? 12.92 * linear
          : 1.055 * linear ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  };

  it("publishes near-bright by default and FAR-bright when the flag is off", async () => {
    if (dawnError !== undefined) return;
    // The model emits INVERSE depth, so 0.8 is CLOSE. Default publishes it as 0.8; with
    // the flag off it must publish 1 - 0.8 and nothing in between.
    const near = await drawDepth({}, 0.8);
    const far = await drawDepth({ nearIsBright: false }, 0.8);
    expect(near.mean).toBeCloseTo(expectedByte(0.8, near.space), -0.5);
    expect(far.mean).toBeCloseTo(expectedByte(0.2, far.space), -0.5);
  });

  it("stretches the published map into the Output Range, exactly", async () => {
    if (dawnError !== undefined) return;
    // 0.8 remapped into [0.25, 0.75] is 0.25 + 0.8 * 0.5 = 0.65, and nothing else.
    const remapped = await drawDepth({ outputRange: [0.25, 0.75] }, 0.8);
    expect(remapped.mean).toBeCloseTo(expectedByte(0.65, remapped.space), -0.5);
    // A collapsed range publishes ONE value whatever the model said — the identity a
    // Displace reads as no displacement, reachable as a setting rather than only as the
    // accident of having no model.
    const flat = await drawDepth({ outputRange: [0.5, 0.5] }, 0.8);
    expect(flat.mean).toBeCloseTo(expectedByte(0.5, flat.space), -0.5);
  });

  it("sizes the model input buffer from the Input Size parameter (§V5 rebuild)", async () => {
    if (dawnError !== undefined) return;
    // The knob is structural — the scratch buffer and its dispatch are sized from it — so
    // it must reach the PLAN, not just the schema. 266 = 19 patches of 14.
    const smaller = {
      ...depthGraph,
      nodes: { ...depthGraph.nodes, depth: node("depth", "depth", { inputSide: "266" }) },
    } as never as GraphDocument;
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: smaller,
      settings: SETTINGS,
      frames: 1,
      capture: [0],
      inference: () => flatDepthResult(0.8),
    } as never);
    const buffer = result.plan.resources.find(
      (r) => r.id.includes("depth") && r.id.includes("modelInput"),
    ) as { capacity?: number } | undefined;
    expect(buffer?.capacity).toBe(266 * 266);
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
      inference: () => flatDepthResult(0.8),
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
