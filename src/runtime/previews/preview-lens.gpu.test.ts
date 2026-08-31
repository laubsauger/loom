import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
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
  it("masks G and B by VALUE PUSH alone: same program object, different picture", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({ graph: solidThroughOutput(), settings: SETTINGS, registry, capabilities: CAPS });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const output = plan.outputs.find((entry) => entry.nodeId === "out");
    if (output === undefined) throw new Error("the Output node materialized no target");

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
      if (diagnostic.severity === "error") errors.push(`${diagnostic.code}: ${diagnostic.message}`);
    });
    try {
      await backend.initialize({});
      const device = captured?.gpu.gpu as GPUDevice;
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [SIZE, SIZE],
      });

      const previewCanvas = stubCanvas(device, SIZE, SIZE);
      const handle = backend.previewHost(previewCanvas as never);
      const request: PreviewRequest = {
        ref: { nodeId: "out", portId: output.portId },
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
        uniforms,
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
      expect(await centre()).toEqual([ENCODED_BYTE, ENCODED_BYTE, ENCODED_BYTE, 255]);

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
      expect(await centre()).toEqual([0, 0, ENCODED_BYTE, 255]); // BGRA: red survives, G/B exactly zero

      expect(errors).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
