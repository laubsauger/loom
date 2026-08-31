import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { sinkDisplayTransform } from "../../domain/color/display.ts";
import { loadProject } from "../../domain/project/index.ts";
import {
  OUTPUT_PASSTHROUGH_WGSL,
  outputDisplayShader,
} from "../../nodes/shaders/output-passthrough.wgsl.ts";
import { exampleRegistry } from "../../examples/runner.ts";
import { mockGpuHost, type MockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { fixturePlan } from "../../runtime/backend/vgpu/plan-fixture.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { decodeComponents } from "./pixel-compare.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T674 — WHAT THE VIEWER PANE ACTUALLY COMPOSITES.
 *
 * The owner's report: E9-Ember flickers between the picture and a black frame every frame
 * in the VIEWER, while every preview tile — including the Output node's own — looks fine.
 * Their pixel readout at (45,72) on the 1280x720 rgba16float sink: `0 0 0 65504`, and
 * 65504 is exactly f16 max.
 *
 * The bug is the PRODUCT of two facts, and either one alone is harmless. That is why this
 * file asserts both together rather than in two places that can drift apart:
 *
 *  (1) THE SINK'S ALPHA LEAVES [0,1]. The catalogue's arithmetic blends are per channel
 *      across RGBA by decided convention (`composite.wgsl.ts`) — Add adds alpha, Screen
 *      screens it. Screen is a contraction only on [0,1]; with a front alpha of `A` the
 *      alpha map is `L -> A + L - A*L`, whose slope is `1 - A`. E9's additive point stack
 *      leaves `burn.a = 6.02` EVERYWHERE (measured), so the slope is -5.02, and Feedback's
 *      0.62 persistence closes the loop at a gain of -3.11. |gain| > 1, so alpha diverges
 *      geometrically WITH ITS SIGN ALTERNATING EVERY FRAME, and clamps at +-65504 by
 *      frame 10. RGB is untouched: mean luma holds at ~0.048 the whole way.
 *
 *  (2) THE VIEWER CANVAS HONOURS THAT ALPHA. `ensurePresentation` had claimed "opaque is
 *      CORRECT here" in a comment since T87 while passing NO `alphaMode` at all, and
 *      vgpu's default is `"premultiplied"`. So negative alpha clamped to 0, the pane went
 *      fully transparent, and the page showed through as black on every odd frame.
 *
 * The preview tiles are structurally blind to (1): every lens shader in
 * `runtime/previews/debug-effects.wgsl.ts` ends `return vec4f(..., 1.0)`. That asymmetry
 * IS the owner's "fine in the preview, black in the viewer", and it is why the six preview
 * gates could all be green while the product was broken.
 *
 * WHAT THIS FILE CANNOT SEE (§V620, and the reader-that-cannot-see family): the real
 * browser compositor. No headless harness configures a live `GPUCanvasContext`, so the
 * last hop — Chrome blending the presented texture against the pane — is asserted here by
 * APPLYING the WebGPU compositing rule for the mode the backend actually configures, not
 * by observing Chrome do it. The mode is read from the `configure()` call the surface
 * really makes, so the two halves cannot drift; the compositing arithmetic is this file's
 * model of the spec.
 */

let dawnError: string | undefined;

beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

/**
 * A canvas that records the `configure()` its surface makes. Same shape as the preview
 * overlay's fixture in `vgpu-backend.test.ts`, pointed at a PRESENTATION instead — the
 * viewer side had no equivalent, which is how the comment/default drift survived.
 */
function recordingCanvas(host: MockGpuHost) {
  let configured: Record<string, unknown> | undefined;
  const context = {
    configure(options: Record<string, unknown>) {
      configured = options;
    },
    unconfigure() {},
    getCurrentTexture: () => {
      const device = host.device;
      if (!device) throw new Error("no live mock device");
      return device.createTexture({
        size: [64, 64],
        format: "rgba8unorm",
        usage: ["render_attachment", "texture_binding"] as unknown as GPUTextureUsageFlags,
      });
    },
  };
  return {
    canvas: { width: 64, height: 64, getContext: (kind: string) => (kind === "webgpu" ? context : null) },
    configured: () => configured,
  };
}

/** The alpha mode the viewer's presentation surface is really configured with. */
async function presentedAlphaMode(): Promise<unknown> {
  const host = mockGpuHost();
  const backend = createVgpuBackend({ host });
  try {
    await backend.initialize({});
    await backend.compile(fixturePlan());
    const { canvas, configured } = recordingCanvas(host);
    backend.present(canvas, { outputId: "output", label: "viewer" });
    return configured()?.["alphaMode"];
  } finally {
    backend.dispose();
  }
}

/**
 * What the compositor puts on screen for one presented pixel, per the WebGPU spec's two
 * canvas alpha modes. `opaque` ignores alpha entirely; `premultiplied` treats the colour
 * as already scaled by it, so anything the blit wrote with alpha <= 0 is fully transparent
 * and the pane behind shows through.
 *
 * The blit is a straight pass-through (`BLIT_WGSL`) into an 8-bit surface, so the source
 * components arrive clamped to [0,1] — which is what turns E9's -65504 into a zero.
 */
function compositedLuma(r: number, g: number, b: number, a: number, mode: unknown): number {
  const c = (v: number) => Math.min(Math.max(v, 0), 1);
  const luma = 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  return mode === "opaque" ? luma : luma * c(a);
}

describe("T674 — the viewer pane presents its output opaquely", () => {
  it("configures the presentation surface's alphaMode EXPLICITLY, and opaque", async () => {
    // Not "not premultiplied": the value has to be PASSED. Leaving it undefined is the
    // bug — vgpu fills in "premultiplied" and the comment above the call says otherwise.
    expect(await presentedAlphaMode()).toBe("opaque");
  });

  it("keeps E9-Ember's presented picture stable across CONSECUTIVE frames", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const mode = await presentedAlphaMode();

    const loaded = loadProject(readFileSync("examples/E9-Ember.loom.json", "utf8"), {
      nodes: exampleRegistry(),
    });
    if (!loaded.ok) throw new Error(`E9 did not load: ${loaded.reason}`);
    const document = loaded.document;

    // FRAMES 8..15, every one of them. A still-frame comparison is worthless here: the
    // divergence alternates, so half of the frames are the good half of the ping-pong and
    // any gate that samples one frame — or two frames two apart — passes on a broken
    // tree. The window starts at 8 because that is where E9's alpha reaches f16 max and
    // the flicker becomes total (measured: frames 0..7 are the ramp).
    const capture = [8, 9, 10, 11, 12, 13, 14, 15];
    const rendered = await renderHeadless({
      host: nodeGpuHost(),
      graph: document.graph,
      settings: document.settings,
      frames: 16,
      capture,
      outputNodeId: "out",
      animate: true,
    });

    const presented = rendered.frames.map((frame) => {
      const components = decodeComponents(frame.bytes, frame.format);
      const pixels = frame.width * frame.height;
      let sum = 0;
      for (let i = 0; i < pixels; i += 1) {
        sum += compositedLuma(
          components[i * 4] ?? 0,
          components[i * 4 + 1] ?? 0,
          components[i * 4 + 2] ?? 0,
          components[i * 4 + 3] ?? 0,
          mode,
        );
      }
      return { frameIndex: frame.frameIndex, luma: sum / pixels };
    });

    // The POSITIVE half first (§V516): E9 is a lit fire, so every presented frame must
    // carry real light. Without this the test would also pass on a viewer that showed
    // black CONSTANTLY — a steady black flickers no more than a steady picture does.
    for (const frame of presented) {
      expect(
        frame.luma,
        `frame ${frame.frameIndex} presents nothing: ${presented.map((f) => `${f.frameIndex}=${f.luma.toFixed(5)}`).join(" ")}`,
      ).toBeGreaterThan(0.01);
    }

    // And the flicker itself, stated between NEIGHBOURS. E9 evolves slowly (mean luma
    // drifts ~0.5% per frame at rest), so consecutive frames of a healthy viewer are
    // within a few percent of each other; the bug drops alternate frames to exactly zero.
    // A ratio floor of 0.5 is far outside the drift and far inside the failure.
    for (let i = 1; i < presented.length; i += 1) {
      const previous = presented[i - 1]!;
      const current = presented[i]!;
      const ratio = Math.min(current.luma, previous.luma) / Math.max(current.luma, previous.luma);
      expect(
        ratio,
        `frames ${previous.frameIndex}->${current.frameIndex} flicker: ` +
          `${previous.luma.toFixed(5)} -> ${current.luma.toFixed(5)} (alphaMode ${String(mode)})`,
      ).toBeGreaterThan(0.5);
    }
  }, 300_000);
});

