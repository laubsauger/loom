import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/index.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import { graph, node, edge, settings } from "../../examples/documents/builders.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { letterboxRectPreprocessWgsl } from "../../nodes/definitions/inference-node.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { readChannels } from "../../runtime/export/pixel-format.ts";
import { DEPTH_PRO2_BOX, DEPTH_PRO2_BOXES } from "../../runtime/models/depth-runner.ts";

/**
 * T1816b — Depth Pro 2's two GPU halves, on Dawn, exact.
 *
 *  - IN: the rect letterbox. Depth Pro 2 is static 640×480, so a picture is fitted into a
 *    4:3 box, not a square. The rect shader is a second statement of T974's rule, so it is
 *    held to the square shader byte-for-byte on a square box, and to `occOf`'s rect rule on
 *    a 640×480 one, row by row and column by column, from f32 arithmetic mirrored here.
 *  - OUT: the metric stage. The result texel is inverse metres; Near/Far, Near Is Bright,
 *    Output Range and Publish are uniforms. Every value below is exact in rgba16float.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const capabilities: BackendCapabilities = {
  tier: "B", features: [], timestampQuery: false,
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  limits: { maxTextureDimension2D: 8192 },
};
const FRAME = (frameIndex: number, width: number, height: number) => ({
  frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline" as const, randomSeed: 7 },
  pointer: { x: 0, y: 0, buttons: 0 }, resolution: [width, height] as [number, number],
});
const STOPS = [
  { position: 0, color: [0, 0, 0, 1] as [number, number, number, number] },
  { position: 1, color: [1, 1, 1, 1] as [number, number, number, number] },
];

async function dawn() {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  await backend.initialize({});
  return backend;
}

function rampToDepth(rampType: "vertical" | "horizontal", model: string, width: number, height: number, modelInput?: string) {
  const document = graph([
    node("ramp", "ramp", [0, 0], { type: rampType, interp: "linear", phase: 0, period: 1, stops: STOPS }),
    node("depth", "depth", [200, 0], { model, ...(modelInput === undefined ? {} : { modelInput }) }),
    node("out", "output", [400, 0]),
  ], [
    edge("a", ["ramp", "out"], ["depth", "input"]),
    edge("b", ["depth", "out"], ["out", "input"]),
  ]);
  const plan = compileGraph({ graph: document, registry, capabilities,
    settings: settings({ workingFormat: "rgba16float", outputResolution: { width, height } }) });
  expect(plan.ok, JSON.stringify(plan.diagnostics)).toBe(true);
  return plan;
}

async function modelInput(plan: CompiledGraph, width: number, height: number): Promise<Float32Array> {
  const backend = await dawn();
  try {
    const compiled = await backend.compile(plan);
    backend.render(compiled, FRAME(0, width, height));
    return new Float32Array(await backend.readBuffer("scratch:depth:modelInput"));
  } finally { backend.dispose(); }
}

/**
 * The source texel the rect shader reads for box cell `i` on one axis, in WGSL's f32 steps
 * — or `undefined` where the exact coordinate lands ON a texel edge. WGSL does not require
 * a correctly rounded division (2.5 ULP), so at an exact tie the GPU's floor may land on
 * either side; such a cell has no single right answer and is not asserted. The ties are
 * derived from exact rationals, never from the GPU's result, and `expectRegistered` counts
 * them so a rule that made most cells ambiguous could not pass by asserting nothing.
 * Ties beyond either end of the source are not ambiguous: both sides clamp to the edge.
 */
function sourceTexel(i: number, boxLength: number, occ: number, sourceLength: number): number | undefined {
  const f = Math.fround;
  const exact = (((i + 0.5) / boxLength - 0.5) / occ + 0.5) * sourceLength;
  // A tie at or beyond either end clamps to the same edge texel whichever way it rounds.
  if (exact > 0 && exact < sourceLength && Math.abs(exact - Math.round(exact)) < 1e-3) return undefined;
  const uv = f(f(i + 0.5) / boxLength);
  const sourceUv = f(f(f(uv - 0.5) / occ) + 0.5);
  return Math.min(sourceLength - 1, Math.max(0, Math.floor(f(sourceUv * sourceLength))));
}

/** WGSL's own `occ`, in f32: `select(vec2(aspect / boxAspect, 1), vec2(1, boxAspect / aspect), aspect >= boxAspect)`. */
function rectOcc(sourceWidth: number, sourceHeight: number, box: { width: number; height: number } = DEPTH_PRO2_BOX): readonly [number, number] {
  const f = Math.fround;
  const boxAspect = f(box.width / box.height);
  const aspect = f(sourceWidth / sourceHeight);
  return aspect >= boxAspect ? [1, f(boxAspect / aspect)] : [f(aspect / boxAspect), 1];
}

