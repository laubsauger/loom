import { describe, expect, it } from "vitest";
import { readPointAttribute } from "../../../nodes/definitions/test-support.ts";

import { compileGraph } from "../../../compiler/index.ts";
import { createValueGraphSession } from "../../../domain/channels/value-graph.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T479 — the VALUE GRAPH reaches a point kernel, and it changes what the kernel DOES.
 *
 * The gap this closes is stated in the task: `kernel`, `attributes` and `group` are all
 * `compileTime`, so before this every point animation's SHAPE lived in WGSL. An LFO could
 * scale a kernel's uniforms; it could not reach inside the kernel's behaviour. This is
 * T367's counterpart — the pointer was one absent channel, the value graph was the other.
 *
 * §V220 is why this is a GRAPH with a real `lfo` node and the real
 * `createValueGraphSession`, not a hand-supplied resolver: a test that hands over the
 * wiring it is checking proves nothing. Nothing below computes a sine; the LFO does, the
 * value graph publishes the channel, the parameter resolver reads it, the node mirrors it
 * into the pass, the backend writes it, and the kernel reads it back out of a buffer.
 *
 * §V361 is the assertion shape: three runs, and each fails on a different lie.
 *  1. The value the kernel WROTE equals the LFO's own published channel, exactly. A
 *     channel that arrives scaled, stale or zero produces a different number that is
 *     still a number.
 *  2. Two different frames produce two different values. A slot wired once and then
 *     frozen — B40's exact symptom — satisfies (1) at one frame and fails here.
 *  3. The SAME graph with the slot in STATIC mode returns the static instead. That is
 *     the edge cut: with no drive, the picture must come from the knob, and the two must
 *     not coincide.
 */

const PROBE_SCHEMA = [
  { name: "position", type: "vec3f" as const, semantic: "position" as const, default: [0, 0, 0] },
  { name: "probe", type: "vec4f" as const, default: [0, 0, 0, 0] },
];
const ATTRIBUTES = JSON.stringify(PROBE_SCHEMA);

/** The whole point: the live value decides the motion, not a constant in the text. */
const VALUE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.probe = vec4f(ctx.value1, 0.0, 0.0, 1.0);
  q.position = vec3f(ctx.value1, 0.0, 0.0);
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

const STATIC_FALLBACK = 0.25;

/** `driven` on the kernel's Value 1 slot, with a static the drive must be seen to beat. */
function valueSlot(mode: "driven" | "static") {
  return {
    mode,
    bindings: {
      static: { kind: "static" as const, value: STATIC_FALLBACK },
      driven: { kind: "driven" as const, channel: "lfo1" },
    },
  };
}

function graphWith(mode: "driven" | "static") {
  return {
    revision: 1,
    nodes: {
      wave: {
        id: "wave",
        type: "lfo",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "lfo1",
        parameters: { shape: "sine", frequency: 0.5, amplitude: 1, phase: 0, offset: 0 },
      },
      sim: {
        id: "sim",
        type: "pointKernel",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "kernel1",
        parameters: { capacity: 8, seed: 7, kernel: VALUE_KERNEL, attributes: ATTRIBUTES, value1: valueSlot(mode) },
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

const frameAt = (frameIndex: number) => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "offline" as const,
  randomSeed: 7,
});

/**
 * One frame through the REAL seam: value graph evaluates, the compiler resolves driven
 * parameters against its resolver, the backend runs the plan, the kernel's own write comes
 * back. Returns both what the kernel saw and what the LFO published, so the two can be
 * compared rather than each compared to a number this file invented.
 */
async function runFrame(
  mode: "driven" | "static",
  frameIndex: number,
): Promise<{ kernelSaw: number; lfoPublished: number | undefined }> {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const graph = graphWith(mode);
  const session = createValueGraphSession(registry);
  const frame = frameAt(frameIndex);
  const evaluated = session.evaluate(graph as never, frame);
  expect(evaluated.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

  const plan = compileGraph({
    graph: graph as never,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    resolution: { frame, channels: evaluated.resolver },
  });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const errors: string[] = [];
  backend.onDiagnostic((d) => {
    if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
  });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, { frame, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [16, 16] });
    expect(errors).toEqual([]);
    /* T1076: `probe` is a REGION of the kernel's packed buffer — the schema puts it
       after `position`, so a read from byte 0 would hand back coordinates. */
    const probe = (
      await readPointAttribute(backend.readBuffer, "sim", PROBE_SCHEMA, 8, "probe")
    ).floats;
    const bag = evaluated.byName.get("lfo1");
    const published = bag === undefined ? undefined : (Object.values(bag)[0] as number | undefined);
    return { kernelSaw: probe[0] as number, lfoPublished: published };
  } finally {
    backend.dispose();
  }
}

describe("ctx.value on Dawn — an LFO changes what the kernel DOES (T479)", () => {
  it("hands the kernel the channel the value graph published, exactly", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const { kernelSaw, lfoPublished } = await runFrame("driven", 20);
    expect(lfoPublished).toBeTypeOf("number");
    // f32 in the buffer against the f64 the LFO computed: compare at f32 precision, which
    // is exactness for this seam, not a tolerance band (§V147).
    expect(kernelSaw).toBe(Math.fround(lfoPublished as number));
    // And the drive is genuinely doing something — a channel resolving to the static
    // would satisfy the equality above by coincidence.
    expect(kernelSaw).not.toBe(STATIC_FALLBACK);
  }, 60_000);

  it("MOVES: two frames of the same graph give the kernel two different numbers", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const early = await runFrame("driven", 10);
    const later = await runFrame("driven", 40);
    expect(early.kernelSaw).not.toBe(later.kernelSaw);
    expect(early.kernelSaw).toBe(Math.fround(early.lfoPublished as number));
    expect(later.kernelSaw).toBe(Math.fround(later.lfoPublished as number));
  }, 60_000);

  it("CUT THE EDGE: in static mode the kernel sees the knob, not the LFO (§V361)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const driven = await runFrame("driven", 20);
    const still = await runFrame("static", 20);
    expect(still.kernelSaw).toBe(STATIC_FALLBACK);
    expect(still.kernelSaw).not.toBe(driven.kernelSaw);
  }, 60_000);

  /**
   * §V309, at the seam where it costs something. The kernel here names no slot, so the
   * generated module must be the text it was before T479, and the pass must carry no
   * value entry — a uniform value with no member is silently dropped, and a member with
   * no value silently reads zero.
   */
  it("a kernel that names no slot emits neither the member nor the uniform", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const graph = graphWith("driven");
    (graph.nodes.sim.parameters as Record<string, unknown>)["kernel"] =
      `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.probe = vec4f(ctx.time, 0.0, 0.0, 1.0);
  return q;
}`;
    const plan = compileGraph({ graph: graph as never, settings: SETTINGS, registry, capabilities: CAPABILITIES });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const kernelPass = plan.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === "sim") as {
      shader: string;
      uniforms: Record<string, unknown>;
    };
    expect(kernelPass.shader).not.toMatch(/\bvalue\d\b/);
    expect(Object.keys(kernelPass.uniforms).sort()).toEqual([
      "count",
      "deltaSeconds",
      "frameIndex",
      "seed",
      "timeSeconds",
    ]);
  });
});
