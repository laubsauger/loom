import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { floatMapSourceIdFor } from "../../nodes/definitions/float-map-in.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import { nodeGpuHost, probeDawn } from "../backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../backend/vgpu/vgpu-backend.ts";
import { buildPreviewProgram } from "./program.ts";
import { createTileAtlas } from "./tile-atlas.ts";
import { previewUniforms } from "./debug-effects.ts";
import { DEFAULT_PREVIEW_VIEW } from "./types.ts";
import type { PreviewFrameCommand, PreviewRequest } from "./types.ts";

/**
 * B118's GATE, at the pixel: a lens value pushed on the per-frame command reaches the
 * GPU **without a program rebuild**.
 *
 * WHAT B118 WAS. The preview program's `signature` excludes uniform values by
 * construction (§V5), the host rebuilds only on a signature change, and
 * `updateUniforms` resolves against the MAIN program only — so `previewUniforms(view)`
 * was recomputed correctly on every tick and handed to a program object nobody ever
 * uploaded. Exposure, channel mask, tonemap, checker size and signed scale had never
 * reached the GPU: two individually-correct halves with nothing joining them (§V220).
 * `system.test.ts` pins the push half in the small; this proves the write lands, on
 * Dawn, through the same `presentPreviews` the editor calls.
 *
 * The probe value is the channel MASK because it needs no tolerance: display 0.5 grey
 * encodes to byte 127 exactly, and a mask that zeroes G and B turns (127,127,127) into
 * (127,0,0) — bytes that cannot be produced by rounding drift.
 */

const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const SIZE = 8;
const DISPLAY_GREY = 0.5;
const ENCODED_BYTE = 127;

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const CAPS: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

function solidThroughOutput(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: {
        id: "solid",
        type: "solid",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { color: [DISPLAY_GREY, DISPLAY_GREY, DISPLAY_GREY, 1] },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

interface StubCanvas {
  width: number;
  height: number;
  getContext(kind: string): unknown;
  readonly texture: () => GPUTexture | undefined;
  readonly format: () => string;
}

/** A canvas the way vgpu's `surface()` uses one — same shape as present-parity's. */
function stubCanvas(device: GPUDevice, width: number, height: number): StubCanvas {
  let texture: GPUTexture | undefined;
  let format = "bgra8unorm";
  const canvas: StubCanvas = {
    width,
    height,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        configure(config: { format: string }) {
          format = config.format;
          texture?.destroy();
          texture = device.createTexture({
            size: [canvas.width, canvas.height],
            format: format as GPUTextureFormat,
            usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC,
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          return texture;
        },
      };
    },
    texture: () => texture,
    format: () => format,
  };
  return canvas;
}

async function readTexture(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_MODE_READ);
  const mapped = new Uint8Array(buffer.getMappedRange()).slice();
  buffer.unmap();
  buffer.destroy();
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  }
  return out;
}

