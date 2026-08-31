import { DEFAULT_PREVIEW_VIEW } from "../../previews/types.ts";
import type { PreviewRequest } from "../../previews/types.ts";
import { buildPreviewProgram } from "../../previews/program.ts";
import { createTileAtlas } from "../../previews/tile-atlas.ts";
import type { GpuHost, GpuSession } from "./gpu-host.ts";
import { nodeGpuHost } from "./node-gpu-host.ts";
import type { ResolvedOutput } from "../../../compiler/types.ts";

/**
 * Shared Dawn-test plumbing for SYNTHESIZED previews (T563).
 *
 * The splat and stock-scene passes live in the PREVIEW PROGRAM now, so a gate that wants
 * their pixels must drive the preview host the way the editor does: build the program
 * from the output row's `synthesis`, install it, and present a refresh naming the
 * synthesis passes. `backend.readOutput(previewId)` then reads the program-owned target
 * (the backend resolves preview-set targets for readback), so the assertions the gates
 * make against raw target bytes are unchanged from when the target lived in the plan.
 */

const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;

export interface StubCanvas {
  width: number;
  height: number;
  getContext(kind: string): unknown;
}

/** A canvas the way vgpu's `surface()` uses one — real device, no compositor. */
export function stubCanvas(device: GPUDevice, width: number, height: number): StubCanvas {
  let texture: GPUTexture | undefined;
  const canvas: StubCanvas = {
    width,
    height,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        configure(config: { format: string }) {
          texture?.destroy();
          texture = device.createTexture({
            size: [canvas.width, canvas.height],
            format: config.format as GPUTextureFormat,
            usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC,
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          return texture;
        },
      };
    },
  };
  return canvas;
}

/** The Dawn host, with the session kept so tests can reach the raw device. */
export function capturingHost(): { host: GpuHost; session: () => GpuSession | undefined } {
  const base = nodeGpuHost();
  let captured: GpuSession | undefined;
  return {
    host: {
      label: base.label,
      async create(options) {
        captured = await base.create(options);
        return captured;
      },
    },
    session: () => captured,
  };
}

interface SynthesisBackend {
  previewHost(canvas: unknown): {
    setPreviewProgram(program: unknown): void;
    presentPreviews(command: unknown): void;
    dispose(): void;
  };
}

/**
 * Installs a preview program for one synthesized output and encodes its draw passes
 * once, at `tileEdge`. Call AFTER `backend.render` has filled the point storage the
 * passes bind. Returns the handle so a test can present again (or dispose early;
 * `backend.dispose()` covers it otherwise).
 */
export function drawSynthesizedPreview(options: {
  readonly backend: SynthesisBackend;
  readonly device: GPUDevice;
  readonly outputs: ReadonlyArray<ResolvedOutput>;
  readonly nodeId: string;
  readonly portId: string;
  readonly tileEdge: number;
}): { previewId: string; present(uniforms?: ReadonlyArray<{ passId: string; values: unknown }>): void; dispose(): void } {
  const row = options.outputs.find(
    (output) => output.nodeId === options.nodeId && output.portId === options.portId,
  );
  if (row?.synthesis === undefined) {
    throw new Error(`no synthesized preview on ${options.nodeId}:${options.portId}`);
  }
  const synthesis = row.synthesis;
  const request: PreviewRequest = {
    ref: { nodeId: row.nodeId, portId: row.portId },
    source: { resourceId: row.resourceId, size: row.size, format: row.format, space: row.space },
    rect: { x: 0, y: 0, width: options.tileEdge, height: options.tileEdge },
    area: { width: options.tileEdge, height: options.tileEdge },
    view: DEFAULT_PREVIEW_VIEW,
    visible: true,
    pinned: false,
    collapsed: false,
    occluded: false,
    synthesis,
  };
  const program = buildPreviewProgram(
    [{ ref: request.ref, request, tileSize: [options.tileEdge, options.tileEdge] }],
    createTileAtlas({ capacity: 4 }),
  );
  const handle = options.backend.previewHost(
    stubCanvas(options.device, options.tileEdge, options.tileEdge) as never,
  );
  handle.setPreviewProgram(program);
  const present = (uniforms?: ReadonlyArray<{ passId: string; values: unknown }>): void => {
    handle.presentPreviews({
      refresh: synthesis.passes.map((pass) => pass.id),
      composite: [],
      ...(uniforms === undefined ? {} : { uniforms }),
      surface: { size: [options.tileEdge, options.tileEdge], dpr: 1 },
    });
  };
  present();
  return { previewId: row.resourceId, present, dispose: () => handle.dispose() };
}
