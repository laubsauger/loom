import { useCallback, useEffect, useRef, useState } from "react";

import type { LoomBus } from "@domain/commands/bus.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { FrameRange, ProjectSettings } from "@domain/types/graph.ts";
import { projectFps, projectRange } from "@domain/types/graph.ts";
import { frameRangeLimit, rangeLimitSentence } from "@domain/transport/range-limit.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { nonReproducibleRenderWarning } from "@domain/render/reproducibility.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import { presentsPicture } from "@compiler/index.ts";
import type { AudioEncoderSupport, AudioPcmProvider, EncoderFinishProgress, ExportInterface, ExportOutput, OutputRef, VideoEncoderSupport, VideoFormatId } from "@runtime/export/index.ts";
import { DEFAULT_VIDEO_FORMAT, ExportError, loadVideoEncoder, probeAudioEncoderSupport, probeVideoEncoderSupport, videoFormatInfo, videoFormatSourceRefusal } from "@runtime/export/index.ts";
import type { RenderCanvasCapture } from "./render-canvas-capture.ts";
import type { RenderAudioRequirement } from "./use-audio-input.ts";
import { transportHolderFor } from "./transport-commands.ts";
import type { RenderRangeOutcome, RenderRangeProgress } from "./render-range.ts";
import { RenderRangeCancelledError, registerRenderRangeCommand, renderFrameRange, renderedFrameCount, sourceRangeForOutputRange } from "./render-range.ts";
import { prepareFileWrite, writeTextFile } from "./project-io.ts";
import type { PreparedFileWrite } from "./project-io.ts";

/**
 * The seam that makes "render the timeline out" a thing the app can do (T433, §V220).
 *
 * `createFrameRecorder`, `muxMp4` and the WebCodecs encoder have existed and been tested
 * since T111, with no construction site anywhere in the product — the seam gate said so
 * in writing. This hook is that site. It holds nothing itself: it composes the export
 * interface the agent ports already built, the transport the frame loop already owns and
 * the file ladder the project save already uses, so there is one of each rather than a
 * private copy per feature.
 *
 * ## Which output gets rendered
 *
 * The graph's DECLARED sink, exactly as the viewer picks it (§V28b): every visible
 * texture node is a preview sink, so "the first resolved output" would render an
 * arbitrary intermediate. With no Output node there is nothing to render and the command
 * says so by name (§V288) rather than producing a file of something nobody asked for.
 */

export interface RenderRangeSession {
  /** True while a take is running, for the header's control. */
  readonly rendering: boolean;
  /** True after cancellation was requested while cleanup or an active file write settles. */
  readonly cancelling: boolean;
  /** False once the destination starts its atomic close/commit step. */
  readonly cancelAvailable: boolean;
  /** Frames the current range would produce. Zero when nothing can render. */
  readonly frames: number;
  /**
   * What the last take had to say about itself, for the problems pane (T586).
   *
   * A refusal already reaches the user through `reportRefusal`, which returns early on
   * `applied` — so a take that SUCCEEDS has had no channel at all, and T586's warning is
   * about a take that succeeds and is nonetheless not the take you think it is. Held until
   * the next take rather than flashed, because the question it answers ("why does my
   * render not match what I heard?") is asked AFTER the file exists.
   */
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly progress: RenderExportProgress;
  /** Wall time since this take started, including setup, pre-roll, encoding and save. */
  readonly elapsedMilliseconds: number;
  /** Throughput across at most the latest 32 completed output frames. */
  readonly recentFramesPerSecond: number | null;
  /** Encoded media already written to bounded temporary disk storage. */
  readonly spooledBytes: number;
  /**
   * Whether the take's format can be written here: the browser's answer for this size and
   * rate, or a refusal naming why this Output cannot feed it (T1741b: a 10-bit format of an
   * 8-bit Output). `null` while the probe runs.
   */
  readonly encoderSupport: VideoEncoderSupport | null;
  readonly audioSupport: AudioEncoderSupport | null;
  readonly audioRequirement: RenderAudioRequirement;
  /** Whether a deterministic soundtrack should be included in the MP4. */
  readonly includeAudio: boolean;
  readonly setIncludeAudio: (include: boolean) => void;
  /** True once installed output targets match the take resolution after a settings edit. */
  readonly outputReady: boolean;
  /** Requests cooperative cancellation. The current GPU readback/encode finishes first. */
  readonly cancel: () => void;
  /** Acquires the output file from the Render button's user gesture. */
  readonly prepareDestination: () => Promise<boolean>;
  readonly renderSettings: RenderJobSettings;
  readonly setRenderSettings: (patch: Partial<RenderJobSettings>) => void;
}

