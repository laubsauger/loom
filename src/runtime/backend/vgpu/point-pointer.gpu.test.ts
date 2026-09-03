import { describe, expect, it } from "vitest";
import { readPointAttribute } from "../../../nodes/definitions/test-support.ts";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { SHARED_UNIFORMS_WGSL } from "../shared-uniforms.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T367 — the pointer reaches a point KERNEL, and it is the SAME pointer (§V182).
 *
 * The failure this file exists to make impossible is not "the kernel reads zero" — that
 * one is loud and someone would notice within a frame. It is the QUIET one: the kernel
 * sees a pointer that is v-flipped, or window-normalised, or in pixels, while every
 * fragment shader and the whole value graph see the viewer-normalised uv of §V236. Each
 * half then looks correct on its own and a swarm gathers where the cursor is not, which
 * is exactly the class §V182 was written against ("two sources for one device drift").
 *
 * So the assertion is AGREEMENT, measured in one frame, on numbers a mistake could not
 * produce by accident:
 *
 *   x = 0.375, y = 0.8125, buttons = 1
 *
 * x ≠ y catches a swizzle. Neither is 0.5, so a v-flip (y → 0.1875) is not a fixed point.
 * x + y ≠ 1, so a flip cannot be mistaken for the other axis. Both are exact in f32 AND in
 * f16, so the compute readback (raw f32 out of a storage buffer) and the render readback
 * (rgba16float pixels) can be compared for EQUALITY rather than closeness — no tolerance
 * to hide a small systematic offset inside.
 *
 * Both halves come off ONE plan and ONE `render()`: the compute half writes `ctx.pointer`
 * into a point attribute, the fragment half writes `frameU.pointer` into pixels. Nothing
 * in the test supplies either value — the backend's own per-frame fill does (§V220: a
 * test that hands over the wiring it is checking proves nothing).
 */

const POINTER = { x: 0.375, y: 0.8125, buttons: 1 } as const;

/** Writes the shared block's pointer into pixels, so the two halves can be compared. */
const POINTER_PROBE_SOURCE = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  /* The input is sampled so the binding is genuinely used; its contribution is zero. */
  let unused = textureSampleLevel(inputTexture, inputSampler, uv, 0.0) * 0.0;
  return vec4f(frameU.pointer.xyz, 1.0) + unused;
}`;

/** The kernel side: the whole vec4f, verbatim, into a per-point attribute. */
const POINTER_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.probe = ctx.pointer;
  q.position = vec3f(0.0, 0.0, 0.0);
  return q;
}`;

const PROBE_SCHEMA = [
  { name: "position", type: "vec3f" as const, semantic: "position" as const, default: [0, 0, 0] },
  { name: "probe", type: "vec4f" as const, default: [0, 0, 0, 0] },
];
const ATTRIBUTES = JSON.stringify(PROBE_SCHEMA);

function halfFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

describe("the pointer in PointCtx, on Dawn (T367, §V182)", () => {
  it("the kernel and the shared frame block read the SAME four numbers", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: {
            id: "sim",
            type: "pointKernel",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: { capacity: 4, seed: 7, kernel: POINTER_KERNEL, attributes: ATTRIBUTES },
          },
          sprites: {
            id: "sprites",
            type: "renderPoints",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: { count: 4, sizePixels: 2 },
          },
          // Downstream of the sprites so the whole thing is one reachable chain, and its
          // own output is what the fragment half is read from.
          shader: {
            id: "shader",
            type: "customWgsl",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: { source: POINTER_PROBE_SOURCE },
          },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "sprites", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "sprites", portId: "out" }, target: { nodeId: "shader", portId: "input" } },
          e3: { id: "e3", source: { nodeId: "shader", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 16, height: 16 },
        // Half-float pixels: 0.375 and 0.8125 survive the round trip EXACTLY, so the two
        // halves are compared for equality rather than for being close enough.
        workingFormat: "rgba16float",
        randomSeed: 7,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      },
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      },
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
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: POINTER,
        resolution: [16, 16],
      });
      expect(errors).toEqual([]);

      // The COMPUTE half, raw f32 out of the attribute the kernel wrote.
      // T1076: the `probe` REGION of the kernel's packed buffer, after `position`.
      const kernelSide = (
        await readPointAttribute(backend.readBuffer, "sim", PROBE_SCHEMA, 4, "probe")
      ).floats;
      const kernelPointer = [kernelSide[0], kernelSide[1], kernelSide[2], kernelSide[3]];

      // The FRAGMENT half, out of the pixels the shared block drove.
      const target = plan.outputs.find((output) => output.nodeId === "shader");
      const image = await backend.readOutput(target?.resourceId ?? "");
      expect(image.format).toBe("rgba16float");
      const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
      const sharedPointer = [
        halfFloat(view.getUint16(0, true)),
        halfFloat(view.getUint16(2, true)),
        halfFloat(view.getUint16(4, true)),
      ];

      // §V182, stated three ways so no single mistake can satisfy all three: the kernel
      // agrees with the frame contract, the shaders agree with the frame contract, and
      // therefore the two agree with each other.
      expect(kernelPointer).toEqual([POINTER.x, POINTER.y, POINTER.buttons, 0]);
      expect(sharedPointer).toEqual([POINTER.x, POINTER.y, POINTER.buttons]);
      expect(kernelPointer.slice(0, 3)).toEqual(sharedPointer);

      // Every point in the dispatch, not just slot zero: a guard or an index mistake
      // that fed the first thread only would otherwise pass.
      for (let point = 1; point < 4; point += 1) {
        const base = point * 4;
        expect([kernelSide[base], kernelSide[base + 1], kernelSide[base + 2]], `point ${point}`).toEqual([
          POINTER.x,
          POINTER.y,
          POINTER.buttons,
        ]);
      }
    } finally {
      backend.dispose();
    }
  }, 60_000);

  /**
   * §V309, checked where it actually costs something: the shipped point graph.
   *
   * The kernel here never names the pointer, so the module the compiler hands the backend
   * must be the text it was before T367 — no member in the block, no member in the ctx,
   * and no `pointer` value on the pass. A field that appeared unconditionally would
   * recompile every saved point graph once, for a value none of them read.
   */
  it("a kernel that does not name the pointer emits neither the member nor the value", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: { id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 8 } },
          sprites: { id: "sprites", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "sprites", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "sprites", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 16, height: 16 },
        workingFormat: "rgba8unorm",
        randomSeed: 7,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      },
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      },
    });
    const kernelPass = plan.passes.find(
      (pass) => pass.kind === "dispatch" && pass.nodeId === "sim",
    ) as { shader: string; uniforms: Record<string, unknown> };
    expect(kernelPass.shader).not.toContain("pointer");
    expect(Object.keys(kernelPass.uniforms).sort()).toEqual([
      "count",
      "deltaSeconds",
      "frameIndex",
      "seed",
      "timeSeconds",
    ]);
  });
});