/**
 * T678 — THE SECOND DEFENCE, AT THE SINK.
 *
 * `alphaMode: "opaque"` protects the VIEWER PANE and nothing else. Every other reader of a
 * sink target — `savePng`, the image export, the cook oracle, an agent screenshot — reads
 * the texture directly and never touches a canvas, so a meaningless alpha still reached all
 * of them. The Output node already clamps and encodes RGB; passing `source.a` through raw
 * was the asymmetry.
 *
 * These two mechanisms are INDEPENDENT and both are load-bearing. A test that only asserted
 * the presented picture would stay green if this clamp were deleted, and vice versa.
 */
describe("T678 — the Output node bounds the alpha it writes", () => {
  const displaySinks: ReadonlyArray<readonly [string, string]> = [
    // The measured offenders from T674's sweep, worst first (§B129/§B130).
    ["E9-Ember.loom.json", "out"], // ±65504, alternating sign
    ["E29-Descent.loom.json", "out"], // converges to 128
    ["E14-Self-Regulating-Bloom.loom.json", "out"], // flat 2.0
    ["E24-Audio-Reaction-Diffusion.loom.json", "out"], // 1.03 climbing
    ["E8-Slit-Scan.loom.json", "out"], // 1.55, and a 0.55 frame that stays 0.55
  ];

  it.each(displaySinks)("keeps %s's sink alpha inside [0,1]", async (fileName, sinkId) => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const loaded = loadProject(readFileSync(`examples/${fileName}`, "utf8"), {
      nodes: exampleRegistry(),
    });
    if (!loaded.ok) throw new Error(`${fileName} did not load: ${loaded.reason}`);
    const document = loaded.document;

    const capture = [0, 1, 2, 5, 9, 12, 15];
    const rendered = await renderHeadless({
      host: nodeGpuHost(),
      graph: document.graph,
      settings: document.settings,
      frames: 16,
      capture,
      outputNodeId: sinkId,
      animate: true,
    });

    for (const frame of rendered.frames) {
      const components = decodeComponents(frame.bytes, frame.format);
      const pixels = frame.width * frame.height;
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i < pixels; i += 1) {
        const alpha = components[i * 4 + 3] ?? 0;
        if (alpha < low) low = alpha;
        if (alpha > high) high = alpha;
      }
      expect(low, `${fileName} frame ${frame.frameIndex} alpha min`).toBeGreaterThanOrEqual(0);
      expect(high, `${fileName} frame ${frame.frameIndex} alpha max`).toBeLessThanOrEqual(1);
    }
  }, 300_000);

  /**
   * THE NEGATIVE HALF (§V516): the clamp must NOT reach the two sinks that mean raw.
   *
   * Scoping this guard to "the Output node" instead of "a DISPLAY sink" would have silently
   * bounded a `data` target and a `displayTransform: "none"` measurement dump — both of
   * which exist precisely so someone can read back the numbers a shader produced. All three
   * cases returned `toneMap: "none", encode: false` and shared ONE shader string before
   * T678, so nothing structural distinguished them (§V619).
   */
  it("does NOT clamp a data target or a measurement dump", () => {
    const srgb = { workingSpace: "linear", displayTransform: "srgb" } as const;
    expect(sinkDisplayTransform(srgb, "rgba16float", "data", "none").clampAlpha).toBe(false);
    expect(
      sinkDisplayTransform(
        { workingSpace: "linear", displayTransform: "none" },
        "rgba16float",
        "linear",
        "none",
      ).clampAlpha,
    ).toBe(false);
    // And it IS on for every display sink, whichever shader that lands on.
    expect(sinkDisplayTransform(srgb, "rgba16float", "linear", "none").clampAlpha).toBe(true);
    expect(sinkDisplayTransform(srgb, "rgba8unorm-srgb", "linear", "none").clampAlpha).toBe(true);
    expect(sinkDisplayTransform(srgb, "rgba16float", "linear", "filmic").clampAlpha).toBe(true);
    // The raw shader must still exist and still pass alpha through, or the negative case
    // above is asserting a property of a shader nobody selects.
    expect(OUTPUT_PASSTHROUGH_WGSL).not.toContain("clamp(source.a");
    expect(outputDisplayShader(sinkDisplayTransform(srgb, "rgba16float", "data", "none"))).toBe(
      OUTPUT_PASSTHROUGH_WGSL,
    );
  });
});