export type RenderExportProgress =
  | ({ readonly stage: "frames" } & RenderRangeProgress)
  | ({ readonly stage: "preroll"; readonly completedPreRollFrames: number; readonly totalPreRollFrames: number } & RenderRangeProgress)
  | ({ readonly stage: "video" } & RenderRangeProgress)
  | ({ readonly stage: "audio"; readonly completedAudioFrames: number; readonly totalAudioFrames: number } & RenderRangeProgress)
  | ({ readonly stage: "finalizing" | "saving" } & RenderRangeProgress);

export interface RenderJobSettings {
  readonly resolution: ProjectSettings["outputResolution"];
  readonly outputFps: number;
  readonly range: FrameRange;
  /**
   * VN71: project frames played before the in point and not recorded (`renderFrameRange`).
   * Absent is 0: the take starts at its in point from cleared state, and nothing pre-rolls
   * unless the user asks for it.
   */
  readonly preRollFrames?: number | undefined;
  /**
   * T1741b: the recording format, set through `export.setRenderFormat`. Absent is H.264,
   * the compatible default (`DEFAULT_VIDEO_FORMAT`).
   */
  readonly format?: VideoFormatId | undefined;
}

export interface UseRenderRangeInputs {
  readonly bus: LoomBus;
  /** Browser-owned surface for the take. No scene readback or CPU colour conversion. */
  readonly createCapture: (output: ExportOutput) => RenderCanvasCapture;
  readonly exports: ExportInterface | undefined;
  readonly compiled: CompiledGraph | null;
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly settings: ProjectSettings;
  readonly renderSettings?: RenderJobSettings | undefined;
  readonly onRenderSettingsChange?: ((next: RenderJobSettings) => void) | undefined;
  readonly latestFrame: () => FrameInputs | null;
  readonly name: () => string;
  /**
   * T747: awaited after each frame renders, so an async node's result belongs to a frame
   * rather than to whenever it happened to arrive. Optional — a session with no model
   * node supplies nothing and the loop is unchanged.
   */
  readonly onFrameRendered?: ((frameIndex: number) => Promise<void>) | undefined;
  /** Await preparation before replay; an optional cleanup releases its export ownership. */
  readonly beforeRender?: (() => Promise<void | (() => void)>) | undefined;
  /** Mutes only speaker monitoring for every take; returned cleanup restores it. */
  readonly muteAudioMonitor?: (() => (() => void)) | undefined;
  readonly prepareAudio?: ((
    range: FrameRange,
    timelineFps: number,
    outputFps: number,
    signal: AbortSignal,
  ) => Promise<{ readonly pcm: AudioPcmProvider; close(): void } | null>) | undefined;
  readonly audioRequirement?: (() => RenderAudioRequirement) | undefined;
  /** Test seam. The real one is a `VideoEncoder` behind the WebCodecs loader. */
  readonly loadEncoder?: typeof loadVideoEncoder;
  /** Test seam; production probes the exact project size/rate through WebCodecs. */
  readonly probeEncoder?: typeof probeVideoEncoderSupport;
  readonly probeAudioEncoder?: typeof probeAudioEncoderSupport;
  /** Test seam for the file ladder. */
  readonly write?: typeof writeTextFile;
}

const VIDEO_PICKER_TYPES = [
  {
    description: "MPEG-4 video",
    accept: { "video/mp4": [".mp4"] } as Readonly<Record<string, readonly string[]>>,
  },
];

