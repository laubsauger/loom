import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FrameRange } from "@domain/types/graph.ts";
import type { ExportInterface, OutputRef } from "@runtime/export/index.ts";
import { createFrameRecorder } from "@runtime/export/index.ts";
import type { RecordingReport, VideoEncoderSink } from "@runtime/export/index.ts";
import type { TransportHandlers } from "./transport-commands.ts";

/**
 * RENDERING THE TIMELINE OUT (T433, §V48, §V170).
 *
 * The other half of the timeline. An in/out range that can only be scrubbed is a
 * viewport onto the clock; the range earns its keep when you can hand it to something
 * and get a file back, and "render our timeline out" was half of what was asked for.
 *
 * ## Deterministic, and that is the whole design
 *
 * This is NOT a screen recording. Nothing here reads a clock, waits for a frame or
 * samples what the display happened to show. The transport is seeked to the in point —
 * which REPLAYS and clears temporal state (§V170), so a feedback graph starts the take
 * from the state that genuinely belongs to that frame — and then stepped one frame at a
 * time, synchronously, with each rendered frame handed to the recorder labelled by the
 * `frameIndex` the render actually consumed (§V44). The same project, seed and range
 * produce the same file, on a fast machine and on a slow one.
 *
 * That is why the loop below does not use `recordSequence`, which is the same shape one
 * call shorter: it steps and THEN captures, so the frame the seek just rendered — the in
 * point itself — would never be offered, and the take would silently be `start+1..end+1`.
 * A range that renders the wrong frames while reporting the right count is exactly the
 * failure `RecordingReport` exists to make impossible.
 *
 * ## What it refuses, by name (§V288)
 *
 * A graph with no declared Output, a session with no transport, and a browser with no
 * `VideoEncoder` are three different reasons nothing can be rendered, and each says which
 * it is. Silence here would look like a broken button.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Renders the timeline's in/out range to a video file.
     *
     * The range is the DOCUMENT's (`ProjectSettings.frameRange`) — the same value the
     * scrubber drags and the loop cycles. It is deliberately not an input here: a caller
     * that could pass its own length would be a second answer to "how long is this", and
     * T433's ruling is that there is one.
     */
    "export.renderRange": {
      input: Record<string, never>;
      output: { rendered: boolean; frames: number; fileName: string | null };
    };
  }
}

/** What a take produced, or why there was none. */
export type RenderRangeOutcome =
  | { readonly kind: "rendered"; readonly frames: number; readonly fileName: string | null }
  | { readonly kind: "refused"; readonly diagnostic: RuntimeDiagnostic };

export interface RenderRangeHandlers {
  /** True while a take is in flight, so a second press reports rather than interleaving. */
  busy(): boolean;
  render(): Promise<RenderRangeOutcome>;
}

export interface RenderRangeHolder {
  current: RenderRangeHandlers | null;
}

const holders = new WeakMap<object, RenderRangeHolder>();

export function renderRangeHolderFor(bus: ShaderloomBus): RenderRangeHolder {
  const existing = holders.get(bus);
  if (existing !== undefined) return existing;
  const holder: RenderRangeHolder = { current: null };
  holders.set(bus, holder);
  return holder;
}

/**
 * What a take needs from the transport — a NARROWER view than `TransportHandlers`.
 *
 * `latestFrame` is here and not on `TransportHandlers` because it belongs to the frame
 * LOOP rather than to the transport verbs: `useFrameLoop` already publishes it (§V16, a
 * ref read rather than a subscription) and a second copy on the holder would be a second
 * answer to "what was the last frame rendered".
 */
export interface RangeTransport {
  isPlaying(): boolean;
  togglePlay(): void;
  seek(frameIndex: number): number;
  stepOnce(): ReturnType<TransportHandlers["stepOnce"]>;
  latestFrame(): ReturnType<TransportHandlers["stepOnce"]>;
}

