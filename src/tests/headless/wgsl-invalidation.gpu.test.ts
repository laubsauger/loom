import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { DEFAULT_PROJECT_SETTINGS } from "../../domain/types/graph.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../../runtime/export/pixel-format.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T1335b — A CACHED SHADER STILL RENDERS THE SHADER YOU ASKED FOR.
 *
 * §T1333b stopped the compiler rebuilding WGSL every frame and §T1335b made that a type
 * rather than a rule. Both are performance work, and performance work on a cache has exactly
 * one catastrophic failure: the cache answers with LAST TIME'S TEXT. That defect is silent
 * in every way a type or a unit test can see — the pass compiles, the plan validates, the
 * frame renders, and the picture is simply wrong. So the claim is made where it cannot hide,
 * in PIXELS through the real stack: compiler, backend and Dawn.
 *
 * Two shaders that differ in ONE CHARACTER of a colour, rendered through `customWgsl`, which
 * is the path where a document's own text becomes a pass (`custom-wgsl.ts` builds it with the
 * `wgsl` tag, so this is the cache under test and not a bypass of it).
 *
 * ⚑ THE THIRD RENDER IS THE POINT. Red and then green proves nothing about a cache — a
 * cache keyed on the call site alone would return red's text for green and this would still
 * see two different pictures IF the first render were green. Going BACK to red, and getting
 * red's exact pixels again, is what separates "keyed on the text" from "keyed on the order".
 *
 * Red-verified: with `wgsl`'s trie walk collapsed to one node per call site, the second
 * render returns the first shader's text and the "green is not red" claim fails.
 */

const SIZE = 16;

function shaderFor(colour: string): string {
  return `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return ${colour};
}`;
}

function documentWith(source: string): GraphDocument {
  const node = (id: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ...extra }) as never;
  return {
    revision: 1,
    groups: {},
    nodes: {
      black: node("black", "solid", { parameters: { color: [0, 0, 0, 1] } }),
      shade: node("shade", "customWgsl", { label: "shade1", parameters: { source } }),
      out: node("out", "output", { label: "out1", parameters: {} }),
    },
    edges: {
      "black-shade": {
        id: "black-shade",
        source: { nodeId: "black", portId: "out" },
        target: { nodeId: "shade", portId: "input" },
      },
      "shade-out": {
        id: "shade-out",
        source: { nodeId: "shade", portId: "out" },
        target: { nodeId: "out", portId: "input" },
      },
    },
  } as unknown as GraphDocument;
}

async function firstPixel(source: string): Promise<[number, number, number]> {
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph: documentWith(source),
    settings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width: SIZE, height: SIZE } },
    frames: 1,
    capture: [0],
    animate: false,
    fps: 60,
    outputNodeId: "out",
  });
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const frame = rendered.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  const space = rendered.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
  const image = toRgba8(
    {
      width: frame.width,
      height: frame.height,
      format: frame.format,
      bytes: frame.bytes,
      rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
    },
    { space },
  );
  return [image.data[0] ?? 0, image.data[1] ?? 0, image.data[2] ?? 0];
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("T1335b — the shader cache cannot serve last frame's text", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  it("renders the shader it was given, then a DIFFERENT one, then the first again", async () => {
    const red = shaderFor("vec4f(1.0, 0.0, 0.0, 1.0)");
    const green = shaderFor("vec4f(0.0, 1.0, 0.0, 1.0)");

    const firstRed = await firstPixel(red);
    expect(firstRed[0]).toBeGreaterThan(200);
    expect(firstRed[1]).toBeLessThan(40);

    const wasGreen = await firstPixel(green);
    expect(wasGreen[1]).toBeGreaterThan(200);
    expect(wasGreen[0]).toBeLessThan(40);

    // Back to the first text — and to the first PIXELS, exactly (§V147: exact, not a band).
    const againRed = await firstPixel(red);
    expect(againRed).toEqual(firstRed);
  }, 120_000);
});