function refuse(
  code: string,
  message: string,
  suggestion?: string,
): { kind: "refused"; diagnostic: RuntimeDiagnostic } {
  return {
    kind: "refused",
    diagnostic: {
      severity: "error",
      code,
      message,
      ...(suggestion === undefined ? {} : { suggestion }),
    },
  };
}

/** Strips a project file name back to a stem a video can sit beside. */
function videoFileName(
  projectName: string,
  resolution: ProjectSettings["outputResolution"],
  start: number,
  end: number,
): string {
  const stem = projectName.replace(/\.loom\.json$/i, "").replace(/[^\w.-]+/g, "_") || "untitled";
  return `${stem}.${String(resolution.width)}x${String(resolution.height)}.${String(start)}-${String(end)}.mp4`;
}

export function useRenderRange(inputs: UseRenderRangeInputs): RenderRangeSession {
  const initialAudioRequirement = inputs.audioRequirement?.() ?? { kind: "none" as const };
  const [rendering, setRendering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelAvailable, setCancelAvailable] = useState(false);
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const projectFrameRate = projectFps(inputs.settings);
  const projectFrameRange = projectRange(inputs.settings);
  const [fallbackRenderSettings, setFallbackRenderSettings] = useState<RenderJobSettings>({
    resolution: inputs.settings.outputResolution,
    outputFps: projectFrameRate,
    range: projectFrameRange,
  });
  const renderSettings = inputs.renderSettings ?? fallbackRenderSettings;
  const totalFrames = renderedFrameCount(renderSettings.range);
  const outputWidth = renderSettings.resolution.width;
  const outputHeight = renderSettings.resolution.height;
  const outputFps = renderSettings.outputFps;
  const format = renderSettings.format ?? DEFAULT_VIDEO_FORMAT;
  const [progress, setProgress] = useState<RenderExportProgress>({
    stage: "frames",
    completedFrames: 0,
    totalFrames,
    frameIndex: null,
  });
  const [spooledBytes, setSpooledBytes] = useState(0);
  const [elapsedMilliseconds, setElapsedMilliseconds] = useState(0);
  const [recentFramesPerSecond, setRecentFramesPerSecond] = useState<number | null>(null);
  const [encoderSupport, setEncoderSupport] = useState<VideoEncoderSupport | null>(null);
  const [audioSupport, setAudioSupport] = useState<AudioEncoderSupport | null>(null);
  const [includeAudio, setIncludeAudioState] = useState(initialAudioRequirement.kind !== "none");
  // Every input is read through ONE ref, at the moment the command runs: a take is
  // started by a keypress or the palette, and the handlers must not need re-registering
  // on every compile to see the current graph.
  const inputsRef = useRef(inputs);
  const preparedWriteRef = useRef<PreparedFileWrite | null>(null);
  const renderSettingsRef = useRef(renderSettings);
  inputsRef.current = inputs;
  renderSettingsRef.current = renderSettings;
  const renderingRef = useRef(false);
  const renderStartedAtRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const refreshElapsed = useCallback((now = performance.now()): void => {
    const startedAt = renderStartedAtRef.current;
    if (startedAt !== null) setElapsedMilliseconds(Math.max(0, now - startedAt));
  }, []);

  useEffect(() => {
    if (!rendering) return;
    const interval = setInterval(refreshElapsed, 500);
    return () => clearInterval(interval);
  }, [refreshElapsed, rendering]);

  const sink = declaredSink(inputs.compiled, inputs.graph, inputs.registry);
  const audioRequirement = inputs.audioRequirement?.() ?? { kind: "none" };
  const hasAudioSource = audioRequirement.kind !== "none";
  const includeAudioRef = useRef(includeAudio && hasAudioSource);
  includeAudioRef.current = includeAudio && hasAudioSource;
  const previousHasAudioSourceRef = useRef(hasAudioSource);

  useEffect(() => {
    if (previousHasAudioSourceRef.current === hasAudioSource) return;
    previousHasAudioSourceRef.current = hasAudioSource;
    setIncludeAudioState(hasAudioSource);
  }, [hasAudioSource]);

  useEffect(() => {
    let current = true;
    setEncoderSupport(null);
    const config = {
      width: outputWidth,
      height: outputHeight,
      fps: outputFps,
    };
    void (inputsRef.current.probeEncoder ?? probeVideoEncoderSupport)(config, { format }).then((support) => {
      if (current) setEncoderSupport(support);
    });
    return () => {
      current = false;
    };
  }, [
    format,
    outputFps,
    outputHeight,
    outputWidth,
  ]);

  useEffect(() => {
    let current = true;
    setAudioSupport(null);
    if (!includeAudio || audioRequirement.kind !== "required") return () => { current = false; };
    void (inputsRef.current.probeAudioEncoder ?? probeAudioEncoderSupport)().then((support) => {
      if (current) setAudioSupport(support);
    });
    return () => {
      current = false;
    };
  }, [audioRequirement.kind, includeAudio]);

  const setRenderSettings = useCallback((patch: Partial<RenderJobSettings>) => {
    const current = renderSettingsRef.current;
    const nextRate = patch.outputFps ?? current.outputFps;
    const convertedRange = patch.outputFps !== undefined && patch.range === undefined && nextRate !== current.outputFps
      ? {
          start: Math.round((current.range.start * nextRate) / current.outputFps),
          end: Math.max(
            Math.round((current.range.start * nextRate) / current.outputFps),
            Math.round(((current.range.end + 1) * nextRate) / current.outputFps) - 1,
          ),
        }
      : current.range;
    const next = { ...current, ...patch, range: patch.range ?? convertedRange };
    // Read back by the next call before React re-renders: two edits in one turn compose.
    renderSettingsRef.current = next;
    const update = inputsRef.current.onRenderSettingsChange;
    if (update === undefined) setFallbackRenderSettings(next);
    else update(next);
  }, []);

  useEffect(() => {
    const holder = registerRenderRangeCommand(inputs.bus);
    const handlers = {
      busy: () => renderingRef.current,
      setFormat: (next: VideoFormatId) => setRenderSettings({ format: next }),
      cancel: () => {
        if (abortRef.current === null) return;
        setCancelling(true);
        abortRef.current.abort();
      },
      render: async (): Promise<RenderRangeOutcome> => {
        const live = inputsRef.current;
        const preparedWrite = preparedWriteRef.current;
        preparedWriteRef.current = null;
        if (live.write === undefined && preparedWrite === null) {
          return refuse(
            "export.saveDestinationRequired",
            "Choose an MP4 destination before starting a bounded video render.",
          );
        }
        const api = live.exports;
        if (api === undefined) {
          return refuse(
            "export.noDevice",
            "There is no GPU device, so there are no frames to render.",
          );
        }
        const ref = declaredSink(live.compiled, live.graph, live.registry);
        if (ref === null) {
          return refuse(
            "export.noOutput",
            "This graph declares no Output, so there is nothing to render out.",
            "Add an Output node and connect it to the branch you want on the timeline.",
          );
        }
        const described = api.describe(ref);
        const wanted = renderSettingsRef.current.resolution;
        const takeFormat = renderSettingsRef.current.format ?? DEFAULT_VIDEO_FORMAT;
        if (wanted.width % 2 !== 0 || wanted.height % 2 !== 0) {
          return refuse(
            "export.invalidVideoSize",
            `${videoFormatInfo(takeFormat).name} video export requires an even width and height.`,
            "Set both render dimensions to multiples of two.",
          );
        }
        if (described === null || described.width !== wanted.width || described.height !== wanted.height) {
          return refuse(
            "export.planUpdating",
            `The renderer is still applying ${wanted.width}x${wanted.height} render resolution.`,
            "Wait for the graph to finish recompiling, then render again.",
          );
        }
        // T1741b: a 10-bit file of an 8-bit Output is 8-bit data under a 10-bit label.
        const sourceRefusal = videoFormatSourceRefusal(takeFormat, described.format);
        if (sourceRefusal !== null) {
          return refuse("export.formatNeedsFloatOutput", sourceRefusal, "Or choose H.264 High for the best 8-bit file.");
        }
        const transport = transportHolderFor(live.bus).current;
        if (transport === null) {
          return refuse(
            "export.noTransport",
            "No frame loop is attached, so the timeline cannot be stepped.",
          );
        }
        const liveRenderSettings = renderSettingsRef.current;
        const liveRange = liveRenderSettings.range;
        const timelineFps = projectFps(live.settings);
        const renderFps = liveRenderSettings.outputFps;
        const sourceRange = sourceRangeForOutputRange(liveRange, timelineFps, renderFps);
        // VN71: the range cap is one day at the project rate, a sanity cap and not a cost —
        // a take steps in → out, so its length is what it costs, and the replay budget a
        // scrub answers to is no business of a render's.
        if (sourceRange.end > frameRangeLimit(timelineFps)) {
          return refuse(
            "export.renderRangeOutsideTimeline",
            `The selected output range needs project frame ${String(sourceRange.end)}. ${rangeLimitSentence(sourceRange.end, timelineFps)}`,
          );
        }
        const liveAudioRequirement = live.audioRequirement?.() ?? { kind: "none" };
        const includeSoundtrack = includeAudioRef.current && liveAudioRequirement.kind !== "none";
        if (includeSoundtrack && liveAudioRequirement.kind === "invalid") {
          return refuse("export.audioNotDeterministic", liveAudioRequirement.reason);
        }
        if (includeSoundtrack && liveAudioRequirement.kind === "required") {
          const support = await (live.probeAudioEncoder ?? probeAudioEncoderSupport)();
          if (!support.supported) {
            return refuse(
              "export.audioEncoderUnavailable",
              support.reason ?? "This browser has no AAC-LC encoder for the soundtrack.",
            );
          }
        }
        const controller = new AbortController();
        abortRef.current = controller;
        renderingRef.current = true;
        renderStartedAtRef.current = performance.now();
        setRendering(true);
        setCancelling(false);
        setCancelAvailable(true);
        setProgress({
          stage: "frames",
          completedFrames: 0,
          totalFrames: renderedFrameCount(liveRange),
          frameIndex: null,
        });
        setSpooledBytes(0);
        setElapsedMilliseconds(0);
        setRecentFramesPerSecond(null);
        // Cleared at the START of a take, so a warning that is still on screen always
        // describes the take you are looking at — a stale one from two renders ago would
        // be worse than none (§V421's shape, on a live surface).
        const collected: RuntimeDiagnostic[] = [];
        const onDiagnostic = (diagnostic: RuntimeDiagnostic): void => {
          collected.push(diagnostic);
        };
        let lastProgressAt = 0;
        const recentCompletions: Array<{ readonly completedFrames: number; readonly at: number }> = [];
        const onProgress = (next: RenderRangeProgress): void => {
          const now = performance.now();
          if (next.completedFrames > 0) {
            recentCompletions.push({ completedFrames: next.completedFrames, at: now });
            if (recentCompletions.length > 32) recentCompletions.shift();
          }
          if (
            next.completedFrames === 0 ||
            next.completedFrames === next.totalFrames ||
            now - lastProgressAt >= 100
          ) {
            lastProgressAt = now;
            setProgress({ stage: "frames", ...next });
            refreshElapsed(now);
            const first = recentCompletions[0];
            const last = recentCompletions[recentCompletions.length - 1];
            setRecentFramesPerSecond(
              first !== undefined && last !== undefined && last.at > first.at
                ? ((last.completedFrames - first.completedFrames) * 1000) / (last.at - first.at)
                : null,
            );
          }
        };
        const yieldToBrowser = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
        const onPreRollProgress = (completedPreRollFrames: number, totalPreRollFrames: number): void => {
          refreshElapsed();
          setProgress({
            stage: "preroll",
            completedFrames: 0,
            totalFrames: renderedFrameCount(liveRange),
            frameIndex: null,
            completedPreRollFrames,
            totalPreRollFrames,
          });
        };
        let lastSpoolProgressAt = Number.NEGATIVE_INFINITY;
        let latestSpoolBytes = 0;
        const onSpoolProgress = (writtenBytes: number): void => {
          latestSpoolBytes = writtenBytes;
          const now = performance.now();
          if (now - lastSpoolProgressAt < 100) return;
          lastSpoolProgressAt = now;
          setSpooledBytes(writtenBytes);
        };
        const onFinishProgress = (next: EncoderFinishProgress): void => {
          refreshElapsed();
          setRecentFramesPerSecond(null);
          setSpooledBytes(latestSpoolBytes);
          const frameProgress = {
            completedFrames: renderedFrameCount(liveRange),
            totalFrames: renderedFrameCount(liveRange),
            frameIndex: liveRange.end,
          };
          if (next.stage === "audio") {
            setProgress({
              stage: "audio",
              ...frameProgress,
              completedAudioFrames: next.completedFrames,
              totalAudioFrames: next.totalFrames,
            });
            return;
          }
          setProgress(next.stage === "video"
            ? { stage: "video", ...frameProgress }
            : { stage: "finalizing", ...frameProgress });
        };
        setDiagnostics([]);
        /*
         * T586's HONEST EDGE, WIDENED TO §V329's WHOLE PROPERTY (T645) — the things a take
         * is not allowed to be silent about, emitted through the SAME channel the
         * recorder's own diagnostics use so there is one answer to "what did this take
         * have to say".
         *
         * The three options were: diverge silently, force the lock silently, or say so.
         * Forcing it would hand back a DIFFERENT take from the one the user approved on
         * screen, which is worse than a warning; diverging silently is exactly the class
         * §V44/§V47 exists to prevent. So the take PROCEEDS and the warning names the
         * nodes — which is also why this is not a `refuse()`: `RenderRangeOutcome.refused`
         * is terminal by construction and would cancel the take.
         *
         * This is ONE call, not two: T586's free-run sentence is a clause of the same
         * warning that now also names live devices (Webcam, Audio In, Mouse) and async
         * readbacks (Analyze). A second diagnostic would be a second answer (§V109).
         */
        const notReproducible = nonReproducibleRenderWarning(live.graph, live.registry);
        if (notReproducible !== null) onDiagnostic(notReproducible);
        let preparedAudio: Awaited<ReturnType<NonNullable<UseRenderRangeInputs["prepareAudio"]>>> = null;
        let restoreAudioMonitor: (() => void) | null = null;
        let releasePreparation: (() => void) | undefined;
        let disposeRendered: (() => Promise<void>) | null = null;
        let capture: RenderCanvasCapture | null = null;
        try {
          restoreAudioMonitor = live.muteAudioMonitor?.() ?? null;
          const prepared = await live.beforeRender?.();
          if (prepared !== undefined) releasePreparation = prepared;
          if (controller.signal.aborted) throw new RenderRangeCancelledError();
          // A timeline-locked file drives visuals even when its PCM is excluded from the
          // MP4. Always await its deterministic pre-analysis before replay; inclusion
          // decides only whether the resulting PCM provider reaches the encoder.
          preparedAudio = liveAudioRequirement.kind === "required"
            ? await live.prepareAudio?.(
              liveRange,
              timelineFps,
              renderFps,
              controller.signal,
            ) ?? null
            : null;
          if (liveAudioRequirement.kind === "required" && preparedAudio === null) {
            throw new Error("The timeline audio file is not ready for deterministic export.");
          }
          if (controller.signal.aborted) throw new RenderRangeCancelledError();
          // T1741b: the canvas is 8-bit, so a 10-bit take has no canvas capture: the recorder
          // reads the Output at full precision through the export interface instead.
          const tenBit = videoFormatInfo(takeFormat).bitDepth === 10;
          capture = tenBit ? null : live.createCapture(described);
          const encoder = await (live.loadEncoder ?? loadVideoEncoder)(
            {
              format: takeFormat,
              ...(includeSoundtrack && preparedAudio !== null ? { audio: preparedAudio.pcm } : {}),
              ...(capture === null ? {} : { captureFrame: capture.captureFrame }),
              onFinishProgress,
              onSpoolProgress,
              yieldControl: yieldToBrowser,
              signal: controller.signal,
            },
          );
          if (encoder === null) {
            return refuse(
              "export.encoderUnavailable",
              `This browser cannot encode the requested ${videoFormatInfo(takeFormat).name}/AAC MP4.`,
              "WebCodecs video and AAC-LC encoders are required.",
            );
          }
          const rendered = await renderFrameRange({
            api,
            ref,
            range: liveRange,
            timelineFps,
            outputFps: renderFps,
            encoder,
            onDiagnostic,
            signal: controller.signal,
            onProgress,
            onPreRollProgress,
            preRollFrames: liveRenderSettings.preRollFrames ?? 0,
            yieldControl: yieldToBrowser,
            ...(live.onFrameRendered === undefined ? {} : { onFrameRendered: live.onFrameRendered }),
            transport: {
              isPlaying: transport.isPlaying,
              togglePlay: transport.togglePlay,
              seek: transport.seek,
              stepOnce: transport.stepOnce,
              latestFrame: live.latestFrame,
              resetAbsoluteClock: transport.resetAbsoluteClock,
              resetState: transport.resetState,
              ...(transport.prepareFrame === undefined ? {} : { prepareFrame: transport.prepareFrame }),
            },
          });
          disposeRendered = rendered.dispose ?? null;
          // The report, not the byte count, decides whether this take is what was asked
          // for: a file with the right number of frames and a gap in the middle is wrong
          // in the one way a video player will never show you.
          if (!rendered.report.contiguous) {
            return refuse(
              "export.rangeNotContiguous",
              `The take covers frames ${String(rendered.report.firstFrameIndex)}–${String(
                rendered.report.lastFrameIndex,
              )} but is missing ${String(rendered.report.missing.length)} of them.`,
            );
          }
          if (controller.signal.aborted) throw new RenderRangeCancelledError();
          setProgress({
            stage: "saving",
            completedFrames: rendered.report.frames,
            totalFrames: renderedFrameCount(liveRange),
            frameIndex: liveRange.end,
          });
          refreshElapsed();
          await yieldToBrowser();
          if (controller.signal.aborted) throw new RenderRangeCancelledError();
          const output = {
            fileName: videoFileName(live.name(), liveRenderSettings.resolution, liveRange.start, liveRange.end),
            text: rendered.bytes,
            mime: "video/mp4",
            pickerTypes: VIDEO_PICKER_TYPES,
          };
          const beginSaveCommit = (): void => {
            if (abortRef.current === controller) abortRef.current = null;
            setCancelAvailable(false);
          };
          const injectedWriter = live.write;
          if (injectedWriter !== undefined) beginSaveCommit();
          const outcome = injectedWriter === undefined
            ? await preparedWrite!.write(output, controller.signal, beginSaveCommit)
            : await injectedWriter(output);
          if (outcome.kind === "cancelled" && controller.signal.aborted) {
            throw new RenderRangeCancelledError();
          }
          if (outcome.kind === "failed") {
            return refuse("export.writeFailed", `The rendered range could not be written: ${outcome.reason}`);
          }
          return {
            kind: "rendered",
            frames: rendered.report.frames,
            // Cancelling the picker is not a failure — the frames were rendered, and the
            // count says so while the missing name says the file was not kept.
            fileName: outcome.kind === "saved" ? outcome.fileName : null,
          };
        } catch (error) {
          if (error instanceof RenderRangeCancelledError || controller.signal.aborted) {
            return {
              kind: "refused",
              diagnostic: {
                severity: "info",
                code: "export.renderCancelled",
                message: "Video render cancelled. No partial file was saved.",
              },
            };
          }
          if (error instanceof ExportError) return { kind: "refused", diagnostic: error.diagnostic };
          return refuse(
            "export.renderFailed",
            `The video render failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          try {
            await disposeRendered?.();
          } catch (error) {
            collected.push({
              severity: "warning",
              code: "export.cleanupFailed",
              message: `The temporary render file could not be removed: ${error instanceof Error ? error.message : String(error)}`,
            });
          } finally {
            capture?.dispose();
            preparedAudio?.close();
            restoreAudioMonitor?.();
            releasePreparation?.();
            if (abortRef.current === controller) abortRef.current = null;
            renderingRef.current = false;
            refreshElapsed();
            renderStartedAtRef.current = null;
            setRendering(false);
            setCancelling(false);
            setCancelAvailable(false);
            // In `finally`, because a take that refused halfway still rendered frames under
            // a free-run playhead and the user still deserves to be told which node.
            setDiagnostics(collected);
          }
        }
      },
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [inputs.bus, refreshElapsed, setRenderSettings]);

  const cancel = useCallback(() => {
    if (abortRef.current === null) return;
    setCancelling(true);
    abortRef.current.abort();
  }, []);
  const prepareDestination = useCallback(async (): Promise<boolean> => {
    if (inputsRef.current.write !== undefined) return true;
    const range = renderSettingsRef.current.range;
    const outcome = await prepareFileWrite({
      fileName: videoFileName(
        inputsRef.current.name(),
        renderSettingsRef.current.resolution,
        range.start,
        range.end,
      ),
      pickerTypes: VIDEO_PICKER_TYPES,
    });
    if (outcome.kind === "ready") {
      preparedWriteRef.current = outcome.destination;
      return true;
    }
    preparedWriteRef.current = null;
    if (outcome.kind === "failed") {
      setDiagnostics([{
        severity: "error",
        code: "export.saveDestinationUnavailable",
        message: `The video destination could not be opened: ${outcome.reason}`,
      }]);
    }
    return false;
  }, []);
  const setIncludeAudio = useCallback((include: boolean) => {
    setIncludeAudioState(include);
  }, []);
  const described = sink === null ? null : inputs.exports?.describe(sink) ?? null;
  const outputReady = described !== null &&
    described.width === renderSettings.resolution.width &&
    described.height === renderSettings.resolution.height;
  const sourceRefusal = described === null ? null : videoFormatSourceRefusal(format, described.format);
  return {
    rendering,
    cancelling,
    cancelAvailable,
    frames: sink === null ? 0 : totalFrames,
    diagnostics,
    progress,
    elapsedMilliseconds,
    recentFramesPerSecond,
    spooledBytes,
    // Both reasons when both hold, so fixing one does not uncover the other one take later.
    encoderSupport: encoderSupport !== null && sourceRefusal !== null
      ? {
          ...encoderSupport,
          supported: false,
          reason: encoderSupport.supported ? sourceRefusal : `${encoderSupport.reason ?? ""} ${sourceRefusal}`.trim(),
        }
      : encoderSupport,
    audioSupport,
    audioRequirement,
    includeAudio: includeAudio && hasAudioSource,
    setIncludeAudio,
    outputReady,
    cancel,
    prepareDestination,
    renderSettings,
    setRenderSettings,
  };
}

/**
 * The graph's declared sink, port-scoped (§V59, §V28b).
 *
 * Same rule the viewer applies, and deliberately the same answer: what you render out is
 * what the viewer shows. Two ways of choosing "the output" would be two products.
 *
 * `presentsPicture` and not `isDeclaredSink` for the reason `prune.ts` records: Analyze
 * and Laser Out declare `sink: true` as well, and the `$target` synthesized for them is
 * a full-size texture nothing ever writes. E14 would have exported it — its Analyze is
 * named `meter`, its Output `out`, and `plan.outputs` is ordered by node id.
 */
function declaredSink(
  compiled: CompiledGraph | null,
  graph: GraphDocument,
  registry: NodeRegistryView,
): OutputRef | null {
  for (const output of compiled?.outputs ?? []) {
    const type = graph.nodes[output.nodeId]?.type;
    const definition = type === undefined ? undefined : registry.get(type);
    if (definition !== undefined && presentsPicture(definition)) {
      return { nodeId: output.nodeId, portId: output.portId };
    }
  }
  return null;
}
