import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { FrameEvaluationInput } from "../../../domain/types/frame.ts";

/**
 * B97 / T489 on a REAL device: a POINT KERNEL reads the clock that does not reset.
 *
 * This is the bug as the owner met it, in their own file. `pointkernel1` in
 * `clanker.loom.json` animates off `ctx.time`; the timeline is bounded, so every lap put
 * `ctx.time` back to zero and the whole population SNAPPED — while the feedback and the lag
 * downstream survived correctly and carried the discontinuity forward, which is what made
 * it look like a feedback bug rather than a clock bug.
 *
 * §V147 is why the assertions are exact numbers rather than "it moved": the frame below is
 * MID-LAP — timeline at zero, the show 100 seconds old — so a kernel on the lap clock
 * writes 0 and a kernel on the absolute clock writes 100. Those two are not near each other
 * and no tolerance band is involved. §V220: nothing here hands the kernel a number; the
 * value travels transport → shared block → `dispatchFrameUniforms` → the generated
 * `KernelFrame` → `PointCtx` → a storage buffer this test reads back.
 *
 * The last case is §V309's, at the seam where it costs something: a kernel that never names
 * the pair must emit neither the struct member nor the uniform entry. vgpu matches uniforms
 * by NAME, so a member nobody writes reads zero forever (a stopped clock, which looks like a
 * paused picture) and a value nobody declares is dropped without a word.
 */

const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "probe", type: "vec4f", default: [0, 0, 0, 0] },
]);

/**
 * Both clocks side by side, so one run distinguishes all four ways this can be wrong:
 * absolute missing (x = 0), absolute aliased to the timeline (x = y), the frame count
 * missing (z = 0), and the whole block unwritten (all zero).
 */
const CLOCK_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.probe = vec4f(ctx.absTime, ctx.time, f32(ctx.absFrame), f32(ctx.frameIndex));
  return q;
}`;

/** The same kernel with the absolute pair removed — §V309's control. */
const LAP_ONLY_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.probe = vec4f(ctx.time, 0.0, 0.0, 1.0);
  return q;
}`;

const SETTINGS = {
  outputResolution: { width: 16, height: 16 },
  workingFormat: "rgba8unorm" as const,
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const CAPABILITIES = {
  tier: "B" as const,
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"] as const,
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/**
 * MID-LAP. The timeline has just wrapped to the in point; the session is 100 seconds and
 * 6000 frames old. This is the exact moment the owner's picture jumped.
 */
const MID_LAP: FrameEvaluationInput = {
  timeSeconds: 0,
  deltaSeconds: 1 / 60,
  frameIndex: 0,
  mode: "realtime",
  randomSeed: 7,
  absFrameIndex: 6000,
  absTimeSeconds: 100,
};

function graphWith(kernel: string) {
  return {
    revision: 1,
    nodes: {
      sim: {
        id: "sim",
        type: "pointKernel",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "kernel1",
        parameters: { capacity: 8, seed: 7, kernel, attributes: ATTRIBUTES },
      },
      sprites: {
        id: "sprites",
        type: "renderPoints",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { count: 8, sizePixels: 2 },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "sprites", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "sprites", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

function planFor(kernel: string) {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({
    graph: graphWith(kernel) as never,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES as never,
  });
  expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  return plan;
}

/** One frame through the real backend; returns the four floats the kernel wrote. */
async function probeAt(frame: FrameEvaluationInput): Promise<readonly number[]> {
  const plan = planFor(CLOCK_KERNEL);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const errors: string[] = [];
  backend.onDiagnostic((diagnostic) => {
    if (diagnostic.severity === "error") errors.push(`${diagnostic.code}: ${diagnostic.message}`);
  });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, { frame, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [16, 16] });
    expect(errors).toEqual([]);
    const probe = new Float32Array(await backend.readBuffer("scratch:sim:probe"));
    return [probe[0] as number, probe[1] as number, probe[2] as number, probe[3] as number];
  } finally {
    backend.dispose();
  }
}

describe("ctx.absTime on Dawn — the point kernel's clock that does not reset (B97)", () => {
  it("mid-lap, the kernel sees 100 seconds of absolute time and 0 of timeline time", async () => {
    const dawn = await probeDawn();
    if (!dawn.available) throw new Error(`Dawn unavailable: ${dawn.error}`);

    const [absTime, time, absFrame, frameIndex] = await probeAt(MID_LAP);
    // The whole bug in four numbers. Before T489 the first two were both 0 and the author
    // had no way to write the first one at all.
    expect(absTime).toBe(100);
    expect(time).toBe(0);
    expect(absFrame).toBe(6000);
    expect(frameIndex).toBe(0);
  }, 60_000);

  it("KEEPS GROWING: the frame after the lap reads higher than the frame before it", async () => {
    const dawn = await probeDawn();
    if (!dawn.available) throw new Error(`Dawn unavailable: ${dawn.error}`);

    const before = await probeAt({
      ...MID_LAP,
      timeSeconds: 9,
      frameIndex: 540,
      absFrameIndex: 5999,
      absTimeSeconds: 99.98333740234375, // exactly representable in f32
    });
    const after = await probeAt(MID_LAP);

    // Timeline: 9s → 0s, the lap. Absolute: 99.98s → 100s, straight through it. This is
    // the property, measured on the device rather than argued from the source.
    expect(after[1] as number).toBeLessThan(before[1] as number);
    expect(after[0] as number).toBeGreaterThan(before[0] as number);
  }, 60_000);

  it("§V309 — a kernel that names neither emits no member and no uniform", () => {
    const withClock = planFor(CLOCK_KERNEL).passes.find(
      (pass) => pass.kind === "dispatch" && pass.nodeId === "sim",
    ) as { shader: string; uniforms: Record<string, unknown> };
    const without = planFor(LAP_ONLY_KERNEL).passes.find(
      (pass) => pass.kind === "dispatch" && pass.nodeId === "sim",
    ) as { shader: string; uniforms: Record<string, unknown> };

    expect(without.shader).not.toMatch(/abs/);
    expect(Object.keys(without.uniforms).sort()).toEqual([
      "count",
      "deltaSeconds",
      "frameIndex",
      "seed",
      "timeSeconds",
    ]);

    // …and the kernel that DOES name them carries exactly the two extra names, in both
    // places. The pairing is the assertion: either half alone is a silent zero.
    expect(withClock.shader).toContain("absTimeSeconds: f32,");
    expect(withClock.shader).toContain("absFrameIndex: u32,");
    expect(Object.keys(withClock.uniforms).sort()).toEqual([
      "absFrameIndex",
      "absTimeSeconds",
      "count",
      "deltaSeconds",
      "frameIndex",
      "seed",
      "timeSeconds",
    ]);
  });
});