/**
 * Exact registration without knowing the ramp's own values: two neighbouring box cells
 * hold the same value exactly when they read the same source texel, and the ramp rises
 * one step per texel (1/256 is well above rgba16float's step there), so a strictly
 * increasing sequence. A squeeze (occ 1) or a wrong box aspect changes which neighbours
 * are equal, at the bars first.
 */
function expectRegistered(line: readonly number[], texels: ReadonlyArray<number | undefined>) {
  let asserted = 0;
  for (let i = 1; i < line.length; i += 1) {
    const [now, before] = [texels[i], texels[i - 1]];
    if (now === undefined || before === undefined) continue;
    asserted += 1;
    if (now === before) expect(line[i], `cell ${i}`).toBe(line[i - 1]);
    else expect(line[i]!, `cell ${i}`).toBeGreaterThan(line[i - 1]!);
  }
  // 2:1 into 4:3 lands every fifth band row on an edge (0.8·i + 0.4 − 64 texels), so about
  // a quarter of pairs are ties; most of the line must still be asserted.
  expect(asserted).toBeGreaterThan(line.length * 0.6);
}

describe("T1816b — the rect letterbox", () => {
  it("equals the square shader byte for byte on a square box", async () => {
    const square = rampToDepth("vertical", "accurate", 512, 256);
    const preprocess = square.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === "depth");
    if (preprocess?.kind !== "dispatch") throw new Error("no depth preprocess");
    const side = Number((preprocess.uniforms as { side: number }).side);
    const rect: CompiledGraph = { ...square,
      passes: square.passes.map((pass) => pass === preprocess
        ? { ...preprocess, shader: letterboxRectPreprocessWgsl(), uniforms: { width: side, height: side } } : pass) };
    const a = await modelInput(square, 512, 256);
    const b = await modelInput(rect, 512, 256);
    expect(a.length).toBe(side * side * 4);
    expect(Buffer.from(b.buffer).equals(Buffer.from(a.buffer))).toBe(true);
  }, 120_000);

  it("fits a 2:1 picture into 640×480 by rows: bars above and below, full width", async () => {
    const { width: W, height: H } = DEPTH_PRO2_BOX;
    const input = await modelInput(rampToDepth("vertical", "depthpro2-s-fp32", 512, 256), 512, 256);
    expect(input.length).toBe(W * H * 4);
    const [, occY] = rectOcc(512, 256);
    const column = Array.from({ length: H }, (_, y) => input[(y * W + W / 2) * 4]!);
    expectRegistered(column, Array.from({ length: H }, (_, y) => sourceTexel(y, H, occY, 256)));
    // The bars are real: 80 rows each side replicate the edge (a squeeze would have none).
    expect(column[0]).toBe(column[79]);
    expect(column[479]).toBe(column[400]);
    // A vertical ramp is constant along every row.
    const row = Array.from({ length: W }, (_, x) => input[(240 * W + x) * 4]!);
    expect(new Set(row).size).toBe(1);
  }, 120_000);

  it("fits a 1:2 picture into 640×480 by columns: bars left and right, full height", async () => {
    const { width: W } = DEPTH_PRO2_BOX;
    const input = await modelInput(rampToDepth("horizontal", "depthpro2-s-fp32", 256, 512), 256, 512);
    const [occX] = rectOcc(256, 512);
    const row = Array.from({ length: W }, (_, x) => input[(240 * W + x) * 4]!);
    expectRegistered(row, Array.from({ length: W }, (_, x) => sourceTexel(x, W, occX, 256)));
    // 1:2 in a 4:3 box occupies 240 of 640 columns: 200 columns of bar each side.
    expect(row[0]).toBe(row[199]);
    expect(row[639]).toBe(row[440]);
  }, 120_000);
});

