import type { ReadbackImage, ReadbackRegion } from "../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import { BYTES_PER_PIXEL } from "./pixel-format.ts";
import { clampRegion, fullRegion } from "./outputs.ts";
import type {
  ExportInterface,
  ExportInterfaceOptions,
  ExportOutput,
  ExportStats,
  OutputRef,
  ReadOptions,
} from "./types.ts";
import {
  ExportDiagnosticCode,
  ExportError,
  exportDiagnostic,
  outputRefKey,
  sameOutputRef,
} from "./types.ts";

/**
 * Largest window an "inspect" read may pull while the graph is playing, in pixels.
 *
 * 64x64. The viewer's cursor readout is 1x1 and a colour-picker loupe is tens of pixels; a
 * request for more than this during playback is a full-frame export read wearing the inspect
 * label, and it would stall the loop it is sampling (§V7).
 */
export const MAX_LIVE_INSPECT_PIXELS = 64 * 64;

/**
 * The sole readback surface (T68, §V48).
 *
 * Three jobs, none of which belongs to a caller:
 *
 *  1. Resolve a PORT-scoped ref (§V59) to a backing resource. An unknown ref is refused with
 *     a diagnostic, never silently coerced to "the node's only output".
 *  2. Apply the §V7 rules. Readback stalls the pipeline, so during playback a full-frame read
 *     is refused by default and an explicit one is counted and flagged. A small inspect
 *     window is allowed, because the viewer's readout is exactly the case §V7 permits.
 *  3. Return a DESCRIPTOR (§V60), and check that the source returned one that can actually
 *     be decoded. A source that reports a stride too small for its own width is caught here
 *     rather than three layers up as shifted colours.
 */
