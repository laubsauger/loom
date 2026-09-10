import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { DEFAULT_PROJECT_SETTINGS } from "../../domain/types/graph.ts";
import { graph, node, edge } from "../../examples/documents/builders.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { readChannels } from "../../runtime/export/pixel-format.ts";

describe("T1311 — numerical islands inside the SDR default", () => {
  it.each(["circle", "rectangle", "uv"])("retains %s precision through feedback", async (type) => {
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      const capabilities = await backend.initialize({});
      const registry = createNodeRegistry(allNodeDefinitions).view();
      // UV has an explicit data port; feedback's colour port cannot accept it. Read UV
      // directly and exercise both ping-pong halves with the signed-distance producers.
      const feedback = type !== "uv";
      const source = node("source", type, [0, 0], type === "uv" ? {} : { mode: "distance" });
      const document = graph(feedback ? [source, node("history", "feedback", [200, 0])] : [source],
        feedback ? [edge("e", ["source", "out"], ["history", "in"])] : []);
      const sink = feedback ? "history" : "source";
      const plan = compileGraph({ graph: document, registry, capabilities,
        settings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width: 1024, height: 8 } },
        sinks: [{ nodeId: sink, portId: "out", kind: "preview" }],
      });
      expect(plan.ok, JSON.stringify(plan.diagnostics)).toBe(true);
      const output = plan.outputs.find((entry) => entry.nodeId === sink);
      if (output === undefined) throw new Error("Missing numerical output");
      expect(output.format).toBe("rgba16float");
      expect(output.space).toBe(type === "uv" ? "data" : "linear");
      const compiled = await backend.compile(plan);
      for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 }, resolution: [1024, 8],
        });
        const image = await backend.readOutput(output.resourceId);
        const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
        const channel = new Float32Array(4);
        const reds: number[] = [];
        for (let x = 0; x < image.width; x += 1) {
          readChannels(image.bytes, view, 4 * image.rowStride + x * 8, image.format, channel);
          reds.push(channel[0]!);
        }
        if (type === "uv") {
          expect(new Set(reds).size).toBe(1024);
          expect(reds[512]! - reds[511]!).toBeLessThan(1 / 255);
        } else {
          expect(Math.min(...reds)).toBeLessThan(0);
          expect(Math.max(...reds)).toBeGreaterThan(0);
        }
      }
    } finally { backend.dispose(); }
  }, 60_000);
});
