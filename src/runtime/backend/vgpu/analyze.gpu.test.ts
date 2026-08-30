import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode, ProjectSettings } from "../../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import { compileGraph } from "../../../compiler/compile.ts";
import { scratchResourceId } from "../../../compiler/resources.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import {
  analyzeChannelEntries,
  createAnalyzeChannels,
} from "../../execution/analyze-channels.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { createUniformAnimator } from "../../../app/animate-parameters.ts";

/**
 * T236 end to end on Dawn (§V144, §V48): a Solid's colour goes in, a NUMBER comes out —
 * through the real compiler, the real backend, the real reduction shader, the real
 * async readback, and the channel service. The image→parameter loop, closed and
 * measured in actual values rather than call counts.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

function node(id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ...extra };
}

describe("Analyze on Dawn (T236)", () => {
  it("reduces a solid to its channel statistics, published as a named channel", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // A LINEAR-space solid so the number to expect is the number typed in. (`solid`
    // declares space: "display", which would decode 0.5 to ~0.214 — correct, but a
    // worse test constant.) `level`'s output of a mid-grey works too, but Solid via a
    // linear check keeps this readable: expect the sRGB-decoded value explicitly.
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        gen: node("gen", "solid", { parameters: { color: [0.5, 0.5, 0.5, 1] } }),
        meter: node("meter", "analyze", {
          label: "analyze1",
          parameters: { channel: "r", operation: "average" },
        }),
      },
      edges: {
        e0: {
          id: "e0",
          source: { nodeId: "gen", portId: "out" },
          target: { nodeId: "meter", portId: "input" },
        } as GraphDocument["edges"][string],
      },
      groups: {},
    } as unknown as GraphDocument;

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({ graph, settings, registry, capabilities });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);
    // The analyze node is its own sink: no Output node, yet the chain survived pruning.
    expect(plan.passes.length).toBeGreaterThan(0);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });

      // The raw buffer first: [average, min, max, 1] of the red channel. Solid is
      // display-space, so 0.5 decodes to ~0.2140 in the working space (§V56).
      const raw = await backend.readBuffer(scratchResourceId("meter", "result"));
      const values = new Float32Array(raw, 0, 4);
      expect(values[0]).toBeCloseTo(0.214, 2);
      expect(values[1]).toBeCloseTo(values[0] ?? 0, 4); // a solid: min == avg == max
      expect(values[2]).toBeCloseTo(values[0] ?? 0, 4);

      // Now the channel service — §V144's one-frame-late contract in miniature: before
      // any sample() the channel is unknown (retained values rule); after a sample
      // settles, the resolver answers synchronously.
      const channels = createAnalyzeChannels({ readBuffer: (id) => backend.readBuffer(id) });
      channels.track(analyzeChannelEntries(graph, registry));
      expect(channels.resolver("analyze1", {} as never)).toBeUndefined();
      // The readback is fire-and-forget by contract — the resolver answers with the
      // last COMPLETED one. So the test waits the way a frame loop does: keep
      // sampling until a value lands (bounded), never awaiting inside a frame.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (channels.resolver("analyze1", {} as never) !== undefined) break;
        channels.sample();
        await backend.whenSettled();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(channels.resolver("analyze1", {} as never)).toBeCloseTo(0.214, 2);
    } finally {
      backend.dispose();
    }
  });
});

/**
 * T480: the loop CLOSED TO THE PIXEL. The test above proves image→number; this proves
 * number→parameter→image — the readback channel drives a uniform through the real
 * per-frame resolution path and the picture changes. §V361 for the whole circle: the
 * frame before the value lands renders dark, the frame after renders bright, and both
 * ends are exact bytes.
 */
describe("Analyze drives a parameter that changes the PICTURE (T480, §V144, §V361)", () => {
  it("a white input pushes the driven amount from 0 to 1 between frames", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        // WHITE, because 1 is a fixed point of the display decode (§V56): the average
        // is exactly 1, so the driven amount is exactly 1, so the pixel is exactly 255.
        gen: node("gen", "solid", { parameters: { color: [1, 1, 1, 1] } }),
        meter: node("meter", "analyze", {
          label: "meter1",
          parameters: { channel: "r", operation: "average" },
        }),
        feed: node("feed", "solid", { parameters: { color: [1, 1, 1, 1] } }),
        dim: node("dim", "customWgsl", {
          parameters: {
            amount: {
              mode: "driven",
              bindings: {
                // The retained static: the picture BEFORE the channel lands.
                static: { kind: "static", value: 0 },
                driven: { kind: "driven", channel: "meter1" },
              },
            },
          },
        }),
        out: node("out", "output", {}),
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "meter", portId: "input" } },
        e1: { id: "e1", source: { nodeId: "feed", portId: "out" }, target: { nodeId: "dim", portId: "input" } },
        e2: { id: "e2", source: { nodeId: "dim", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      } as unknown as GraphDocument["edges"],
      groups: {},
    } as unknown as GraphDocument;

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const channels = createAnalyzeChannels({ readBuffer: (id) => backendRefFor.readBuffer(id) });
    // rgba8unorm here so readOutput hands back display BYTES, not raw half-floats.
    const settings8: ProjectSettings = { ...settings, workingFormat: "rgba8unorm" };
    const compileAt = (frameIndex: number) =>
      compileGraph({
        graph,
        settings: settings8,
        registry,
        capabilities,
        resolution: {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
          channels: channels.resolver,
        },
      } as never);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const backendRefFor = backend;
    try {
      await backend.initialize({});
      channels.track(analyzeChannelEntries(graph, registry));

      // FRAME 0: no readback has landed, the driven amount resolves to its retained 0.
      const first = compileAt(0);
      expect(first.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const compiled = await backend.compile(first);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      const dark = await backend.readOutput("target:dim:out");
      const centre = (32 * 64 + 32) * 4;
      expect(dark.bytes[centre]).toBe(0);

      // Between frames (§V48's window): the sample lands the white average, exactly 1.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (channels.resolver("meter1", {} as never) !== undefined) break;
        channels.sample();
        await backend.whenSettled();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(channels.resolver("meter1", {} as never)).toBe(1);

      // FRAME 1: the SAME document re-resolves — the driven amount is now the channel's
      // 1 — and travels the path the app actually uses (§V5): the per-frame plan diffs
      // against the structural one and the animator pushes the changed block as a
      // uniform WRITE. Never a recompile; that is the whole point of the seam.
      const second = compileAt(1);
      const written = createUniformAnimator().push(backend, first, second);
      expect(written).toBeGreaterThan(0);
      backend.render(compiled, {
        frame: { timeSeconds: 1 / 60, deltaSeconds: 1 / 60, frameIndex: 1, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      const bright = await backend.readOutput("target:dim:out");
      expect(bright.bytes[centre]).toBe(255);
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
