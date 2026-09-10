import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { kaleidoscopeDocument } from "./documents/kaleidoscope.ts";
import { lfoDissolveDocument } from "./documents/lfo-dissolve.ts";
import { gradientRemapDocument } from "./documents/gradient-remap.ts";
import { displacementStackDocument } from "./documents/displacement-stack.ts";
import { nodeGpuHost } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { renderHeadless, type RenderedFrame } from "../tests/headless/render-harness.ts";

function displayBytes(frame: RenderedFrame): Uint8Array {
  return toRgba8({ ...frame, rowStride: frame.width * BYTES_PER_PIXEL[frame.format] },
    { space: frame.format === "rgba8unorm-srgb" ? "linear" : "encoded" }).data;
}

describe("T1310 — full-resolution SDR storage acceptance", () => {
  it.each([kaleidoscopeDocument, lfoDissolveDocument, gradientRemapDocument, displacementStackDocument])(
    "$name preserves displayed colour at five deterministic animation times",
    async (document) => {
      const render = (workingFormat: "rgba16float" | "rgba8unorm-srgb") => renderHeadless({
        host: nodeGpuHost(), graph: document.graph,
        settings: { ...document.settings, workingFormat }, outputNodeId: "out",
        frames: 5, fps: 1, capture: [0, 1, 2, 3, 4], animate: true,
      });
      const baseline = await render("rgba16float");
      const candidate = await render("rgba8unorm-srgb");
      const replay = await render("rgba8unorm-srgb");
      expect(document.settings.workingFormat).toBe("rgba8unorm-srgb");
      // The initial static compile has no channel resolver. Animated frames below do;
      // the LFO extrema assertion verifies that the retained value is not being replayed.
      const relevant = (result: typeof baseline) => result.diagnostics.filter((diagnostic) =>
        !(diagnostic.severity === "info" && diagnostic.code === "parameter.channels.unavailable"));
      expect(relevant(baseline)).toEqual([]);
      expect(relevant(candidate)).toEqual([]);
      expect(relevant(replay)).toEqual([]);
      expect(candidate.frames).toHaveLength(5);
      const expectedRatio = document === gradientRemapDocument ? 5 / 8
        : document === displacementStackDocument ? 3 / 4 : 1 / 2;
      expect(candidate.plan.estimatedResourceBytes).toBe(baseline.plan.estimatedResourceBytes * expectedRatio);
      console.info(document.name, `planned bytes ${baseline.plan.estimatedResourceBytes} -> ${candidate.plan.estimatedResourceBytes}`);
      if (document === lfoDissolveDocument) {
        // 0.25 Hz sine: t=1 is pure checker, t=3 pure noise. Proves the real channel
        // resolver drives the animation instead of holding the initial 0.5 crossfade.
        expect(displayBytes(candidate.frames[1]!).every((value) => value === 0 || value === 255)).toBe(true);
        expect(displayBytes(candidate.frames[3]!).some((value) => value > 0 && value < 255)).toBe(true);
      }
      for (const output of candidate.plan.outputs) {
        const floatNodes = document === gradientRemapDocument ? ["field"]
          : document === displacementStackDocument ? ["field", "shape", "place"] : [];
        expect(output.format, output.nodeId).toBe(
          floatNodes.includes(output.nodeId) ? "rgba16float" : "rgba8unorm-srgb",
        );
        if (document === kaleidoscopeDocument && output.nodeId !== "out") {
          expect(output.size, output.nodeId).toEqual([2048, 2048]);
        }
      }
      for (let i = 0; i < baseline.frames.length; i += 1) {
        const reference = baseline.frames[i]!;
        const alternative = candidate.frames[i]!;
        expect([alternative.width, alternative.height]).toEqual([reference.width, reference.height]);
        expect([alternative.width, alternative.height]).toEqual([1280, 720]);
        expect(Buffer.compare(alternative.bytes, replay.frames[i]!.bytes)).toBe(0);
        const a = displayBytes(reference);
        const b = displayBytes(alternative);
        let max = 0;
        let total = 0;
        for (let pixel = 0; pixel < a.length; pixel += 1) {
          const difference = Math.abs(a[pixel]! - b[pixel]!);
          max = Math.max(max, difference);
          total += difference;
        }
        const mean = total / a.length;
        console.info(document.name, `frame ${i}: max=${max}, mean=${mean.toFixed(4)} display bytes`);
        expect(max).toBeLessThanOrEqual(3);
        expect(mean).toBeLessThanOrEqual(0.5);
      }
    }, 120_000,
  );
});
