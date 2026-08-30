import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";

/**
 * SUBSTEPS on a real device (T387, §V147).
 *
 * ## Why this test exists in this shape
 *
 * A substep loop that is silently not looping renders a perfectly plausible picture. So
 * does one that loops but re-reads its own first iteration because the ping-pong halves
 * never moved under the bindings. Neither crashes, neither goes black, and neither is
 * visible in the plan — which is precisely the class §V147 and B15 are about ("no test
 * asserted the picture MOVES").
 *
 * The claim is therefore stated as an EQUATION the device can only satisfy by actually
 * iterating: **F frames at S substeps is the same picture as F*S frames at one substep,
 * to the byte.** A loop that does not loop fails it. A loop that loops without swapping
 * fails it. A loop that runs the wrong passes fails it. And an off-by-one in the iteration
 * count fails it by exactly one step, which is the assertion a "looks like it moved" test
 * can never make.
 *
 * The kernel is deliberately a COUNTER — one 1/255 step of red per iteration, in
 * rgba8unorm — so the expected value is an exact integer rather than a tolerance. The
 * reaction-diffusion this feature was built for gets its own coverage in
 * `src/examples/examples.gpu.test.ts`, on the shipped E2.
 */

const SIZE = 32;

const settings: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  // 8-bit unorm: the readback bytes ARE the target's contents, so an assertion about the
  // 12th iteration is an assertion about a number, not about a half-float decode.
  workingFormat: "rgba8unorm",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 64,
  previewFps: 30,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

/**
 * One iteration adds exactly one 8-bit step of red and leaves everything else alone.
 *
 * `textureLoad` rather than a sampled fetch on purpose: filtering would make the value a
 * function of the sampler's rounding as well as the arithmetic, and the whole point of
 * this fixture is that after N iterations the red channel is N.
 */