describe("T1816b — the 16:9 box", () => {
  it("fits a 16:9 picture into 672×384 with three rows of bar above and below", async () => {
    const box = DEPTH_PRO2_BOXES["672x384"];
    const input = await modelInput(rampToDepth("vertical", "depthpro2-s-stream4-fp32", 512, 288, "672x384"), 512, 288);
    expect(input.length).toBe(box.width * box.height * 4);
    const [, occY] = rectOcc(512, 288, box);
    const column = Array.from({ length: box.height }, (_, y) => input[(y * box.width + box.width / 2) * 4]!);
    expectRegistered(column, Array.from({ length: box.height }, (_, y) => sourceTexel(y, box.height, occY, 288)));
    // 16:9 in 7:4 leaves 384 · (1 − 1.75 / 1.778) ≈ 6 rows of bar: the box is nearly all picture.
    expect(column[0]).toBe(column[2]);
    expect(column[383]).toBe(column[381]);
  }, 120_000);
});

describe("T1816b — the metric result stage", () => {
  async function publish(parameters: Record<string, unknown>, inverse: readonly number[]): Promise<number[]> {
    const document = graph([
      node("image", "solid", [0, 0]),
      node("depth", "depth", [200, 0], { model: "depthpro2-s-fp32", ...parameters }),
      node("copy", "null", [400, 0]),
      node("out", "output", [600, 0]),
    ], [
      edge("a", ["image", "out"], ["depth", "input"]),
      edge("b", ["depth", "out"], ["copy", "in"]),
      edge("c", ["copy", "out"], ["out", "input"]),
    ]);
    const plan = compileGraph({ graph: document, registry, capabilities,
      settings: settings({ workingFormat: "rgba16float", outputResolution: { width: 4, height: 1 } }) });
    expect(plan.ok, JSON.stringify(plan.diagnostics)).toBe(true);
    const result = plan.resources.find((resource) => resource.kind === "externalTexture"
      && resource.sourceId === inferenceSourceIdFor("depth"));
    if (result?.kind !== "externalTexture") throw new Error("Missing depth result texture");
    expect(result.format).toBe("r32float");
    const payload = new Float32Array(result.size[0] * result.size[1]);
    const backend = await dawn();
    try {
      let frameId = 1;
      backend.registerMediaSource(inferenceSourceIdFor("depth"), {
        currentFrame: () => ({ frameId, bytes: new Uint8Array(payload.buffer) }),
      });
      const compiled = await backend.compile(plan);
      const output = plan.outputs.find((entry) => entry.nodeId === "copy");
      if (output === undefined) throw new Error("Missing depth consumer output");
      const samples: number[] = [];
      for (const value of inverse) {
        payload.fill(value);
        backend.render(compiled, FRAME(frameId, 4, 1));
        const image = await backend.readOutput(output.resourceId);
        const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
        const channels = new Float32Array(4);
        readChannels(image.bytes, view, 0, image.format, channels);
        samples.push(channels[0]!);
        frameId += 1;
      }
      return samples;
    } finally { backend.dispose(); }
  }

  // Near 0.5 m (inverse 2), Far 1 m (inverse 1): the span is exactly 1.
  const ROOM = { nearMetres: 0.5, farMetres: 1 };

  it("maps Near..Far by inverse distance to 1..0, clamps both ends, and shows no-result as 0.5", async () => {
    // pending, sky (0), beyond far, far, 1/1.25 m, 1/1.5 m, near, nearer than near
    expect(await publish(ROOM, [-1, 0, 0.5, 1, 1.25, 1.5, 2, 8])).toEqual([0.5, 0, 0, 0, 0.25, 0.5, 1, 1]);
  }, 60_000);

  it("applies Near Is Bright and Output Range after the metric map — but never to no-result", async () => {
    expect(await publish({ ...ROOM, nearIsBright: false }, [-1, 1.25, 2])).toEqual([0.5, 0.75, 0]);
    expect(await publish({ ...ROOM, outputRange: [-1, 2] }, [-1, 1.25, 1.5])).toEqual([0.5, -0.25, 0.5]);
  }, 60_000);

  it("publishes metres capped at Far, ignoring the picture controls", async () => {
    // 1/4 m, 1/2 m, 1 m, beyond far (capped), the sky (capped), pending.
    expect(await publish({ ...ROOM, publish: "metres", nearIsBright: false, outputRange: [-1, 2] },
      [4, 2, 1, 0.5, 0, -1])).toEqual([0.25, 0.5, 1, 1, 1, 0.5]);
  }, 60_000);

  it("moves with Near and Far as uniforms: the same inverse value lands elsewhere", async () => {
    // inverse 1.5 (0.667 m) is the middle of 0.5..1 m and the far end of 0.25..0.667 m.
    expect(await publish({ nearMetres: 0.25, farMetres: 1 / 1.5 }, [1.5, 2.75])).toEqual([0, 0.5]);
  }, 60_000);
});