/**
 * T367/T378 — THE POINTS ACTUALLY MOVE, and they come back (§V147, B15).
 *
 * "The kernel can read the pointer" is a claim about a struct member; "the swarm follows
 * the cursor" is a claim about POSITIONS, and §V147 is explicit that a test over shader
 * source or plan shape is not evidence that anything moved. Every structural test above
 * passes on a swarm nailed to the spot.
 *
 * So this is the displacement itself, measured: a ring of points pushed OUTWARD from the
 * pointer with a Gaussian falloff — no cutoff radius, because a hard edge reads as a bug
 * rather than as a push — parked at two pointer positions and read back as numbers.
 *
 * Three assertions, and each one fails on a different lie:
 *
 *  1. Every point lands where the SAME arithmetic done on the CPU says it should. A
 *     pointer that arrives scaled, flipped or stale produces a different picture that is
 *     still a picture; comparing against computed values rather than against "it changed"
 *     is what makes that visible.
 *  2. The two pointer positions produce genuinely different geometry. A kernel that read a
 *     frozen pointer (B30's exact failure — `PointerSource.set` had no caller for weeks and
 *     every shader silently saw {0,0,0}) satisfies assertion 1 for one position and fails
 *     here.
 *  3. With the pointer far away the ring RETURNS to its undisplaced radius. A falloff that
 *     was really a constant, or an integrator quietly accumulating, passes 1 and 2 and
 *     fails this one — and it is the difference between a push and a permanent dent.
 *
 * This is the mechanism the mouse-driven torus wants (T378). It is proven here rather than
 * in an example because there is no node today that displaces an INCOMING pointset: see
 * the report — `pointKernel` is a source with no input port, so a generator's points cannot
 * be pushed by a kernel at all.
 */
