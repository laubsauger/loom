import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T764 (§B142) — THE BOUNDARY RITE CLEARS PLAIN TARGETS, enforced rather than flagged.
 *
 * `RecompileDecision.recreateTargets` was produced at ten sites and read at zero, so
 * "a load recreates every target" was an unenforced property: the compile carry-over
 * reuses same-id same-shape textures, and two documents share target ids the moment
 * they share node names ("out" is in every shipped example). Ping-pongs, rings and
 * buffer pairs were already cleared by the boundary's unscoped
 * `resetTemporalHistory(undefined, { buffers: true })`; plain targets were the carrier
 * left standing (§T733's note — the temporal reset was the only guard). The flag is
 * deleted (§V205: an unread decision is worse than none) and the property lives in the
 * rite itself, gated here by value: a rendered target reads back ZERO after the
 * boundary call, before any new frame runs — which is exactly the window in which a
 * carried target used to show the previous document's pixels.
 */
describe("the boundary rite clears plain targets (T764, §B142)", () => {
  it("a rendered target reads back zero after the unscoped buffers reset", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          fill: { id: "fill", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { color: [1, 1, 1, 1] } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "fill", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      } as never,
      settings: {
        outputResolution: { width: 32, height: 32 },
        workingFormat: "rgba8unorm",
        randomSeed: 7,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      } as never,
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      } as never,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [32, 32],
      } as never);
      const lit = await backend.readOutput("target:fill:out");
      expect(lit.bytes[0]).toBe(255); // the target genuinely held pixels

      // The load path's exact call (use-frame-loop's boundary rite).
      backend.resetTemporalHistory(undefined, { buffers: true, silent: true });

      const cleared = await backend.readOutput("target:fill:out");
      // ZERO — not the previous pixels. Before this enforcement, a carried target held
      // whatever the last document drew until (unless) something overwrote it.
      expect(Math.max(...cleared.bytes.subarray(0, 4 * 32))).toBe(0);
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
