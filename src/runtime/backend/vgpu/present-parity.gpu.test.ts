import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { CompilerDiagnosticCode } from "../../../compiler/diagnostics.ts";
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
import type { PreviewFrameCommand, PreviewRequest } from "../../previews/types.ts";
import { toRgba8 } from "../../export/image.ts";

/**
 * B47's GATE: the node PREVIEW tile, the VIEWER and the exported FILE are the same picture,
 * byte for byte (T375, §V56, §V57, §V70a).
 *
 * WHAT B47 WAS. Three surfaces show the same texture and each one decided for itself
 * whether it still owed the picture a display encode: the preview shader always encoded,
 * the exporter derived an answer from the pixel FORMAT, and the present blit never encoded
 * at all because §V70a says it is a raw copy. §V70a is right — the encode belongs to the
 * Output node — but nothing ever read `colorPolicy.displayTransform`, so no node did it.
 * MEASURED on Dawn before the fix, one Solid at display 0.5 grey through one Output node:
 *
 *   working format   preview   viewer   export
 *   rgba16float        127       55       127
 *   rgba8unorm         128       55        55
 *   rgba8unorm-srgb    127       54       127
 *
 * Two different answers in the default configuration and a third one project setting away.
 *
 * WHY THIS TEST IS SHAPED LIKE THIS. §V220: a test that supplies the wiring it checks
 * proves nothing. So nothing here is hand-fed a colour space — the document goes through
 * the real compiler, the surfaces are real vgpu surfaces on a real Dawn device, the preview
 * program is the real `buildPreviewProgram`, and every path reads the space the COMPILER
 * published. The three numbers compared come back out of GPU memory: two from the actual
 * presented surface textures, one from the actual export encoder.
 *
 * WHAT IT DOES NOT COVER: the compositor. `getPreferredCanvasFormat` is `bgra8unorm` here
 * and in every browser (the spec allows only `bgra8unorm` and `rgba8unorm` — never an srgb
 * variant), so "the same bytes reach all three surfaces" is what is asserted; that a
 * monitor then shows them identically is a claim about the OS, not about this code.
 */

/** GPUTextureUsage / GPUBufferUsage as numbers: Dawn's node entry exposes no such global. */
const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const SIZE = 8;

/**
 * Display 0.5 grey — the most diagnostic value there is. Linear 0.21404, encoded 0.5: a
 * path that skips the transfer lands on byte 55 and one that applies it lands on 127, so
 * no rounding tolerance is needed to tell them apart, and none is used.
 */
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

