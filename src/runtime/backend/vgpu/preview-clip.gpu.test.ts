import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GpuHost, GpuSession } from "./gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { buildPreviewProgram } from "../../previews/program.ts";
import { createTileAtlas } from "../../previews/tile-atlas.ts";
import { DEFAULT_PREVIEW_VIEW } from "../../previews/types.ts";
import type { PreviewFrameCommand, PreviewRect, PreviewRequest } from "../../previews/types.ts";

/**
 * T1102 — A TILE PAINTS ONLY WHERE ITS CLIP SAYS, ON REAL HARDWARE.
 *
 * ## The bug this is the backend half of
 *
 * Node chrome is DOM and stacks by React Flow's z-index; every preview pixel in a graph
 * pane comes from ONE canvas sitting at a single depth in the page (§V106). Two stacking
 * systems that cannot see each other, so a node's preview painted over the node the
 * browser had drawn in front of it — the owner's screenshot, headers layered correctly
 * with the pictures under them layered the other way.
 *
 * A single canvas cannot put a tile UNDER anything. What it can do is decline to paint
 * where a node in front owns the pixels, which is what `PreviewCompositeTile.clip` asks
 * for and what this loop implements as a scissor per surviving piece.
 *
 * ## Why the scissor and the viewport are different rectangles, asserted separately
 *
 * The obvious-looking implementation is to shrink the destination rect, and it is wrong in
 * a way that looks almost right: the viewport is what PLACES and SCALES the picture, so a
 * shrunk one squashes the whole image into the visible sliver instead of showing the part
 * of it that is not covered. That is why the test below does not merely check "fewer
 * pixels painted" — it checks that the pixels which DID paint are byte-identical to the
 * unclipped present at the same coordinates, which is false for every stretch.
 *
 * §V147: exact bytes, no tolerance band. The picture is a display-0.5 grey Solid through
 * an Output, the surface clears transparent, and the question — did this pixel get the
 * blit or not — has no near-miss answer.
 *
 * §V854, the fixture's own ability to fail: the unclipped control is asserted to have
 * painted something other than the clear before any comparison is made against it, so a
 * device that composited nothing at all cannot pass this as a correct occlusion.
 */

/** GPUTextureUsage / GPUBufferUsage as numbers: Dawn's node entry exposes no such global. */
const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const SIZE = 16;
/** Display 0.5 grey: unmistakably not the transparent clear the preview surface starts at. */
const DISPLAY_GREY = 0.5;

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

function settings(): ProjectSettings {
  return {
    outputResolution: { width: SIZE, height: SIZE },
    workingFormat: "rgba8unorm",
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
}

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
      out: {
        id: "out",
        type: "output",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: {},
      },
    },
    edges: {
      e1: {
        id: "e1",
        source: { nodeId: "solid", portId: "out" },
        target: { nodeId: "out", portId: "input" },
      },
    },
    groups: {},
  };
}

interface StubCanvas {
  width: number;
  height: number;
  getContext(kind: string): unknown;
  readonly texture: () => GPUTexture | undefined;
}

/** A canvas the way vgpu's `surface()` uses one. Real device, real texture, no compositor. */
function stubCanvas(device: GPUDevice, width: number, height: number): StubCanvas {
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
    texture: () => texture,
  };
  return canvas;
}

/** Reads an 8-bit-per-channel texture back, unpadding the 256-byte-aligned rows. */
async function readTexture(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: BUFFER_MAP_READ | BUFFER_COPY_DST,
  });
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

/** The Dawn host, with the session kept so the test can allocate its own readback buffers. */
function capturingHost(): { host: GpuHost; session: () => GpuSession | undefined } {
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

const texel = (pixels: Uint8Array, x: number, y: number): number[] => [
  ...pixels.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4),
];

const CLEAR = [0, 0, 0, 0];