export interface RenderFrameRangeInputs {
  /** The sole readback surface (§V48). */
  readonly api: ExportInterface;
  readonly ref: OutputRef;
  readonly range: FrameRange;
  readonly fps: number;
  readonly transport: RangeTransport;
  readonly encoder: VideoEncoderSink;
  readonly onDiagnostic?: ((diagnostic: RuntimeDiagnostic) => void) | undefined;
}

export interface RenderedRange {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly report: RecordingReport;
}

/**
 * Steps the range and encodes it. No DOM, no clock, no file — those belong to the caller.
 *
 * Split out from the command so the part that decides WHICH FRAME IS WHICH can be tested
 * against a fake transport and a fake encoder, with no GPU and no browser. That is the
 * part §V220 keeps catching: the orchestration is where an off-by-one lives, and it is
 * unreachable from a test that has to stand up a device first.
 */
export async function renderFrameRange(inputs: RenderFrameRangeInputs): Promise<RenderedRange> {
  const { api, ref, range, fps, transport, encoder } = inputs;
  const recorder = createFrameRecorder({
    api,
    ref,
    encoder,
    fps,
    ...(inputs.onDiagnostic === undefined ? {} : { onDiagnostic: inputs.onDiagnostic }),
  });

  // Pausing first is not politeness: a running loop would keep advancing the timeline
  // between our steps, so the take would carry frames nobody asked for and the recorder
  // would report duplicates it did not cause.
  if (transport.isPlaying()) transport.togglePlay();

  await recorder.start();
  // §V170 — the in point's true state, replayed rather than jumped to. The seek RENDERS
  // that frame, so the first thing captured is the frame already on the GPU; stepping
  // first instead is the off-by-one described above.
  transport.seek(range.start);
  let frame = transport.latestFrame();
  for (let index = range.start; index <= range.end; index += 1) {
    if (frame === null) break;
    await recorder.captureFrame(frame.frame);
    if (index < range.end) frame = transport.stepOnce();
  }
  const result = await recorder.finish();
  return { mimeType: result.video.mimeType, bytes: result.video.bytes, report: result.report };
}

const NO_SESSION: RuntimeDiagnostic = {
  severity: "warning",
  code: "export.noSession",
  message: "No running session is holding a renderer, so there is nothing to render out.",
  suggestion: "The render path is created with the GPU device — a build with no WebGPU has none.",
};

/** Idempotent: the bus has no unregister, and React mounts more than once. */
export function registerRenderRangeCommand(bus: ShaderloomBus): RenderRangeHolder {
  const holder = renderRangeHolderFor(bus);
  if (bus.hasCommand("export.renderRange")) return holder;

  bus.registerCommand({
    name: "export.renderRange",
    description: "Render the timeline's in/out range to a video file.",
    handler: async (_input, context) => {
      const revision = context.store.getRevision();
      const handlers = holder.current;
      if (handlers === null) {
        return {
          status: "rejected",
          revision,
          diagnostics: [NO_SESSION],
          output: { rendered: false, frames: 0, fileName: null },
        };
      }
      if (handlers.busy()) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "export.renderInFlight",
              message: "A render is already running; it steps the same transport this one would.",
            },
          ],
          output: { rendered: false, frames: 0, fileName: null },
        };
      }
      if (context.dryRun) {
        return { status: "validated", revision, output: { rendered: false, frames: 0, fileName: null } };
      }

      const outcome = await handlers.render();
      if (outcome.kind === "refused") {
        return {
          status: "rejected",
          revision,
          diagnostics: [outcome.diagnostic],
          output: { rendered: false, frames: 0, fileName: null },
        };
      }
      // A cancelled save picker is not a failure — the same rule the project save and the
      // audio track follow. The frames were rendered either way, and the count says so.
      return {
        status: "applied",
        revision,
        output: {
          rendered: outcome.fileName !== null,
          frames: outcome.frames,
          fileName: outcome.fileName,
        },
      };
    },
    rejectionOutput: () => ({ rendered: false, frames: 0, fileName: null }),
  });

  return holder;
}