describe("a swarm displaced by the pointer, on Dawn (T367, §V147)", () => {
  const COUNT = 8;
  const RING = 0.6;
  const REACH = 0.35;
  const PUSH = 0.5;
  const TAU = 6.283185307179586;

  const DISPLACE_KERNEL = `const TAU: f32 = 6.283185307179586;

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* Stateless: the frame is a pure function of index and pointer, so a replay and a live
     run agree exactly (§V45) and the readback below is reproducible. */
  let t = f32(ctx.index) / f32(ctx.count);
  let base = vec3f(cos(t * TAU) * ${RING}, sin(t * TAU) * ${RING}, 0.0);
  /* §V236's uv (v DOWN) into the world plane the points live in. Honest about what it is:
     no unprojection, because a kernel cannot see the camera that will draw it. */
  let cursor = vec3f(ctx.pointer.x * 2.0 - 1.0, 1.0 - ctx.pointer.y * 2.0, 0.0);
  let away = base - cursor;
  let distance = length(away);
  /* Gaussian, not a cutoff: the push fades out instead of ending somewhere. */
  let falloff = exp(-(distance * distance) / ${REACH * REACH});
  q.position = base + (away / max(distance, 0.0001)) * (${PUSH} * falloff);
  return q;
}`;

  const DISPLACE_SCHEMA = [
    { name: "position", type: "vec3f" as const, semantic: "position" as const, default: [0, 0, 0] },
  ];
  const ATTRS = JSON.stringify(DISPLACE_SCHEMA);

  /** The same arithmetic, on the CPU. Not a re-derivation — the claim IS that they agree. */
  function expectedPositions(pointer: { x: number; y: number }): Array<[number, number]> {
    return Array.from({ length: COUNT }, (_unused, index) => {
      const t = index / COUNT;
      const base: [number, number] = [Math.cos(t * TAU) * RING, Math.sin(t * TAU) * RING];
      const cursor: [number, number] = [pointer.x * 2 - 1, 1 - pointer.y * 2];
      const away: [number, number] = [base[0] - cursor[0], base[1] - cursor[1]];
      const distance = Math.hypot(away[0], away[1]);
      const falloff = Math.exp(-(distance * distance) / (REACH * REACH));
      const scale = (PUSH * falloff) / Math.max(distance, 0.0001);
      return [base[0] + away[0] * scale, base[1] + away[1] * scale];
    });
  }

  function planFor() {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    return compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: {
            id: "sim",
            type: "pointKernel",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: { capacity: COUNT, seed: 3, kernel: DISPLACE_KERNEL, attributes: ATTRS },
          },
          draw: {
            id: "draw",
            type: "renderInstances",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: { count: COUNT, shape: "box", scale: 0.08 },
          },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 32, height: 32 },
        workingFormat: "rgba8unorm",
        randomSeed: 3,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      },
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      },
    });
  }

  async function positionsAt(pointer: { x: number; y: number }): Promise<Array<[number, number]>> {
    const plan = planFor();
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 3 },
        pointer: { ...pointer, buttons: 0 },
        resolution: [32, 32],
      });
      expect(errors).toEqual([]);
      // vec3f strides SIXTEEN bytes, not twelve (§V72) — four floats per point in the view.
      const raw = (
        await readPointAttribute(backend.readBuffer, "sim", DISPLACE_SCHEMA, COUNT, "position")
      ).floats;
      return Array.from({ length: COUNT }, (_unused, index): [number, number] => [
        raw[index * 4] as number,
        raw[index * 4 + 1] as number,
      ]);
    } finally {
      backend.dispose();
    }
  }

  it("pushes the ring where the pointer says, differently for two positions, and lets it back", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const upperLeft = { x: 0.28, y: 0.3 };
    const lowerRight = { x: 0.72, y: 0.7 };
    const parkedAway = { x: 1, y: 0 }; // world (1, 1): ≥0.75 from every ring point

    const [left, right, away] = await Promise.all([
      positionsAt(upperLeft),
      positionsAt(lowerRight),
      positionsAt(parkedAway),
    ]);

    // 1. Every point is where the arithmetic says. f32 against f64 through cos/exp/hypot
    //    lands well inside 1e-5; anything that mis-scales or flips the pointer does not.
    for (const [pointer, actual] of [
      [upperLeft, left],
      [lowerRight, right],
      [parkedAway, away],
    ] as const) {
      const expected = expectedPositions(pointer);
      for (let index = 0; index < COUNT; index += 1) {
        expect(actual[index]?.[0], `pointer ${pointer.x},${pointer.y} point ${index} x`).toBeCloseTo(
          expected[index]?.[0] as number,
          5,
        );
        expect(actual[index]?.[1], `pointer ${pointer.x},${pointer.y} point ${index} y`).toBeCloseTo(
          expected[index]?.[1] as number,
          5,
        );
      }
    }

    // 2. The two positions are genuinely different pictures. A frozen pointer (B30) reads
    //    the same buffer twice and this is where it shows.
    const spread = Math.max(
      ...left.map((point, index) => Math.hypot(point[0] - (right[index]?.[0] ?? 0), point[1] - (right[index]?.[1] ?? 0))),
    );
    expect(spread).toBeGreaterThan(0.4);

    // 3. Parked away, the ring is a ring again — the push RELEASES. A falloff that was
    //    secretly a constant, or a kernel accumulating into position, fails only here.
    //
    //    Not to zero, and the bound is arithmetic rather than taste: the pointer is at
    //    world (1, 1), the nearest ring point is 0.815 away, and a Gaussian of reach 0.35
    //    still returns exp(-(0.815/0.35)^2) ≈ 0.0044 there — a residual push of 0.0022.
    //    That tail is the FEATURE (no cutoff, so nothing snaps), so the assertion is that
    //    the ring is back inside 0.5% of its radius, not that the tail is absent.
    for (const [x, y] of away) {
      expect(Math.abs(Math.hypot(x, y) - RING)).toBeLessThan(0.003);
    }
    // ...and it was genuinely deformed while the pointer was near, or "it came back" is
    // a statement about a ring that never left.
    const deformed = Math.max(...left.map(([x, y]) => Math.abs(Math.hypot(x, y) - RING)));
    expect(deformed).toBeGreaterThan(0.2);
  }, 90_000);
});
