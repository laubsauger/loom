import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import { graph, node, edge, settings } from "../../examples/documents/builders.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { nodeGpuHost } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { readChannels } from "../../runtime/export/pixel-format.ts";

const registry = createNodeRegistry(allNodeDefinitions).view();
const capabilities: BackendCapabilities = {
  tier: "B", features: [], timestampQuery: false,
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  limits: { maxTextureDimension2D: 8192 },
};

describe("T1309 — a colour input must not quantize depth measurements", () => {
  it.each(["rgba8unorm", "rgba8unorm-srgb", "rgba16float"] as const)(
    "preserves sub-byte depth increments and signed range from %s input",
    async (workingFormat) => {
      const document = graph([
        node("image", "solid", [0, 0]),
        node("depth", "depth", [200, 0], { outputRange: [-1, 2] }),
        node("copy", "null", [400, 0]),
        node("out", "output", [600, 0]),
      ], [
        edge("a", ["image", "out"], ["depth", "input"]),
        edge("b", ["depth", "out"], ["copy", "in"]),
        edge("c", ["copy", "out"], ["out", "input"]),
      ]);
      const plan = compileGraph({ graph: document, registry, capabilities,
        settings: settings({ workingFormat, outputResolution: { width: 4, height: 1 } }),
      });
      expect(plan.ok, JSON.stringify(plan.diagnostics)).toBe(true);
      for (const id of ["depth", "copy"]) {
        expect(plan.outputs.find((output) => output.nodeId === id)?.format).toBe("rgba16float");
      }
      const result = plan.resources.find((resource) => resource.kind === "externalTexture"
        && resource.sourceId === inferenceSourceIdFor("depth"));
      if (result?.kind !== "externalTexture") throw new Error("Missing depth result texture");
      expect(result.format).toBe("r32float");
      const values = [0, 0.5, 0.5005, 1];
      const payload = new Float32Array(result.size[0] * result.size[1]);
      const backend = createVgpuBackend({ host: nodeGpuHost() });
      try {
        await backend.initialize({});
        let frameId = 1;
        backend.registerMediaSource(inferenceSourceIdFor("depth"), {
          currentFrame: () => ({ frameId, bytes: new Uint8Array(payload.buffer) }),
        });
        const compiled = await backend.compile(plan);
        const output = plan.outputs.find((entry) => entry.nodeId === "copy");
        if (output === undefined) throw new Error("Missing depth consumer output");
        const samples: number[] = [];
        for (const value of values) {
          payload.fill(value);
          backend.render(compiled, {
            frame: { timeSeconds: frameId / 60, deltaSeconds: 1 / 60, frameIndex: frameId, mode: "offline", randomSeed: 7 },
            pointer: { x: 0, y: 0, buttons: 0 }, resolution: [4, 1],
          });
          const image = await backend.readOutput(output.resourceId);
          const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
          const channels = new Float32Array(4);
          readChannels(image.bytes, view, 0, image.format, channels);
          samples.push(channels[0]!);
          frameId += 1;
        }
        expect(samples[0]).toBe(-1);
        expect(samples[3]).toBe(2);
        expect(samples[1]).toBe(0.5);
        expect(samples[2]).toBeCloseTo(0.5015, 3);
        expect(samples[2]).toBeGreaterThan(samples[1]!);
      } finally { backend.dispose(); }
    }, 60_000,
  );
});
