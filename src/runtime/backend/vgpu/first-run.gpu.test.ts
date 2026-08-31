import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { pointPairId } from "../../../nodes/definitions/points.ts";
import { liveCountBufferId } from "../../../nodes/definitions/point-kernel-advanced.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T510/T552 — `ctx.firstRun` is the seeding signal, and the clocks are not.
 *
 * The fixture kernel writes 9 on firstRun and increments otherwise, so the buffer's
 * value IS the history: a re-seed is visible as a snap back to 9, and a survived lap
 * as monotone growth. The lap is simulated the way the transport actually does it —
 * frameIndex wraps to 0 while nothing else changes — which is exactly the frame where
 * the old `frameIndex == 0` guard re-seeded E9's fountain and this signal must NOT.
 * Then an unscoped buffers clear (the document-boundary/seek rite, T552) must re-seed,
 * and its diagnostic must stay silent when asked (T553).
 */

const SETTINGS = {
  outputResolution: { width: 32, height: 32 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

const KERNEL =
  "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  if (ctx.firstRun == 1u) { q.position = vec3f(9.0, 0.0, 0.0); }\n  else { q.position = p.position + vec3f(1.0, 0.0, 0.0); }\n  return q;\n}";

describe("firstRun seeds; a lap does not (T510)", () => {
  it("seeds once, survives a frameIndex wrap, re-seeds only on the buffers clear", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const graph = {
      revision: 1,
      nodes: {
        sim: {
          id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 },
          parameters: {
            capacity: 1, seed: 7,
            attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
            kernel: KERNEL,
          },
        },
        draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 1, sizePixels: 4 } },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as never as GraphDocument;

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const reported: string[] = [];
    try {
      await backend.initialize({});
      backend.onDiagnostic((diagnostic) => {
        reported.push(diagnostic.message);
      });
      const compiled = await backend.compile(plan);
      const render = (frameIndex: number): void =>
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [32, 32],
        });
      const x = async (): Promise<number> =>
        new Float32Array(await backend.readBuffer(pointPairId("sim", "position")))[0] as number;

      render(0); // fresh pair → firstRun 1 → seed
      expect(await x()).toBe(9);
      render(1);
      render(2);
      expect(await x()).toBe(11);
      // THE LAP: frameIndex wraps to 0, buffers keep. The old guard re-seeded here.
      render(0);
      expect(await x()).toBe(12);
      render(1);
      expect(await x()).toBe(13);

      // The document-boundary/seek rite: unscoped clear including buffers, silent.
      backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
      render(2);
      expect(await x()).toBe(9); // re-seeded over zeroed storage

      // T553: the automatic rite above was silent — no receipt. A user-invoked reset
      // keeps its info line: whoever asked gets the confirmation.
      expect(reported.filter((message) => message.includes("Temporal history reset"))).toEqual([]);
      backend.resetTemporalHistory();
      expect(reported.some((message) => message.includes("Temporal history reset"))).toBe(true);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

/**
 * T510's OTHER half (T579's finding): the LIFECYCLE machinery must survive the lap too.
 *
 * The user-facing `ctx.firstRun` fix alone made lap behaviour WORSE, because four
 * generated passes still inferred "my storage is fresh" from `frameIndex == 0`: the
 * kernel's live-count guard opened to full capacity, the dead-tail clear resurrected
 * the tail, and the spawn cursor reset. Measured before the fix: steady state 12,
 * 64 at the lap, pinned at 64 forever after. The counts buffer is a PLAIN buffer,
 * not a SoA pair — which is why `freshStorage` covers both kinds.
 *
 * Fixture: slot 0 is an immortal emitter spawning one child per frame; children count
 * their age in position.x and die at 10. Steady state is emitter + 11 ages = 12 live.
 * Nothing in the kernel reads frameIndex.
 */
const LIFECYCLE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.firstRun == 1u) {
    q.id = ctx.index;
    q.position = vec3f(0.0, 0.0, 0.0);
    if (ctx.index > 0u) { q.alive = 0u; return q; }
  }
  if (q.id == 0u) { q.position = vec3f(0.0, 0.0, 0.0); q.spawnCount = 1u; return q; }
  q.position = q.position + vec3f(1.0, 0.0, 0.0);
  if (q.position.x > 10.0) { q.alive = 0u; }
  return q;
}`;
const LIFECYCLE_SPAWN = `fn spawn(child: Point, ctx: PointCtx) -> Point {
  var q = child; q.position = vec3f(0.0, 0.0, 0.0); return q;
}`;

describe("the lifecycle survives the lap (T510/T579)", () => {
  it("holds its live count across a frameIndex wrap and re-seeds on the buffers clear", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const graph = {
      revision: 1,
      nodes: {
        sim: {
          id: "sim", type: "pointKernelAdvanced", definitionVersion: 1, position: { x: 0, y: 0 },
          parameters: { capacity: 64, seed: 7, attributes: "", group: "", kernel: LIFECYCLE_KERNEL, spawn: LIFECYCLE_SPAWN },
        },
        draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 64, sizePixels: 2 } },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as never as GraphDocument;

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      const render = (frameIndex: number): void =>
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [32, 32],
        });
      const live = async (): Promise<number> =>
        new Uint32Array(await backend.readBuffer(liveCountBufferId("sim")))[0] as number;

      for (let f = 0; f <= 60; f += 1) render(f);
      expect(await live()).toBe(12); // emitter + 11 ages, steady state

      // THE LAP: frameIndex wraps, buffers keep. The frameIndex == 0 inference opened
      // the live guard to capacity here — 64, pinned forever.
      render(0);
      expect(await live()).toBe(12);
      for (let f = 1; f <= 200; f += 1) render(f);
      expect(await live()).toBe(12);

      // The boundary rite restarts the simulation from nothing — including the counts
      // buffer, which is plain storage, not a pair (T552).
      backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
      render(0);
      const reseeded = await live();
      for (let f = 1; f <= 60; f += 1) render(f);
      expect(reseeded).toBe(2); // emitter + its first child: restarted, not carried
      expect(await live()).toBe(12); // and regrows to the same steady state
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
