import type { ReadbackImage, ReadbackRegion } from "../../domain/types/backend.ts";
import type { TextureFormat } from "../../domain/types/node-definition.ts";
import { BYTES_PER_PIXEL } from "./pixel-format.ts";
import type { ExportOutput, ReadbackSource, ResolvedOutputLike } from "./types.ts";
import { ExportDiagnosticCode, ExportError, exportDiagnostic } from "./types.ts";

/**
 * Turns the compiler's resolved outputs into the export catalogue.
 *
 * The compiler already computes exactly what a readback needs to be interpretable — the
 * port-scoped identity, the resource id, the resolved size and format (§V21). Recomputing
 * any of it here would be a second source of truth for "how big is this output", which is
 * precisely the drift the headless harness has today: it reads bytes and then goes looking
 * for the matching `ResolvedOutput` to describe them.
 */
export function exportOutputsFrom(
  outputs: ReadonlyArray<ResolvedOutputLike>,
): ReadonlyArray<ExportOutput> {
  return outputs.map((output) => ({
    ref: { nodeId: output.nodeId, portId: output.portId },
    resourceId: output.resourceId,
    width: output.size[0],
    height: output.size[1],
    format: output.format,
    space: output.space,
  }));
}

/** Clamps a requested window to the output, and refuses one that misses entirely. */
export function clampRegion(output: ExportOutput, region: ReadbackRegion): ReadbackRegion {
  const x = Math.max(0, Math.min(Math.trunc(region.x), output.width));
  const y = Math.max(0, Math.min(Math.trunc(region.y), output.height));
  const width = Math.min(Math.trunc(region.width), output.width - x);
  const height = Math.min(Math.trunc(region.height), output.height - y);
  if (width <= 0 || height <= 0) {
    throw new ExportError(
      exportDiagnostic(
        "error",
        ExportDiagnosticCode.regionOutOfBounds,
        `Region ${region.width}x${region.height}+${region.x}+${region.y} does not overlap ` +
          `output "${output.resourceId}" (${output.width}x${output.height}).`,
        { nodeId: output.ref.nodeId, portId: output.ref.portId },
      ),
    );
  }
  return { x, y, width, height };
}

export function fullRegion(output: ExportOutput): ReadbackRegion {
  return { x: 0, y: 0, width: output.width, height: output.height };
}

/**
 * WebGPU's `copyTextureToBuffer` requires each row to start on a 256-byte boundary, so a
 * readback's row stride is almost never `width * bytesPerPixel`. This is the alignment every
 * naive reader forgets.
 */
export const READBACK_ROW_ALIGNMENT = 256;

export function alignedRowStride(width: number, format: TextureFormat): number {
  const tight = width * BYTES_PER_PIXEL[format];
  return Math.ceil(tight / READBACK_ROW_ALIGNMENT) * READBACK_ROW_ALIGNMENT;
}

/**
 * Recovers the row stride of a byte blob that arrived without one.
 *
 * Only two strides can produce a given length for a known width/height/format: the tight one
 * and the 256-aligned one. Guessing between them is not acceptable, so this checks and
 * refuses anything that matches neither rather than returning a plausible number that
 * silently shifts every row after the first.
 */
export function inferRowStride(
  byteLength: number,
  width: number,
  height: number,
  format: TextureFormat,
): number {
  const tight = width * BYTES_PER_PIXEL[format];
  if (height > 0 && byteLength === tight * height) return tight;
  const aligned = alignedRowStride(width, format);
  if (height > 0 && byteLength === aligned * height) return aligned;
  throw new ExportError(
    exportDiagnostic(
      "error",
      ExportDiagnosticCode.malformedReadback,
      `Readback of ${byteLength} bytes matches neither a tight (${tight}) nor a 256-aligned ` +
        `(${aligned}) row stride for ${width}x${height} ${format}. Refusing to guess: the ` +
        `wrong stride shifts every row after the first and looks like a rendering bug.`,
    ),
  );
}

/** Copies a sub-rectangle out of a readback, producing a tightly packed descriptor. */
export function cropReadback(image: ReadbackImage, region: ReadbackRegion): ReadbackImage {
  const bytesPerPixel = BYTES_PER_PIXEL[image.format];
  const stride = region.width * bytesPerPixel;
  const out = new Uint8Array(stride * region.height);
  for (let row = 0; row < region.height; row += 1) {
    const start = (region.y + row) * image.rowStride + region.x * bytesPerPixel;
    out.set(image.bytes.subarray(start, start + stride), row * stride);
  }
  return {
    width: region.width,
    height: region.height,
    format: image.format,
    rowStride: stride,
    bytes: out,
  };
}

/**
 * `ReadbackSource` over the real backend (T173/T82): `readOutput` now returns the full
 * `ReadbackImage` and crops regions itself, so this is pure delegation — the descriptor
 * comes from the thing that did the copy, exactly as §V60 wanted.
 */
export function readbackSourceFromBackend(backend: {
  readOutput(outputId: string, region?: ReadbackRegion): Promise<ReadbackImage>;
}): ReadbackSource {
  return {
    read: (target, region) => backend.readOutput(target.resourceId, region),
  };
}