describe("B118 — a pushed lens value reaches the preview pixel without a rebuild", () => {
  it.each(["rgba16float", "r32float"] as const)("%s previews and masks G and B by VALUE PUSH alone", async format => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const graph = solidThroughOutput();
    if (format === "r32float") {
      graph.nodes["solid"]!.type = "floatMapIn";
      graph.nodes["solid"]!.parameters = { interpretation: "raw" };
      delete graph.nodes["out"];
      graph.edges = {};
    }
    const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPS,
      sinks: [{ nodeId: format === "r32float" ? "solid" : "out", portId: "out", kind: "readback" }],
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const output = plan.outputs.find((entry) => entry.nodeId === (format === "r32float" ? "solid" : "out"));
    if (output === undefined) throw new Error("the preview source materialized no target");

    let captured: { gpu: { gpu: unknown } } | undefined;
    const base = nodeGpuHost();
    const backend = createVgpuBackend({
      host: {
        label: base.label,
        async create(options) {
          const session = await base.create(options);
          captured = session as never;
          return session;
        },
      },
    });
    const errors: string[] = [];
    backend.onDiagnostic((diagnostic) => {
      if (diagnostic.severity !== "info") errors.push(`${diagnostic.code}: ${diagnostic.message}`);
    });
    try {
      await backend.initialize({});
      const device = captured?.gpu.gpu as GPUDevice;
      const compiled = await backend.compile(plan);
      if (format === "r32float") {
        expect(device.features.has("float32-filterable")).toBe(false);
        const values = new Float32Array(SIZE * SIZE).fill(DISPLAY_GREY);
        values[0] = 0;
        values[values.length - 1] = 1;
        backend.registerMediaSource(floatMapSourceIdFor("solid"), {
          currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(values.buffer) }), ended: true,
        });
      }
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [SIZE, SIZE],
      });

      const previewCanvas = stubCanvas(device, SIZE, SIZE);
      const handle = backend.previewHost(previewCanvas as never);
      const encodedByte = format === "r32float" ? 188 : ENCODED_BYTE;
      const request: PreviewRequest = {
        ref: { nodeId: output.nodeId, portId: output.portId },
        source: { resourceId: output.resourceId, size: output.size, format: output.format, space: output.space },
        rect: { x: 0, y: 0, width: SIZE, height: SIZE },
        area: { width: SIZE, height: SIZE },
        view: DEFAULT_PREVIEW_VIEW,
        visible: true,
        collapsed: false,
        occluded: false,
        pinned: false,
      };
      const program = buildPreviewProgram(
        [{ ref: request.ref, request, tileSize: [SIZE, SIZE] }],
        createTileAtlas({ capacity: 4 }),
      );
      handle.setPreviewProgram(program);
      const passId = program.passes[0]?.id;
      if (passId === undefined) throw new Error("the preview program emitted no pass");

      const command = (uniforms?: PreviewFrameCommand["uniforms"]): PreviewFrameCommand => ({
        refresh: [passId],
        composite: [
          { ref: request.ref, resourceId: program.passes[0]?.target ?? "", dest: { x: 0, y: 0, width: SIZE, height: SIZE } },
        ],
        ...(uniforms === undefined ? {} : { uniforms }),
        surface: { size: [SIZE, SIZE], dpr: 1 },
      });
      const centre = async (): Promise<readonly number[]> => {
        await device.queue.onSubmittedWorkDone();
        const texture = previewCanvas.texture();
        if (texture === undefined) throw new Error("the preview surface was never configured");
        const bytes = await readTexture(device, texture, SIZE, SIZE);
        const at = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
        return [...bytes.subarray(at, at + 4)];
      };
      expect(previewCanvas.format()).toBe("bgra8unorm"); // so the byte order below is B,G,R,A

      // The default lens: display 0.5 grey, byte-exact.
      handle.presentPreviews(command());
      expect(errors).toEqual([]);
      expect(await centre()).toEqual([encodedByte, encodedByte, encodedByte, 255]);
      if (format === "r32float") {
        const texture = previewCanvas.texture();
        if (texture === undefined) throw new Error("the scalar preview surface was not configured");
        const bytes = await readTexture(device, texture, SIZE, SIZE);
        expect([...bytes.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
        expect([...bytes.subarray(bytes.length - 4)]).toEqual([255, 255, 255, 255]);
      }

      // The push. NO setPreviewProgram call happens here — the same program object the
      // host already holds must show a different picture, or the lens controls are dead.
      handle.presentPreviews(
        command([
          {
            passId,
            values: previewUniforms({ ...DEFAULT_PREVIEW_VIEW, channels: { r: true, g: false, b: false, a: true } }),
          },
        ]),
      );
      expect(await centre()).toEqual([0, 0, encodedByte, 255]); // BGRA: red survives, G/B exactly zero

      if (format === "r32float") {
        // Grayscale is a display choice; channel isolation still inspects the real
        // r32float channels (r, 0, 0, 1), rather than fabricated G/B values.
        for (const channel of ["r", "g", "b", "a"] as const) {
          const isolated = { ...request, view: { ...DEFAULT_PREVIEW_VIEW, mode: "channel" as const, channel } };
          handle.setPreviewProgram(buildPreviewProgram(
            [{ ref: isolated.ref, request: isolated, tileSize: [SIZE, SIZE] }],
            createTileAtlas({ capacity: 4 }),
          ));
          handle.presentPreviews(command([{ passId, values: previewUniforms(isolated.view) }]));
          const value = channel === "r" ? encodedByte : channel === "a" ? 255 : 0;
          expect(await centre(), channel).toEqual([value, value, value, 255]);
        }
      }
      expect(errors).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});

