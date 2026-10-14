import { beforeAll, expect, it } from "vitest";
import { compileGraph } from "@compiler/compile.ts";
import { DEFAULT_COLOR_POLICY, DEFAULT_PROJECT_SETTINGS, type GraphDocument, type ProjectSettings } from "@domain/types/graph.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { linearToSrgb, srgbToLinear } from "@runtime/export/pixel-format.ts";
import type { GpuSession } from "@runtime/backend/vgpu/gpu-host.ts";
import { nodeGpuHost, probeDawn } from "@runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "@runtime/backend/vgpu/vgpu-backend.ts";
import { attachNativeOutput, nativeOutputEncodes, nativeOutputSelection } from "./native-output.ts";

/**
 * VNB25 — a native output (Syphon / NDI / Spout Out) sends what the Output node shows.
 *
 * THE BUG (owner, 2026-10-14, stage-previz-14): Syphon Out presents the texture wired into
 * it, and in a working-space graph that texture holds LINEAR light. The presentation blit
 * was a raw copy, so every receiver showed mids ~gamma 2.2 too dark: linear 0.5 left as
 * byte 128 where the Output node's display encode gives 188. T1349's self-loop proof used
 * a Checker, whose 0 and 1 survive any transfer curve.
 *
 * Through the real stack: the real compiler publishes the source's space, the native
 * output's own selection (`nativeOutputSelection`, the hook's) decides the encode from it,
 * `attachNativeOutput` presents it on a real vgpu surface on Dawn, and the bytes are read
 * back out of that surface texture — the bytes the session hands the publisher as a
 * bitmap. Values are analytic (§V147), never banded.
 *
 * NOT covered: the canvas → ImageBitmap → IOSurface → Syphon server hop and a receiver.
 */

const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;
const SIZE = 8;

/** Display value whose linear light is 0.5: the Solid's colour picker is display space. */
const LINEAR_HALF_AS_DISPLAY = linearToSrgb(0.5);
/** sRGB encode of linear 0.5 (0.735357…), as an 8-bit surface byte. */
const ENCODED_HALF = Math.round(255 * linearToSrgb(0.5));

let dawnError: string | undefined;
beforeAll(async () => { dawnError = (await probeDawn()).error; }, 60_000);

const CAPS: BackendCapabilities = { tier: "B", features: [], formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float"],
  timestampQuery: false, limits: { maxTextureDimension2D: 8192 } };

function settings(workingFormat: ProjectSettings["workingFormat"]): ProjectSettings {
  return { ...DEFAULT_PROJECT_SETTINGS, workingFormat, outputResolution: { width: SIZE, height: SIZE } };
}

/**
 * solid → syphon_solid, solid → ndi_solid, solid → output. No `data` source: a native
 * output's input is an RGBA texture and a data texture is refused at the wire (§V13), so
 * the `data` row of the decision is covered where it is decided (`native-output.test.ts`).
 */
function graph(): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown> = {}) =>
    ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters }) as GraphDocument["nodes"][string];
  const edge = (id: string, source: string, target: string) =>
    ({ id, source: { nodeId: source, portId: "out" }, target: { nodeId: target, portId: "input" } });
  const v = LINEAR_HALF_AS_DISPLAY;
  return { revision: 1, groups: {}, nodes: {
    solid_half: node("solid_half", "solid", { color: [v, v, v, 1] }),
    syphon_solid: node("syphon_solid", "syphonOut", { name: "solid" }),
    ndi_solid: node("ndi_solid", "ndiOut", { name: "solid" }),
    output_main: node("output_main", "output"),
  }, edges: {
    a: edge("a", "solid_half", "syphon_solid"),
    b: edge("b", "solid_half", "output_main"),
    c: edge("c", "solid_half", "ndi_solid"),
  } };
}

function stubCanvas(device: GPUDevice) {
  let texture: GPUTexture | undefined;
  const canvas = {
    width: SIZE, height: SIZE,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        configure(config: { format: string }) {
          texture?.destroy();
          texture = device.createTexture({ size: [canvas.width, canvas.height], format: config.format as GPUTextureFormat,
            usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC });
        },
        unconfigure() {},
        getCurrentTexture: () => texture,
      };
    },
    texture: () => texture,
  };
  return canvas;
}

async function readTexture(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const bytesPerRow = 256;
  const buffer = device.createBuffer({ size: bytesPerRow * SIZE, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width: SIZE, height: SIZE });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_MODE_READ);
  const mapped = new Uint8Array(buffer.getMappedRange()).slice();
  buffer.unmap(); buffer.destroy();
  const out = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + SIZE * 4), y * SIZE * 4);
  return out;
}

