import { deflateSync } from "node:zlib";
import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import { nodeGpuHost } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { PNG_SIGNATURE, pngChunk } from "../runtime/export/png.ts";
import { CARD_FRAME } from "./look-instrument.ts";

/**
 * Example thumbnails (T847). ONE still per example, rendered at §T794's `CARD_FRAME` — the
 * frame the gallery card is sourced from, already settled and gated (quietest card is E43
 * at 0.1651; nothing is black). A thumbnail is a §V642 baseline in disguise: regenerate it
 * with the example and gate that every shipped loom has one, or the 38th example ships
 * without a card (§V775).
 *
 * NODE-ONLY: this reaches for `node:zlib`, so the app must never import it. The runtime PNG
 * path (`encodePng`) stays browser-safe with stored blocks; here, at build time, real
 * deflate is free and the whole point — 44 cards have to fit without bloating the bundle.
 */

/**
 * 256×144 — 16:9, the aspect every example outputs. Big enough to read what the example is
 * on a hover card, small enough that a compressed still is a few KB. The look INSTRUMENT
 * probes at 192×108 for luma stats; the card is a DISPLAY still, so it renders a touch
 * larger and crisper rather than reusing the stats resolution.
 */
export const THUMBNAIL_RESOLUTION = { width: 256, height: 144 } as const;

/** The file stem a thumbnail is keyed by — the loom's name without `.loom.json`. */
export function thumbnailStem(loomFileName: string): string {
  return loomFileName.replace(/\.loom\.json$/, "");
}

/** A spec-conformant 8-bit RGBA PNG whose IDAT is a REAL deflate stream (unlike encodePng). */
function encodePngCompressed(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const rowBytes = width * 4;
  // One filter byte (0 = None) per scanline. Deflate carries the compression; None keeps
  // the encoder honest and small, and the flat/dark regions these cards are full of pack
  // well regardless.
  const filtered = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    filtered[y * (rowBytes + 1)] = 0;
    filtered.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const idat = new Uint8Array(deflateSync(filtered, { level: 9 }));
  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** Renders one example at CARD_FRAME and returns its thumbnail PNG bytes. */
export async function renderThumbnail(
  graph: GraphDocument,
  settings: ProjectSettings,
  outputNodeId: string,
): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...settings, outputResolution: { ...THUMBNAIL_RESOLUTION } },
    frames: CARD_FRAME + 1,
    capture: [CARD_FRAME],
    outputNodeId,
    fps: 60,
    animate: true,
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(`thumbnail render reported: ${errors.map((d) => d.message).join("; ")}`);
  }
  // `frameIndex` here is an ARRAY KEY into the captured frames, not a clock read — nothing
  // animates from it, so the absolute clock (absTime) is not the right tool at this site
  // (§V436): the render's own transport drives the motion; this line only picks the capture.
  const frame = result.frames.find((entry) => entry.frameIndex === CARD_FRAME);
  if (frame === undefined) throw new Error(`no captured frame at ${CARD_FRAME}`);
  const space = result.plan.outputs.find((output) => output.nodeId === outputNodeId)?.space ?? "linear";
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
  return encodePngCompressed(image.width, image.height, image.data);
}