describe("T1102 — a preview tile composites only inside its clip (§V106, §V147)", () => {
  it("paints the clipped region unchanged and the covered region not at all", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: solidThroughOutput(),
      settings: settings(),
      registry,
      capabilities: CAPS,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const output = plan.outputs.find((entry) => entry.nodeId === "out");
    if (output === undefined) throw new Error("the Output node materialized no target");

    const { host, session } = capturingHost();
    const backend = createVgpuBackend({ host });
    const errors: string[] = [];
    backend.onDiagnostic((diagnostic) => {
      if (diagnostic.severity === "error") errors.push(`${diagnostic.code}: ${diagnostic.message}`);
    });

    try {
      await backend.initialize({});
      const active = session();
      if (active === undefined) throw new Error("the host produced no session");
      const device = active.gpu.gpu as unknown as GPUDevice;
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [SIZE, SIZE],
      });

      const dest: PreviewRect = { x: 0, y: 0, width: SIZE, height: SIZE };
      const request: PreviewRequest = {
        ref: { nodeId: "out", portId: output.portId },
        source: {
          resourceId: output.resourceId,
          size: output.size,
          format: output.format,
          space: output.space,
        },
        rect: dest,
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

      /** One present onto a fresh surface, compositing this one tile through `clip`. */
      const present = async (clip?: ReadonlyArray<PreviewRect>): Promise<Uint8Array> => {
        const canvas = stubCanvas(device, SIZE, SIZE);
        const handle = backend.previewHost(canvas as never);
        try {
          handle.setPreviewProgram(program);
          const command: PreviewFrameCommand = {
            refresh: program.passes.map((pass) => pass.id),
            composite: [
              {
                ref: request.ref,
                resourceId: program.passes[0]?.target ?? "",
                dest,
                ...(clip === undefined ? {} : { clip }),
              },
            ],
            surface: { size: [SIZE, SIZE], dpr: 1 },
          };
          handle.presentPreviews(command);
          await device.queue.onSubmittedWorkDone();
          const texture = canvas.texture();
          if (texture === undefined) throw new Error("the preview surface was never configured");
          return await readTexture(device, texture, SIZE, SIZE);
        } finally {
          handle.dispose();
        }
      };

      // §V854: the control has to have painted, or "identical to the control" is a claim
      // about two blank surfaces.
      const control = await present();
      expect(texel(control, SIZE / 2, SIZE / 2)).not.toEqual(CLEAR);
      expect(texel(control, 1, 1)).not.toEqual(CLEAR);

      /*
       * A node in front covering the tile's right half. The clip is the LEFT half — what
       * `subtractRects` hands back for exactly this arrangement.
       */
      const clipped = await present([{ x: 0, y: 0, width: SIZE / 2, height: SIZE }]);
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const covered = x >= SIZE / 2;
          expect(texel(clipped, x, y), `(${x},${y}) covered=${String(covered)}`).toEqual(
            covered ? CLEAR : texel(control, x, y),
          );
        }
      }

      /*
       * And the OTHER half, which is what separates a clip from a squashed viewport: a
       * shrunk destination rect would put the whole picture into the visible strip, so the
       * two halves would each contain the entire image and neither would match the control
       * at its own coordinates. Both halves matching the control at their own coordinates
       * is only possible if the picture stayed where it was and the scissor withheld the
       * rest.
       */
      const otherHalf = await present([{ x: SIZE / 2, y: 0, width: SIZE / 2, height: SIZE }]);
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const covered = x < SIZE / 2;
          expect(texel(otherHalf, x, y)).toEqual(covered ? CLEAR : texel(control, x, y));
        }
      }

      // Several pieces, as `subtractRects` emits for a node overlapping the middle: the
      // union paints, the hole does not.
      const holed = await present([
        { x: 0, y: 0, width: 4, height: SIZE },
        { x: 12, y: 0, width: 4, height: SIZE },
      ]);
      expect(texel(holed, 2, 8)).toEqual(texel(control, 2, 8));
      expect(texel(holed, 8, 8)).toEqual(CLEAR);
      expect(texel(holed, 14, 8)).toEqual(texel(control, 14, 8));

      // FULLY covered is an empty array, and it is NOT the same request as "no clip".
      // Flattening the two is how a hidden preview becomes one painted over the node
      // hiding it, so the distinction is asserted rather than assumed.
      const hidden = await present([]);
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) expect(texel(hidden, x, y)).toEqual(CLEAR);
      }

      expect(errors).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 120_000);

  it("clamps a clip that leaves the surface instead of throwing the whole present away", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    /*
     * vgpu mirrors WebGPU's own scissor validation and THROWS when x + width exceeds the
     * attachment — and a throw here takes the entire `PreviewSystem.update()` with it
     * before a single preview state is published, which is exactly the shape of §T756's
     * report (every node reading "no signal", no diagnostic anywhere). A tile straddling
     * the edge of the pane is an ordinary thing to have on screen, so the clamp is not
     * defensive decoration; it is the difference between a partly visible preview and a
     * dead pane.
     */
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: solidThroughOutput(),
      settings: settings(),
      registry,
      capabilities: CAPS,
    });
    const output = plan.outputs.find((entry) => entry.nodeId === "out");
    if (output === undefined) throw new Error("the Output node materialized no target");

    const { host, session } = capturingHost();
    const backend = createVgpuBackend({ host });
    const errors: string[] = [];
    backend.onDiagnostic((diagnostic) => {
      if (diagnostic.severity === "error") errors.push(`${diagnostic.code}: ${diagnostic.message}`);
    });

    try {
      await backend.initialize({});
      const active = session();
      if (active === undefined) throw new Error("the host produced no session");
      const device = active.gpu.gpu as unknown as GPUDevice;
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [SIZE, SIZE],
      });

      const dest: PreviewRect = { x: 0, y: 0, width: SIZE, height: SIZE };
      const request: PreviewRequest = {
        ref: { nodeId: "out", portId: output.portId },
        source: {
          resourceId: output.resourceId,
          size: output.size,
          format: output.format,
          space: output.space,
        },
        rect: dest,
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

      const canvas = stubCanvas(device, SIZE, SIZE);
      const handle = backend.previewHost(canvas as never);
      try {
        handle.setPreviewProgram(program);
        // A piece hanging off the right and bottom edges by half its size, plus one that
        // starts outside entirely — both of which a node dragged past the pane edge makes.
        handle.presentPreviews({
          refresh: program.passes.map((pass) => pass.id),
          composite: [
            {
              ref: request.ref,
              resourceId: program.passes[0]?.target ?? "",
              dest,
              clip: [
                { x: 8, y: 8, width: 100, height: 100 },
                { x: -50, y: -50, width: 20, height: 20 },
              ],
            },
          ],
          surface: { size: [SIZE, SIZE], dpr: 1 },
        });
        await device.queue.onSubmittedWorkDone();
        const texture = canvas.texture();
        if (texture === undefined) throw new Error("the preview surface was never configured");
        const pixels = await readTexture(device, texture, SIZE, SIZE);

        // It survived, and it painted the part of the overhanging piece that is on the
        // surface — the bottom-right quadrant — and nothing outside it.
        expect(errors).toEqual([]);
        expect(texel(pixels, 12, 12)).not.toEqual(CLEAR);
        expect(texel(pixels, 2, 2)).toEqual(CLEAR);
      } finally {
        handle.dispose();
      }
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
