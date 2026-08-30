import type { TextureFormat } from "../../domain/types/node-definition.ts";
import type { TransferMode } from "./image.ts";
import { toRgba8 } from "./image.ts";
import { encodePng } from "./png.ts";
import type { ExportFile, ExportInterface, FileSink, OutputRef, ReadbackReason } from "./types.ts";
import { ExportDiagnosticCode, ExportError, exportDiagnostic, outputRefKey } from "./types.ts";

/**
 * Screenshot / still export — the v1 export step (§C export order, T68).
 *
 * The whole feature is "read one output through the one readback surface, encode it, hand the
 * bytes out". It is short because everything that makes it correct — port-scoped resolution,
 * the §V7 playback rules, descriptor validation, the transfer decision — already happened
 * upstream of here. That is the point of §V48: this file cannot get readback wrong, because
 * this file does not do readback.
 */

export interface CaptureOptions {
  /** Bound the result. Absent captures at the output's own resolution. */
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly transfer?: TransferMode;
  /** §V7. Defaults to refusing a full-frame read while the frame loop runs. */
  readonly whilePlaying?: "refuse" | "allow";
  readonly reason?: ReadbackReason;
}

export interface CapturedImage {
  readonly ref: OutputRef;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/png";
  readonly bytes: Uint8Array;
  /** What was actually read, before any bounding — so a caller knows it got a scaled copy. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly sourceFormat: TextureFormat;
}

export async function capturePng(
  api: ExportInterface,
  ref: OutputRef,
  options: CaptureOptions = {},
): Promise<CapturedImage> {
  const image = await api.read(ref, {
    reason: options.reason ?? "export",
    ...(options.whilePlaying === undefined ? {} : { whilePlaying: options.whilePlaying }),
  });
  // T375 (§V57): the file's transfer comes from what the graph DECLARED this output to be,
  // not from its pixel format. `read` has already refused an unknown ref, so a null here
  // is a catalogue that changed under us — reported, never guessed at.
  const described = api.describe(ref);
  if (described === null) {
    throw new ExportError(
      exportDiagnostic(
        "error",
        ExportDiagnosticCode.unknownOutput,
        `Output "${outputRefKey(ref)}" was read but is no longer in the catalogue; its colour space is unknown.`,
        { nodeId: ref.nodeId, portId: ref.portId },
      ),
    );
  }
  const png = encodePng(
    toRgba8(image, {
      space: described.space,
      ...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
      ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
      ...(options.transfer === undefined ? {} : { transfer: options.transfer }),
    }),
  );
  return {
    ref,
    width: png.width,
    height: png.height,
    mimeType: png.mimeType,
    bytes: png.bytes,
    sourceWidth: image.width,
    sourceHeight: image.height,
    sourceFormat: image.format,
  };
}

/**
 * Longest edge of an agent preview, in pixels.
 *
 * `render_preview` exists so a model can look at what it built (§I.tools) — inspect, patch,
 * compile, render, examine, refine. A full-resolution frame would blow the tool result budget
 * for no gain in what is legible.
 */
export const DEFAULT_PREVIEW_MAX_EDGE = 512;

/**
 * A bounded-size PNG of any texture output — what the agent track's `render_preview` needs
 * (T58, §V48).
 *
 * Bounded by default and read with reason "export", so an agent that calls it during playback
 * is refused rather than being allowed to stall the loop once per turn. The agent adapter
 * decides whether to pause first; that is a decision with a capability grant attached (§V38),
 * and it does not belong to this function.
 */
export function renderPreviewPng(
  api: ExportInterface,
  ref: OutputRef,
  options: CaptureOptions = {},
): Promise<CapturedImage> {
  return capturePng(api, ref, {
    maxWidth: DEFAULT_PREVIEW_MAX_EDGE,
    maxHeight: DEFAULT_PREVIEW_MAX_EDGE,
    ...options,
  });
}

/** Filename-safe rendering of a port-scoped ref. */
export function captureFileName(ref: OutputRef, extension: string): string {
  const base = outputRefKey(ref).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${base}.${extension}`;
}

export function captureToFile(capture: CapturedImage, name?: string): ExportFile {
  return {
    name: name ?? captureFileName(capture.ref, "png"),
    mimeType: capture.mimeType,
    bytes: capture.bytes,
  };
}

/**
 * Hands a capture to whoever owns the DOM.
 *
 * The sink is injected because `src/runtime/**` may not touch `document` (§V63): an anchor
 * with a blob URL is the app layer's business. Keeping the seam here means the export path is
 * identical in the browser, in a worker and in a headless test — only the sink differs.
 */
export async function saveCapture(
  capture: CapturedImage,
  sink: FileSink,
  name?: string,
): Promise<ExportFile> {
  const file = captureToFile(capture, name);
  await sink(file);
  return file;
}
