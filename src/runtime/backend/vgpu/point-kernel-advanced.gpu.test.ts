import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions, liveCountBufferId } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T322 on a REAL device, asserted on VALUES (the orchestrated condition): a same-frame
 * consumer of an advanced kernel must see the COMPACTED data. Which buffer id got
 * bound is the mechanism; a build binding the right id to STALE values would pass a
 * mechanism test and lie — so this reads the numbers back and matches them against the
 * analytically-known survivors, plus the live count, plus pixels through the whole
 * indirect draw path.
 *
 * The kernel: ids self-seed from the slot on frame zero, positions are a pure function
 * of id, odd ids die. Survivors are exactly ids 0,2,4,6 in order (scan compaction is
 * order-preserving and deterministic, §V74), forever after frame zero.
 */

const TEST_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) {
    q.id = ctx.index;
  }
  q.position = vec3f(f32(q.id) * 0.2 - 0.7, 0.0, 0.0);
  q.velocity = vec3f(0.0);
  if (q.id % 2u == 1u) {
    q.alive = 0u;
  }
  return q;
}`;

describe("advanced kernel end to end on Dawn (T322)", () => {
  it("kills odd ids; the consumer sees exactly the survivors, by value", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: { id: "sim", type: "pointKernelAdvanced", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 8, seed: 7, kernel: TEST_KERNEL } },
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8, sizePixels: 6 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 64, height: 64 },
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
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      for (let frameIndex = 0; frameIndex < 3; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      }
      expect(errors).toEqual([]);

      // The live count: 8 born, 4 killed on frame zero, stable thereafter.
      const countRaw = await backend.readBuffer(liveCountBufferId("sim"));
      expect(new Uint32Array(countRaw)[0]).toBe(4);

      // THE VALUES. readBuffer reads the pair's read half — where scatter landed the
      // survivors, and exactly what the edge map told the consumer to bind. Survivors
      // are ids 0,2,4,6 in slot order; position.x = id * 0.2 - 0.7 by construction.
      const positions = new Float32Array(await backend.readBuffer("scratch:sim:position"));
      const survivors = [0, 2, 4, 6];
      survivors.forEach((id, slot) => {
        expect(positions[slot * 4], `slot ${slot} (id ${id})`).toBeCloseTo(id * 0.2 - 0.7, 5);
        expect(positions[slot * 4 + 1], `slot ${slot} y`).toBeCloseTo(0, 5);
      });
      // Ids rode the compaction with their points (§V73).
      const ids = new Uint32Array(await backend.readBuffer("scratch:sim:id"));
      expect([...ids.slice(0, 4)]).toEqual(survivors);

      // And the whole indirect path draws: four sprites, not eight, not zero.
      const renderTarget = plan.outputs.find((output) => output.nodeId === "draw");
      const image = await backend.readOutput(renderTarget?.resourceId ?? "");
      let litPixels = 0;
      for (let index = 0; index < image.bytes.byteLength; index += 4) {
        if ((image.bytes[index] ?? 0) > 0) litPixels += 1;
      }
      expect(litPixels).toBeGreaterThan(0);
      expect(litPixels).toBeLessThan(64 * 64);
    } finally {
      backend.dispose();
    }
  });
});

/**
 * T323 on Dawn, on VALUES. The spawn kernel: ids self-seed on frame zero, ids in
 * [8,16) die, parent id 0 emits five children on frame zero. Analytically: 8 survive,
 * 5 are born (room for all), live count 13, children carry ids 16..20 from the
 * monotone cursor and their parent's exact position, and the packed flags word for
 * the spawning survivor reads back as (5 << 1) | 1 — BOTH fields non-trivial in one
 * word, decoded independently, which is where a shift or mask error would produce
 * plausible-wrong birth counts instead of a crash.
 */
const SPAWN_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) {
    q.id = ctx.index;
  }
  q.position = vec3f(f32(q.id) * 0.1 - 0.7, 0.0, 0.0);
  q.velocity = vec3f(0.0);
  if (q.id >= 8u && q.id < 16u) {
    q.alive = 0u;
  }
  if (ctx.frameIndex == 0u && q.id == 0u) {
    q.spawnCount = 5u;
  }
  return q;
}`;

const SATURATE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) {
    q.id = ctx.index;
  }
  q.spawnCount = 5u;
  return q;
}`;

function spawnPlan(capacity: number, kernel: string) {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  return compileGraph({
    graph: {
      revision: 1,
      nodes: {
        sim: { id: "sim", type: "pointKernelAdvanced", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity, seed: 7, kernel } },
        draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: capacity, sizePixels: 6 } },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    },
    settings: {
      outputResolution: { width: 64, height: 64 },
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
}

describe("spawn end to end on Dawn (T323)", () => {
  it("births are copies with fresh ids; the packed word decodes both fields", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const plan = spawnPlan(16, SPAWN_KERNEL);
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
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      expect(errors).toEqual([]);

      // ORCHESTRATED CONDITION: both packed fields non-trivial, decoded independently.
      // Survivor slot 0 is the spawning parent — its compacted flags word carries
      // alive=1 AND spawnCount=5 in one u32.
      const flags = new Uint32Array(await backend.readBuffer("scratch:sim:flags"));
      expect((flags[0] ?? 0) & 1).toBe(1);
      expect((flags[0] ?? 0) >> 1).toBe(5);
      expect(flags[1]).toBe(1); // a non-spawning survivor: alive only

      const counts = new Uint32Array(await backend.readBuffer(liveCountBufferId("sim")));
      expect(counts[0], "live = 8 survivors + 5 births").toBe(13);
      expect(counts[1], "id cursor = capacity + births placed").toBe(16 + 5);
      expect(counts[2], "nothing dropped — there was room").toBe(0);

      // Second frame: children persist (their ids are outside the kill band), nothing
      // new is born, and every value is exactly where the analysis says.
      backend.render(compiled, {
        frame: { timeSeconds: 1 / 60, deltaSeconds: 1 / 60, frameIndex: 1, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      expect(errors).toEqual([]);
      const countsAfter = new Uint32Array(await backend.readBuffer(liveCountBufferId("sim")));
      expect(countsAfter[0]).toBe(13);
      expect(countsAfter[1]).toBe(21);

      const ids = new Uint32Array(await backend.readBuffer("scratch:sim:id"));
      expect([...ids.slice(0, 13)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20]);
      const positions = new Float32Array(await backend.readBuffer("scratch:sim:position"));
      // Children recomputed their own position from their own id on frame one — the
      // copy gave them their parent's, identity gave them their own trajectory (§V74).
      expect(positions[8 * 4], "first child x = f(id 16)").toBeCloseTo(16 * 0.1 - 0.7, 5);
      expect(positions[12 * 4], "last child x = f(id 20)").toBeCloseTo(20 * 0.1 - 0.7, 5);
    } finally {
      backend.dispose();
    }
  });

  it("a saturating emitter drops COUNTABLY — the second orchestrated condition", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const plan = spawnPlan(4, SATURATE_KERNEL);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      }
      expect(errors).toEqual([]);
      const counts = new Uint32Array(await backend.readBuffer(liveCountBufferId("sim")));
      // Four parents, five children each, zero room: everything requested drops, the
      // live count never moves, and the CUMULATIVE counter says 20 + 20 after two
      // frames — a silently-saturating emitter is exactly what this number exposes.
      expect(counts[0]).toBe(4);
      expect(counts[2]).toBe(40);
    } finally {
      backend.dispose();
    }
  });
});