function settings(workingFormat: ProjectSettings["workingFormat"]): ProjectSettings {
  return {
    outputResolution: { width: SIZE, height: SIZE },
    workingFormat,
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
  /** The live surface texture, so the test can read what was actually presented. */
  readonly texture: () => GPUTexture | undefined;
  readonly format: () => string;
}

/**
 * A canvas the way vgpu's `surface()` uses one: `getContext("webgpu")`, `configure`,
 * `getCurrentTexture`. Real device, real texture, real render attachment — the only thing
 * missing is the compositor, which is the part this test explicitly does not claim.
 *
 * Deliberately has no `clientWidth`: vgpu treats a layout-backed canvas as auto-resizing.
 */
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

interface Measurement {
  readonly viewer: readonly number[];
  readonly preview: readonly number[];
  readonly exported: readonly number[];
  readonly warnings: ReadonlyArray<string>;
}

/** Renders one document and reads the centre pixel out of all three present paths. */
async function measure(workingFormat: ProjectSettings["workingFormat"]): Promise<Measurement> {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({
    graph: solidThroughOutput(),
    settings: settings(workingFormat),
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

    // VIEWER — a presentation surface, exactly as `useOutputPresentation` attaches one.
    const viewerCanvas = stubCanvas(device, SIZE, SIZE);
    backend.present(viewerCanvas as never, { outputId: output.resourceId, label: "viewer" });

    backend.render(compiled, {
      frame: {
        timeSeconds: 0,
        deltaSeconds: 1 / 60,
        frameIndex: 0,
        mode: "offline",
        randomSeed: 7,
      },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [SIZE, SIZE],
    });
    await device.queue.onSubmittedWorkDone();
    expect(errors).toEqual([]);
    // The surface never asks for an srgb format, so the hardware adds no transfer of its
    // own: whatever the blit writes is what the compositor gets.
    expect(viewerCanvas.format()).toBe("bgra8unorm");

    const viewerTexture = viewerCanvas.texture();
    if (viewerTexture === undefined) throw new Error("the viewer surface was never configured");
    const viewerBytes = await readTexture(device, viewerTexture, SIZE, SIZE);

    // EXPORT — the same bytes a screenshot writes, through the real encoder path.
    const image = await backend.readOutput(output.resourceId);
    const exported = toRgba8(image, { space: output.space });

    // PREVIEW — the real preview program, composited onto its own real surface.
    const previewCanvas = stubCanvas(device, SIZE, SIZE);
    const previewHandle = backend.previewHost(previewCanvas as never);
    const request: PreviewRequest = {
      ref: { nodeId: "out", portId: output.portId },
      source: {
        resourceId: output.resourceId,
        size: output.size,
        format: output.format,
        // The COMPILER's declaration, never a literal: a literal here would be the test
        // supplying the wiring it is checking (§V220).
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
    previewHandle.setPreviewProgram(program);
    const command: PreviewFrameCommand = {
      refresh: program.passes.map((pass) => pass.id),
      composite: program.passes.map((pass) => ({
        ref: request.ref,
        resourceId: pass.target ?? "",
        dest: { x: 0, y: 0, width: SIZE, height: SIZE },
      })),
      surface: { size: [SIZE, SIZE], dpr: 1 },
    };
    previewHandle.presentPreviews(command);
    await device.queue.onSubmittedWorkDone();
    expect(errors).toEqual([]);

    const previewTexture = previewCanvas.texture();
    if (previewTexture === undefined) throw new Error("the preview surface was never configured");
    const previewBytes = await readTexture(device, previewTexture, SIZE, SIZE);

    const centre = (SIZE / 2) * SIZE + SIZE / 2;
    const pixel = (bytes: Uint8Array): readonly number[] => [
      ...bytes.subarray(centre * 4, centre * 4 + 4),
    ];
    return {
      viewer: pixel(viewerBytes),
      preview: pixel(previewBytes),
      exported: pixel(exported.data),
      warnings: plan.diagnostics.filter((d) => d.severity === "warning").map((d) => d.code),
    };
  } finally {
    backend.dispose();
  }
}

describe("B47 — one decode answer for every way of showing an output (T375)", () => {
  /**
   * The gate. Both non-`-srgb` working formats, and EXACT bytes: the whole failure mode is
   * three surfaces that look nearly right and disagree, so a tolerance here would let the
   * bug back in wearing a rounding error.
   *
   * SENSITIVITY, proven rather than asserted. Three breakages were introduced on purpose
   * and each turned exactly this test red:
   *   - Output node pinned to `OUTPUT_PASSTHROUGH_WGSL` (the pre-T375 state): viewer 55
   *     against a preview and an export of 127.
   *   - `sinkTargetSpace` pinned to the derived space: preview and export 187 while the
   *     viewer stayed 127 — the same divergence from the other side.
   *   - `transferForSpace` pinned to "raw": the float case exported 55 against a viewer of
   *     127 (the decode ran and the re-encode did not); the 8-bit case survived, because
   *     it takes the byte-exact passthrough and never reaches the transfer at all.
   */
  it.each(["rgba16float", "rgba8unorm"] as const)(
    "shows one Solid identically on the preview tile, the viewer and the exported file (%s)",
    async (workingFormat) => {
      if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

      const measured = await measure(workingFormat);

      // The ANSWER, not just agreement: three paths could agree on the wrong number, and
      // that is the "agree by coincidence" outcome T375 exists to refuse. Display 0.5 grey
      // in, display 0.5 grey out — 128 in the 8-bit case because the working buffer
      // quantised the linear value first, which all three surfaces then reproduce exactly.
      const expected = workingFormat === "rgba8unorm" ? ENCODED_BYTE + 1 : ENCODED_BYTE;
      expect(measured.viewer).toEqual([expected, expected, expected, 255]);
      expect(measured.preview).toEqual(measured.viewer);
      expect(measured.exported).toEqual(measured.viewer);
      expect(measured.warnings).toEqual([]);
    },
    60_000,
  );

  /**
   * The one configuration that CANNOT be made to agree, said out loud (§V288).
   *
   * An `rgba8unorm-srgb` output stores display bytes and DECODES them on every sample. The
   * present blit is a raw copy by §V70a, so it samples (decode) and writes to a canvas
   * whose format is never an srgb variant — 54 where the preview and the file both say 127.
   * Fixing it needs a non-decoding VIEW of the source texture, which vgpu does not expose.
   * Until then the compiler names the format and the fix, and this test holds it to that: a
   * silent fourth answer is the thing B47 was.
   */
  it("names the -srgb output format it cannot present, rather than showing a fourth answer", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const measured = await measure("rgba8unorm-srgb");
    expect(measured.warnings).toContain(CompilerDiagnosticCode.sinkFormatUndisplayable);
    // The two paths that CAN agree still do, exactly.
    expect(measured.preview).toEqual([ENCODED_BYTE, ENCODED_BYTE, ENCODED_BYTE, 255]);
    expect(measured.exported).toEqual(measured.preview);
    // And the one that cannot is recorded at its MEASURED value, so a future fix that makes
    // it agree fails here and gets to delete this line deliberately.
    expect(measured.viewer).toEqual([54, 54, 54, 255]);
  }, 60_000);
});