/** Compiles `graph()` for one working format and reads each native presentation's surface. */
async function publish(workingFormat: ProjectSettings["workingFormat"]) {
  const plan = compileGraph({ graph: graph(), registry: createNodeRegistry(allNodeDefinitions).view(), capabilities: CAPS,
    settings: settings(workingFormat) });
  expect(plan.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  let session: GpuSession | undefined;
  const host = nodeGpuHost();
  const backend = createVgpuBackend({ host: { label: host.label, async create(options) {
    session = await host.create(options); return session;
  } } });
  const errors: string[] = [];
  backend.onDiagnostic(d => { if (d.severity === "error") errors.push(d.message); });
  const canvases: Array<ReturnType<typeof stubCanvas>> = [];
  try {
    await backend.initialize({});
    if (session === undefined) throw new Error("No GPU session");
    const device = session.gpu.gpu as GPUDevice;
    const compiled = await backend.compile(plan);
    const doc = graph();
    // The hook's own selection: only demanded native sinks publish.
    for (const id of ["syphon_solid", "ndi_solid"]) expect(plan.order).toContain(id);
    const outputRow = plan.outputs.find(row => row.nodeId === "output_main");
    if (outputRow === undefined) throw new Error("Output target missing");
    const selections = {
      syphonSolid: nativeOutputSelection(doc, "syphon_solid", plan.outputs, DEFAULT_COLOR_POLICY),
      ndiSolid: nativeOutputSelection(doc, "ndi_solid", plan.outputs, DEFAULT_COLOR_POLICY),
      // The Output node's own target, `encoded`: a native output of it must not encode again.
      output: { resourceId: outputRow.resourceId, size: outputRow.size, encode: nativeOutputEncodes(outputRow, DEFAULT_COLOR_POLICY) },
    };
    const attached: Record<string, ReturnType<typeof attachNativeOutput>> = {};
    const surfaces = Object.fromEntries(Object.entries(selections).map(([key, selection]) => {
      if (selection === null) throw new Error(`${key} selected nothing`);
      const canvas = stubCanvas(device); canvases.push(canvas);
      attached[key] = attachNativeOutput(backend, selection, canvas as never);
      return [key, canvas];
    })) as Record<keyof typeof selections, ReturnType<typeof stubCanvas>>;
    const render = async (frameIndex: number) => {
      backend.render(compiled, { frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 }, resolution: [SIZE, SIZE] });
      await device.queue.onSubmittedWorkDone();
    };
    const read = async (key: keyof typeof selections) => {
      const texture = surfaces[key].texture();
      if (texture === undefined) throw new Error(`${key} surface unconfigured`);
      return readTexture(device, texture);
    };
    await render(0);
    const bytes: Record<string, Uint8Array> = {};
    for (const key of Object.keys(surfaces) as Array<keyof typeof selections>) bytes[key] = await read(key);
    // The in-place swap a change of encode makes (a rewire, a display-transform setting):
    // the same canvas, a new presentation, and a frame count that keeps climbing.
    const frames = [attached["syphonSolid"]!.presentedFrames()];
    attached["syphonSolid"]!.update({ ...selections.syphonSolid!, encode: false });
    await render(1);
    frames.push(attached["syphonSolid"]!.presentedFrames());
    bytes["syphonSolidRaw"] = await read("syphonSolid");
    expect(errors).toEqual([]);
    return { plan, selections, bytes, frames };
  } finally {
    backend.dispose();
    for (const canvas of canvases) canvas.texture()?.destroy();
  }
}

/** Pixel (x, 2) as [r, g, b, a] from a bgra8unorm surface. */
const rgbaAt = (bytes: Uint8Array, x: number) => {
  const i = (2 * SIZE + x) * 4;
  return [bytes[i + 2]!, bytes[i + 1]!, bytes[i]!, bytes[i + 3]!];
};

it("Syphon Out of a linear 0.5 source publishes the Output node's 188, not the raw 128 (rgba16float)", async () => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const { plan, selections, bytes, frames } = await publish("rgba16float");
  const solid = plan.outputs.find(row => row.nodeId === "solid_half")!;
  expect([solid.format, solid.space]).toEqual(["rgba16float", "linear"]);
  expect(selections.syphonSolid?.encode).toBe(true);
  // §V147: srgbToLinear(linearToSrgb(0.5)) lands on half 0.5 exactly, encoded back to 188.
  expect(srgbToLinear(LINEAR_HALF_AS_DISPLAY)).toBeCloseTo(0.5, 12);
  expect(ENCODED_HALF).toBe(188);
  for (const x of [0, 3, 7]) expect(rgbaAt(bytes["syphonSolid"]!, x)).toEqual([188, 188, 188, 255]);
  // Swapped in place to the raw copy: the pre-VNB25 bytes, linear 0.5 as 127.5 rounded.
  expect([127, 128]).toContain(rgbaAt(bytes["syphonSolidRaw"]!, 3)[0]);
  expect(frames[1]).toBeGreaterThan(frames[0]!);
  // What the Output node shows for the same input, and a native output of THAT: one picture.
  expect(selections.output.encode).toBe(false);
  for (const x of [0, 3, 7]) expect(rgbaAt(bytes["output"]!, x)).toEqual([188, 188, 188, 255]);
  // NDI Out shares the path: the same source, the same picture.
  expect(selections.ndiSolid?.encode).toBe(true);
  for (const x of [0, 3, 7]) expect(rgbaAt(bytes["ndiSolid"]!, x)).toEqual([188, 188, 188, 255]);
}, 60_000);

it("an rgba8unorm-srgb source is already display bytes on the native surface: 188, never encoded twice", async () => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const { plan, selections, bytes } = await publish("rgba8unorm-srgb");
  const solid = plan.outputs.find(row => row.nodeId === "solid_half")!;
  expect([solid.format, solid.space]).toEqual(["rgba8unorm-srgb", "linear"]);
  expect(selections.syphonSolid?.encode).toBe(false);
  expect(selections.ndiSolid?.encode).toBe(false);
  for (const key of ["syphonSolid", "ndiSolid", "output"])
    for (const x of [0, 3, 7]) expect(rgbaAt(bytes[key]!, x)).toEqual([188, 188, 188, 255]);
}, 60_000);