/**
 * Owner 2026-11-22 — a depth map's preview through a COLOUR MAP, on Dawn.
 *
 * A float map holding 0..1 across 64 texels, previewed through each map; every pixel must be
 * the CPU table's colour (`colormapRgb`, the one the photo surface draws with) to within one
 * 8-bit step. That step is the whole tolerance: the GPU evaluates the same polynomial or stop
 * table in f32 against the CPU's f64, and both round to 8 bits once. It is how the preview
 * and the photo surface stay the same Turbo.
 */
describe("the colour-map lens on Dawn", () => {
  it.each(["turbo", "spectral", "viridis", "inferno"] as const)("%s: every pixel is the shared table's colour", async (id) => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const { colormapIndex, colormapRgb } = await import("../../domain/color/colormaps.ts");
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const graph = solidThroughOutput();
    graph.nodes["solid"]!.type = "floatMapIn";
    graph.nodes["solid"]!.parameters = { interpretation: "raw" };
    delete graph.nodes["out"];
    graph.edges = {};
    const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPS,
      sinks: [{ nodeId: "solid", portId: "out", kind: "readback" }] });
    const output = plan.outputs.find((entry) => entry.nodeId === "solid");
    if (output === undefined) throw new Error("the preview source materialized no target");
    let captured: { gpu: { gpu: unknown } } | undefined;
    const base = nodeGpuHost();
    const backend = createVgpuBackend({ host: { label: base.label, async create(options) {
      const session = await base.create(options); captured = session as never; return session;
    } } });
    const errors: string[] = [];
    backend.onDiagnostic((diagnostic) => { if (diagnostic.severity !== "info") errors.push(`${diagnostic.code}: ${diagnostic.message}`); });
    try {
      await backend.initialize({});
      const device = captured?.gpu.gpu as GPUDevice;
      const compiled = await backend.compile(plan);
      const values = Float32Array.from({ length: SIZE * SIZE }, (_, index) => index / (SIZE * SIZE - 1));
      backend.registerMediaSource(floatMapSourceIdFor("solid"), {
        currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(values.buffer) }), ended: true,
      });
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 }, resolution: [SIZE, SIZE],
      });
      const previewCanvas = stubCanvas(device, SIZE, SIZE);
      const handle = backend.previewHost(previewCanvas as never);
      const view = { ...DEFAULT_PREVIEW_VIEW, mode: "colormap" as const, colormap: colormapIndex(id), colormapLuminance: true };
      const request: PreviewRequest = {
        ref: { nodeId: output.nodeId, portId: output.portId },
        source: { resourceId: output.resourceId, size: output.size, format: output.format, space: output.space },
        rect: { x: 0, y: 0, width: SIZE, height: SIZE }, area: { width: SIZE, height: SIZE },
        view, visible: true, collapsed: false, occluded: false, pinned: false,
      };
      const program = buildPreviewProgram([{ ref: request.ref, request, tileSize: [SIZE, SIZE] }], createTileAtlas({ capacity: 4 }));
      handle.setPreviewProgram(program);
      const passId = program.passes[0]!.id;
      handle.presentPreviews({
        refresh: [passId],
        composite: [{ ref: request.ref, resourceId: program.passes[0]!.target, dest: { x: 0, y: 0, width: SIZE, height: SIZE } }],
        uniforms: [{ passId, values: previewUniforms(view) }],
        surface: { size: [SIZE, SIZE], dpr: 1 },
      });
      await device.queue.onSubmittedWorkDone();
      const bytes = await readTexture(device, previewCanvas.texture()!, SIZE, SIZE);
      expect(previewCanvas.format()).toBe("bgra8unorm");
      for (let index = 0; index < SIZE * SIZE; index += 1) {
        const [r, g, b] = colormapRgb(id, values[index]!).map((value) => Math.round(value * 255));
        const [pb, pg, pr, pa] = bytes.subarray(index * 4, index * 4 + 4);
        for (const [got, want, name] of [[pr, r, "r"], [pg, g, "g"], [pb, b, "b"]] as const) {
          expect(Math.abs(got! - want!), `${id} texel ${index} ${name}: ${got} vs ${want}`).toBeLessThanOrEqual(1);
        }
        expect(pa).toBe(255);
      }
      // Not grey: the map is doing something (a lost lens would draw r = g = b). Mid-ramp,
      // because Inferno's low end IS black.
      const [midB, midG, midR] = bytes.subarray(32 * 4, 32 * 4 + 3);
      expect(new Set([midR, midG, midB]).size).toBeGreaterThan(1);
      expect(errors).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