export function createExportInterface(options: ExportInterfaceOptions): ExportInterface {
  const maxLiveInspectPixels = options.maxLiveInspectPixels ?? MAX_LIVE_INSPECT_PIXELS;

  let readbacks = 0;
  let duringPlayback = 0;
  let refused = 0;
  let bytesRead = 0;
  let warnedDuringPlayback = false;

  function report(diagnostic: RuntimeDiagnostic): void {
    options.onDiagnostic?.(diagnostic);
  }

  function refuse(diagnostic: RuntimeDiagnostic): never {
    refused += 1;
    report(diagnostic);
    throw new ExportError(diagnostic);
  }

  function describe(ref: OutputRef): ExportOutput | null {
    return options.outputs().find((output) => sameOutputRef(output.ref, ref)) ?? null;
  }

  function resolve(ref: OutputRef): ExportOutput {
    const found = describe(ref);
    if (found) return found;
    const known = options
      .outputs()
      .map((output) => outputRefKey(output.ref))
      .join(", ");
    refuse(
      exportDiagnostic(
        "error",
        ExportDiagnosticCode.unknownOutput,
        `No output "${outputRefKey(ref)}" in the current plan.` +
          (known.length > 0 ? ` Known outputs: ${known}.` : " The plan exposes no outputs."),
        {
          nodeId: ref.nodeId,
          portId: ref.portId,
          suggestion:
            "Outputs are port-scoped (§V59). A single-output node uses the port \"out\"; " +
            "a node id alone is not an output identity.",
        },
      ),
    );
  }

  /**
   * §V7, enforced rather than documented.
   *
   * The asymmetry between reasons is deliberate. "inspect" is the case §V7 names as allowed
   * during playback, and it is bounded so it stays what it claims to be. "recording" reads
   * every frame by definition — refusing it would refuse T111 — so it is permitted and
   * counted. "export" and "test" stall a running loop, so they are refused unless the caller
   * has explicitly decided the stall is acceptable, and even then the read is flagged once so
   * a session that quietly reads pixels back at 60Hz cannot look like a clean one.
   */
  function guardPlayback(
    output: ExportOutput,
    region: ReadbackRegion,
    opts: ReadOptions,
  ): boolean {
    if (!(options.isPlaying?.() ?? false)) return false;
    const reason = opts.reason ?? "export";

    if (reason === "inspect") {
      if (region.width * region.height > maxLiveInspectPixels) {
        refuse(
          exportDiagnostic(
            "error",
            ExportDiagnosticCode.liveReadTooLarge,
            `Inspect read of ${region.width}x${region.height} exceeds the ` +
              `${maxLiveInspectPixels}-pixel live window; that is an export read, and it ` +
              `would stall the frame loop it is sampling (§V7).`,
            { nodeId: output.ref.nodeId, portId: output.ref.portId },
          ),
        );
      }
      return true;
    }

    if (reason === "recording") return true;

    if (opts.whilePlaying !== "allow") {
      refuse(
        exportDiagnostic(
          "error",
          ExportDiagnosticCode.readbackDuringPlayback,
          `Refusing a full readback of "${outputRefKey(output.ref)}" while the frame loop is ` +
            `running: readback stalls the pipeline (§V7).`,
          {
            nodeId: output.ref.nodeId,
            portId: output.ref.portId,
            suggestion:
              "Pause, or pass whilePlaying: \"allow\" to accept the stall deliberately.",
          },
        ),
      );
    }

    if (!warnedDuringPlayback) {
      warnedDuringPlayback = true;
      report(
        exportDiagnostic(
          "warning",
          ExportDiagnosticCode.readbackDuringPlayback,
          `Readback of "${outputRefKey(output.ref)}" performed while playing, by request. ` +
            `Every such read stalls a frame (§V7); ExportInterface.stats.duringPlayback counts them.`,
          { nodeId: output.ref.nodeId, portId: output.ref.portId },
        ),
      );
    }
    return true;
  }

  /**
   * A descriptor that cannot decode its own bytes is worse than no descriptor: the caller
   * trusts it. Checked once, here, so no consumer has to.
   */
  function validate(image: ReadbackImage, region: ReadbackRegion, output: ExportOutput): void {
    const tight = image.width * BYTES_PER_PIXEL[image.format];
    const problems: string[] = [];
    if (image.width !== region.width || image.height !== region.height) {
      problems.push(
        `returned ${image.width}x${image.height} for a ${region.width}x${region.height} request`,
      );
    }
    if (image.rowStride < tight) {
      problems.push(`rowStride ${image.rowStride} is below ${tight} bytes for one row`);
    }
    if (image.bytes.byteLength < image.rowStride * (image.height - 1) + tight) {
      problems.push(
        `${image.bytes.byteLength} bytes cannot hold ${image.height} rows of stride ${image.rowStride}`,
      );
    }
    if (problems.length > 0) {
      refuse(
        exportDiagnostic(
          "error",
          ExportDiagnosticCode.malformedReadback,
          `Readback of "${outputRefKey(output.ref)}" is not decodable: ${problems.join("; ")}.`,
          { nodeId: output.ref.nodeId, portId: output.ref.portId },
        ),
      );
    }
  }

  const stats: ExportStats = {
    get readbacks() {
      return readbacks;
    },
    get duringPlayback() {
      return duringPlayback;
    },
    get refused() {
      return refused;
    },
    get bytesRead() {
      return bytesRead;
    },
  };

  return {
    listOutputs() {
      return options.outputs();
    },
    describe,
    async read(ref, opts = {}) {
      const output = resolve(ref);
      const region =
        opts.region === undefined ? fullRegion(output) : clampRegion(output, opts.region);
      const playing = guardPlayback(output, region, opts);
      const image = await options.source.read(output, region);
      validate(image, region, output);
      readbacks += 1;
      if (playing) duringPlayback += 1;
      bytesRead += image.bytes.byteLength;
      return image;
    },
    stats,
  };
}

/**
 * The viewer's cursor readout (T36), satisfied.
 *
 * `src/runtime/previews/pixel-probe.ts` declared this shape — `read(ref, window)` returning a
 * descriptor — deliberately NOT on the preview host, because nothing on the scheduling path
 * may read pixels back. This is the implementation it was declared against, and it is
 * structurally assignable to that `PixelProbe` without either module importing the other.
 *
 * Every read goes through with reason "inspect", so the window bound applies: the readout may
 * follow a cursor over a playing graph, but it can never quietly become a frame grab.
 */
export function createPixelProbe(api: ExportInterface): {
  read(ref: OutputRef, window: ReadbackRegion): Promise<ReadbackImage>;
} {
  return {
    read(ref, window) {
      return api.read(ref, { region: window, reason: "inspect" });
    },
  };
}