const COUNTER_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let texel = vec2i(clamp(uv * size, vec2f(0.0), size - vec2f(1.0)));
  let previous = textureLoad(inputTexture, texel, 0);
  return vec4f(previous.r + (1.0 / 255.0), 0.0, 0.0, 1.0);
}`;

function counterGraph(substeps: number): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      state: {
        id: "state",
        type: "feedback",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        // A cycle has nowhere to inherit size or format FROM (§V50/§V51), so it is pinned
        // here exactly as E2 pins its own.
        resolution: { mode: "fixed", width: SIZE, height: SIZE },
        format: { mode: "fixed", format: "rgba8unorm" },
        parameters: { source: "kernel1", persistence: 1, clearColor: [0, 0, 0, 0], substeps },
      },
      kernel: {
        id: "kernel",
        type: "customWgsl",
        label: "kernel1",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: { source: COUNTER_WGSL },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      "e-state-kernel": {
        id: "e-state-kernel",
        source: { nodeId: "state", portId: "out" },
        target: { nodeId: "kernel", portId: "input" },
      },
      "e-kernel-out": {
        id: "e-kernel-out",
        source: { nodeId: "kernel", portId: "out" },
        target: { nodeId: "out", portId: "input" },
      },
    },
  } as GraphDocument;
}

/** The red byte every pixel of the frame holds. Throws if the frame is not uniform. */
function redOf(bytes: Uint8Array): number {
  const first = bytes[0] ?? -1;
  for (let index = 0; index < bytes.length; index += 4) {
    if (bytes[index] !== first) {
      throw new Error(`frame is not uniform: byte ${index} is ${String(bytes[index])}, expected ${first}`);
    }
  }
  return first;
}

async function redAfter(frames: number, substeps: number): Promise<number> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: counterGraph(substeps),
    settings,
    frames,
    capture: [frames - 1],
    outputNodeId: "out",
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  return redOf(frame.bytes);
}

let dawnError: string | undefined;

beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("substeps advance the simulation N times per displayed frame (T387, §V147)", () => {
  it("runs exactly `substeps` iterations per frame — 4 frames at 3 substeps == 12 frames at 1", async () => {
    // Dawn is required, not optional. A skip here would turn the only test that can see
    // "the loop silently did not loop" into a green tick on a machine with no GPU.
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    // The BASELINE, and the reason the whole feature exists: one iteration per displayed
    // frame is all a graph could ever get before this.
    expect(await redAfter(4, 1)).toBe(4);

    // The claim. Same four displayed frames, three iterations each.
    expect(await redAfter(4, 3)).toBe(12);

    // …and it is the SAME picture as running the single-step graph for twelve frames,
    // which is what makes "substeps change the rate" a statement about the simulation
    // rather than about the number of passes encoded.
    expect(await redAfter(12, 1)).toBe(12);

    // One more rung, to pin the multiplication rather than one lucky pair.
    expect(await redAfter(3, 8)).toBe(24);
    expect(await redAfter(24, 1)).toBe(24);
  }, 120_000);

  it("moves BETWEEN frames, and moves `substeps` times faster (B15: the picture must change)", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const slow = await renderHeadless({
      host: nodeGpuHost(),
      graph: counterGraph(1),
      settings,
      frames: 6,
      capture: [1, 5],
      outputNodeId: "out",
    });
    const fast = await renderHeadless({
      host: nodeGpuHost(),
      graph: counterGraph(5),
      settings,
      frames: 6,
      capture: [1, 5],
      outputNodeId: "out",
    });

    const slowFrames = slow.frames.map((frame) => redOf(frame.bytes));
    const fastFrames = fast.frames.map((frame) => redOf(frame.bytes));

    // It moves at all: four steps of red between displayed frame 1 and displayed frame 5.
    expect(slowFrames).toEqual([2, 6]);
    // And exactly five times as far in the same wall-clock frames. THIS is what "too slow"
    // meant, expressed as a number.
    expect(fastFrames).toEqual([10, 30]);
    expect(fastFrames[1]! - fastFrames[0]!).toBe(5 * (slowFrames[1]! - slowFrames[0]!));
  }, 120_000);

  it("replays identically — a substep count is part of what makes a seek reproducible (§V170)", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    // §V170: a backward seek replays from frame zero, so "the same frame index is the same
    // picture" is the property the substep count must not break. Two independent runs of
    // the same document to the same frame, byte for byte.
    const once = await renderHeadless({
      host: nodeGpuHost(),
      graph: counterGraph(7),
      settings,
      frames: 5,
      capture: [4],
      outputNodeId: "out",
    });
    const again = await renderHeadless({
      host: nodeGpuHost(),
      graph: counterGraph(7),
      settings,
      frames: 5,
      capture: [4],
      outputNodeId: "out",
    });
    expect(redOf(once.frames[0]!.bytes)).toBe(35);
    expect([...again.frames[0]!.bytes]).toEqual([...once.frames[0]!.bytes]);
  }, 120_000);

  it("the count is a LIVE value: changed mid-run through updateUniforms, no recompile (T425)", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    // A per-frame count that silently pinned to its first value would pass every static
    // rung above; only a mid-run change can see it. 4 frames at 1 + 4 frames at 3 = 16
    // iterations, on ONE compiled plan.
    const { compileGraph } = await import("../../../compiler/index.ts");
    const { createNodeRegistry } = await import("../../../nodes/registry/registry.ts");
    const { allNodeDefinitions } = await import("../../../nodes/definitions/index.ts");
    const plan = compileGraph({
      graph: counterGraph(1),
      settings,
      registry: createNodeRegistry(allNodeDefinitions).view(),
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      } as never,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const loopBegin = plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin");
    expect(loopBegin).toBeDefined();

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      const renderFrame = (frameIndex: number): void =>
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [SIZE, SIZE],
        });
      for (let frame = 0; frame < 4; frame += 1) renderFrame(frame);
      // The animator's exact spelling of the push: the loop-begin pass, a count value.
      backend.updateUniforms({ passId: (loopBegin as { id: string }).id, values: { count: 3 } });
      for (let frame = 4; frame < 8; frame += 1) renderFrame(frame);
      const image = await backend.readOutput("target:kernel:out");
      expect(redOf(image.bytes)).toBe(4 * 1 + 4 * 3);
    } finally {
      backend.dispose();
    }
  }, 120_000);

});
