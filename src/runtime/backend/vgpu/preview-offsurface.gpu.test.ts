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
import { DEFAULT_PREVIEW_VIEW, OFF_SURFACE_TILE_RECT } from "../../previews/types.ts";
import type { PreviewFrameCommand, PreviewRequest } from "../../previews/types.ts";

/**
 * A TILE PARKED OFF THE SURFACE COSTS NOTHING AND BREAKS NOTHING (T756).
 *
 * ## What went wrong
 *
 * The owner, on E14-Self-Regulating-Bloom: "still doesn't produce output… NO SIGNAL on all
 * the video texture things… I don't see an error." Every texture node in a 23-node graph
 * read `no signal` while its resolved size and format sat underneath it, the viewer was
 * black, the problems pane said "No problems", and the graph pane eventually died into its
 * error boundary. Nothing was wrong with the document, the compiler or the render: E14's
 * own Dawn gate (`examples/regulation.gpu.test.ts`) was green through all of it.
 *
 * The chain, measured in the running app:
 *
 *  1. E14's Analyze node is a DECLARED sink (§V25), so `outputSlots` synthesizes a
 *     `$target` for it — a full-size texture no pass ever writes, because Analyze's only
 *     pass is a compute dispatch into a buffer.
 *  2. `plan.outputs` is ordered by node id and E14 names them `meter` and `out`, so the
 *     viewer's "first declared sink" rule put `meter:$target` on screen (fixed separately:
 *     `presentsPicture`, compiler/prune.ts).
 *  3. The viewer's choice IS the preview system's `interest`, and Analyze draws no preview
 *     slot on the canvas — so `use-node-previews` took T756's interest-pin branch and
 *     parked the tile at `OFF_SURFACE_TILE_RECT`, exactly as designed.
 *  4. A pinned tile is kept ACTIVE by the scheduler, so it reached this composite loop,
 *     which multiplied the rect by the device pixel ratio and handed vgpu a viewport at
 *     x = -200000. vgpu bounds a viewport to ±(2 · maxTextureDimension2D) and threw.
 *  5. The throw came out of `PreviewSystem.update()` BEFORE it published a single preview
 *     state — which is why every node in the graph said `no signal` and no diagnostic was
 *     produced anywhere: the failure was an exception, not a report.
 *
 * ## What this gate asserts
 *
 * The parked tile is DROPPED, and dropping it changes nothing else: the surface carries the
 * same bytes it carries when the parked tile is not there at all. Byte-exact against the
 * control present, never a tolerance (§V147) — this is a "did the encoder run" question,
 * and a near-miss answer to it would be a different bug.
 *
 * §V854: the fixture must be able to fail. The parking rect is asserted to be genuinely
 * outside vgpu's viewport bound first, so this cannot pass because the number drifted
 * somewhere legal, and the on-surface tile is asserted to have painted something other
 * than the surface's clear, so it cannot pass on a device that composited nothing at all.
 */

/** GPUTextureUsage / GPUBufferUsage as numbers: Dawn's node entry exposes no such global. */
const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const SIZE = 8;
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

describe("T756 — a preview tile parked off the surface (§V28b, §V8)", () => {
  it("is skipped, and the tiles that ARE on the surface composite unchanged", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    // §V854's first precondition, asserted rather than assumed: the parking rect really is
    // outside what vgpu will accept as a viewport, at dpr 1 and above. If this ever stops
    // being true the test below can no longer fail and must be rewritten, not deleted.
    const maxDimension = CAPS.limits.maxTextureDimension2D;
    expect(maxDimension).toBeGreaterThan(0);
    const viewportBound = (maxDimension ?? 0) * 2;
    expect(OFF_SURFACE_TILE_RECT.x).toBeLessThan(-viewportBound);
    expect(OFF_SURFACE_TILE_RECT.y).toBeLessThan(-viewportBound);

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

      const request: PreviewRequest = {
        ref: { nodeId: "out", portId: output.portId },
        source: {
          resourceId: output.resourceId,
          size: output.size,
          format: output.format,
          space: output.space,
        },
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

      /** One present, on its own fresh surface, compositing exactly these tiles. */
      const present = async (
        tiles: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
      ): Promise<Uint8Array> => {
        const canvas = stubCanvas(device, SIZE, SIZE);
        const handle = backend.previewHost(canvas as never);
        try {
          handle.setPreviewProgram(program);
          const command: PreviewFrameCommand = {
            refresh: program.passes.map((pass) => pass.id),
            composite: tiles.map((dest) => ({
              ref: request.ref,
              resourceId: program.passes[0]?.target ?? "",
              dest,
            })),
            // dpr 2 is what the report came from: the parking rect is illegal at dpr 1 too,
            // and doubling it is how the owner's console got to "x -200000 with width 2".
            surface: { size: [SIZE, SIZE], dpr: 2 },
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

      const onSurface = { x: 0, y: 0, width: SIZE, height: SIZE };
      const control = await present([onSurface]);
      // The premise for the comparison below: the on-surface tile painted the picture, so
      // "same as the control" is a claim about a surface with something on it (§V854).
      const centre = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
      expect([...control.subarray(centre, centre + 4)]).not.toEqual([0, 0, 0, 0]);

      // The case: the SAME on-surface tile, with the parked one alongside it. Before the
      // skip, this call threw `Invalid viewport: x -200000 with width 2` and the caller —
      // `PreviewSystem.update()` — never published a preview state again.
      const withParked = await present([onSurface, { ...OFF_SURFACE_TILE_RECT }]);
      expect([...withParked]).toEqual([...control]);
      expect(errors).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
