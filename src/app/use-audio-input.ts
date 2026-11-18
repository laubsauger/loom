import { useCallback, useEffect, useRef } from "react";
import type { AudioFeatures, FrameEvaluationInput } from "@domain/types/frame.ts";
import type { FlatGraph, FrameRange, GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { NO_FLATTENING, type FlatteningReads } from "@domain/parameters/node-references.ts";
import { parameterReadOptions, resolveParameters } from "@domain/parameters/index.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { createHopAnalyser } from "@domain/audio/analysis/hop-analyser.ts";
import { createLeadPitch } from "@domain/audio/analysis/pitch.ts";
import { createTonalAnalyser } from "@domain/audio/analysis/tonal-analyser.ts";
import { mediaTransportFrom, type MediaPlayhead, type MediaTransportValues } from "@domain/media/transport.ts";
import { awaitMediaReady } from "./media-sources.ts";
import { appAudioContext, appProgramOutput } from "./app-audio-context.ts";
import { createAudioHopReducer } from "./audio-analysis-frame.ts";
import {
  AUDIO_ANALYSIS_PROCESSOR_NAME,
  analysisOptionsFor,
  inputGainLinear,
  type AudioAnalysisProcessorOptions,
  type AudioAnalysisStopMessage,
  type AudioAnalysisWorkletMessage,
  type DetectorSettings,
} from "./audio-analysis-protocol.ts";
import { AUDIO_ANALYSIS_WORKLET_URL } from "./audio-analysis-worklet-url.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { MediaControlRegistry } from "./media-commands.ts";
import { audioLatencyEstimate, type AudioLatencyEstimate } from "./audio-latency.ts";
import { createPreAnalyser, readTrackAtPlayhead } from "./audio-pre-analysis.ts";
import { captureAudioConstraints, captureConfigOf, captureProcessingMessage, inputGainDbOf, staticValueOf, syncLeadOf, urlOf, type CaptureConfig } from "./audio-capture-config.ts";
export { captureConfigOf, inputGainDbOf, syncLeadOf, type CaptureConfig } from "./audio-capture-config.ts";
import type { OfflineAnalysis } from "./audio-offline-analysis.ts";
import { createOfflineAudioCapture } from "./offline-render-audio.ts";
import type { OfflineAudioCapture } from "./offline-render-audio.ts";
import type { AudioPcmProvider } from "@runtime/export/index.ts";
import {
  applyMediaPlayhead,
  createMediaTransportRunner,
  durationOf,
  type MediaTransportRunner,
  type PlayableMedia,
} from "./media-playback.ts";

/**
 * T414: the session's ONE audio capture (§V182's one-listener rule, with sound).
 *
 * Watches the document for `audioIn` nodes and keeps exactly one capture chain alive —
 * mic or file, configured by the first such node by id. The hook exposes a per-frame
 * feature reader the frame driver calls each tick; features cross into the engine
 * through `FrameInputs.audio` and NOWHERE else, which is the entire determinism seam
 * (§V45, §V329 — see `AudioFeatures` in frame.ts: a replay feeds a recorded feature
 * track through the same field; this hook is only the LIVE way of producing one).
 *
 * The analyser's own smoothing is set to ZERO on purpose: smoothing belongs to the
 * value graph (`valueLag`), where the user can have both the raw transient and the
 * damped envelope. A pre-smoothed source would silently deny them the raw one.
 *
 * T1226 — the ANALYSIS runs on the audio thread. The input feeds two things: the
 * analyser, and an `AudioWorkletNode` running the engine (`audio-analysis.worklet.ts`)
 * at a fixed 512-sample hop. `read()` reduces the hops that arrived since the previous
 * frame (`audio-analysis-frame.ts`), so a transient between two rAFs is counted instead
 * of missed. The analyser stays in the chain for two reasons: it is the NAMED fallback
 * when the worklet cannot load (§V288 — the status says so, and `polledReader` below
 * runs the SAME engine core on the analyser's window once per frame, so every field of
 * the record is produced by the same code on both paths, T1225/T1227).
 *
 * T1769b — THE TRIM. One `GainNode` sits between the source and BOTH of those: the source
 * node's Input Gain, so the worklet engine, the polled fallback and the tonal pass all hear
 * the trimmed signal and no consumer scales anything itself. A file's monitor is tapped off
 * the SOURCE, beside the trim, so the two levels never cross (see the placement note below).
 *
 * Failure is LOUD but not fatal: a denied microphone or an unloadable URL parks the
 * capture in an error status (readable for UI) and the reader returns null — the same
 * deterministic silence a session with no audio has, never a half-working stream.
 *
 * T1229 — a bound FILE is also PRE-ANALYSED (`audio-pre-analysis.ts`: the same engine
 * walked over the decoded file into a playhead-indexed `FeatureTrack`). Under
 * `playMode: timeline` `read(frame)` answers from that track at the frame the playhead is
 * on, not from the live hops — so a scrub lands on the same record every time and an
 * offline render of the timeline is exact (§T431's replay half, with a real consumer).
 * Under `freeRun` the live path stays: a free-running element has no timeline position
 * to index by.
 *
 * What "bit-exact scrub" covers, precisely: with a STATIC transport (no driven `speed`,
 * `trimStart`, `cue`…) the record at timeline time t is a pure function of t, absolute.
 * With a DRIVEN transport parameter the playhead for frame N is computed from the transport
 * as resolved on frame N − 1's channels (§V887's Jacobi order — the only one that is not
 * circular, since this frame's channels are themselves fed by this read), so a random
 * scrub to N can differ from reaching N by playing. And §B187 stands: `mediaPlayhead`
 * takes `elapsed × speed`, not the integral, so a driven speed already moves the
 * position retroactively; this reads the same position the element is at.
 */

/** §V288: the fallback is taken AND named. Anything reading "Live" with this beside it is on the polled path. */
export function workletFallbackMessage(reason: string): string {
  return `Analysis worklet unavailable (${reason}); polling the analyser's window once per frame.`;
}

/** One frame's record, from whichever path is live. */
type FeatureReader = () => AudioFeatures;

/**
 * T1227 — the polled path IS the engine, at frame rate. `getFloatTimeDomainData` returns
 * the very window the analyser's own FFT would take, and `createHopAnalyser` turns it
 * into the analyser-shaped bytes (T1225 measured the parity) AND the detector streams,
 * so the v2 fields are never a silent hole when the worklet is missing. What degrades
 * is fidelity and nothing else: one window per frame instead of four, and the picker's
 * hop-counted history and gap are counted in frames — which the status names.
 */
/**
 * T1752b — the polled path runs the TONAL pass too, on the same core. The analyser is opened
 * at the tonal window's size when the capture asks for the pass (`polledAnalyserSize`), so
 * one read hands back the long window; the hop core takes the LAST `fftSize` samples of it,
 * which are the samples it always took, so the bands do not move. The tonal core runs when
 * a whole tonal hop of samples has gone by since it last ran — the worklet's grid, kept by
 * the context's own clock — and is told how many samples that was, its only clock.
 */
export function polledAnalyserSize(options: AudioAnalysisProcessorOptions): number {
  return Math.max(options.fftSize, options.tonal?.windowSize ?? 0);
}

/** The slices of `AudioContext` and `AnalyserNode` the polled path reads, so a test can hand in plain objects. */
export interface PolledClock {
  readonly sampleRate: number;
  readonly currentTime: number;
}
export interface PolledAnalyser {
  readonly fftSize: number;
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void;
}

export function polledReader(
  context: PolledClock,
  analyser: PolledAnalyser,
  options: AudioAnalysisProcessorOptions,
): FeatureReader {
  const core = createHopAnalyser({
    fftSize: options.fftSize,
    sampleRate: context.sampleRate,
    bands: options.bands,
    eventThreshold: options.eventThreshold,
    superflux: options.superflux,
    picker: options.picker,
  });
  const reducer = createAudioHopReducer(options.fftSize, context.sampleRate);
  const samples = new Float32Array(analyser.fftSize);
  if (samples.length < polledAnalyserSize(options)) {
    throw new Error(`polled analysis: the analyser holds ${samples.length} samples, and the engine needs ${polledAnalyserSize(options)}`);
  }
  const short = samples.subarray(samples.length - options.fftSize);
  const tonal = options.tonal === undefined ? null : { ...options.tonal, core: createTonalAnalyser({ sampleRate: context.sampleRate, windowSize: options.tonal.windowSize }) };
  const long = tonal === null ? samples : samples.subarray(samples.length - tonal.windowSize);
  // T1755b: the lead pitch off the hop core's window, once per frame here (a frame is about a hop and a half).
  const leadPitch = tonal === null ? null : createLeadPitch({ sampleRate: context.sampleRate, windowSize: options.fftSize, hop: Math.round(context.sampleRate / 60), everyHops: 1 });
  /** The context's sample count at the last tonal window, or null before the first. */
  let tonalAt: number | null = null;
  return () => {
    analyser.getFloatTimeDomainData(samples);
    reducer.push(core.analyse(short));
    const pitched = leadPitch?.push(short) ?? null;
    if (pitched !== null) reducer.pushPitch(pitched);
    if (tonal !== null) {
      const at = Math.round(context.currentTime * context.sampleRate);
      if (tonalAt === null || at - tonalAt >= tonal.hop) {
        reducer.pushTonal(tonal.core.analyse(long, tonalAt === null ? 0 : at - tonalAt));
        tonalAt = at;
      }
    }
    return reducer.read().features;
  };
}

type EngineAttachment = { readonly node: AudioWorkletNode; readonly read: FeatureReader } | { readonly failure: string };

/** §T1548b: the analysis worklet module, added once per context. */
const workletModules = new WeakMap<BaseAudioContext, Promise<void>>();

/**
 * T1226 — the engine on `context`'s audio thread, or the reason it could not be. Never
 * throws: a missing `audioWorklet` (an old WebView), a rejected `addModule` (the chunk
 * did not load) and a bad option all become the fallback's named reason.
 */
async function attachAnalysisEngine(
  context: AudioContext,
  options: AudioAnalysisProcessorOptions,
): Promise<EngineAttachment> {
  try {
    if (context.audioWorklet === undefined) throw new Error("AudioWorklet is not supported here");
    // §T1548b: the context is the app's one (`appAudioContext`) and outlives a capture, so
    // the module is added once per context, not once per capture.
    let loaded = workletModules.get(context);
    if (loaded === undefined) {
      loaded = context.audioWorklet.addModule(AUDIO_ANALYSIS_WORKLET_URL);
      workletModules.set(context, loaded);
      void loaded.catch(() => workletModules.delete(context));
    }
    await loaded;
    const node = new AudioWorkletNode(context, AUDIO_ANALYSIS_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      // Mono, as the analyser hears it: its analysis down-mixes too.
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: options,
    });
    const reducer = createAudioHopReducer(options.fftSize, context.sampleRate);
    node.port.onmessage = (event: MessageEvent<AudioAnalysisWorkletMessage>) => {
      if (event.data.type === "hop") reducer.push(event.data);
      else if (event.data.type === "tonal") reducer.pushTonal(event.data);
      else if (event.data.type === "pitch") reducer.pushPitch(event.data);
    };
    return { node, read: () => reducer.read().features };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

export interface AudioInputStatus {
  readonly kind: "idle" | "live" | "error";
  readonly message?: string;
  /**
   * T1319b — what the live context says its output latency is, paired with one frame at the
   * project rate. A FLOOR on the true audio-to-picture offset (§V985): it cannot see the
   * render and display path. Null while nothing is capturing, or where the browser reports
   * no latency at all — absent rather than zero, because those are different facts.
   *
   * Structured rather than folded into `message` on purpose: a control that applies this
   * number must read a number, not parse its own sentence.
   */
  readonly latency?: AudioLatencyEstimate | null;
}

/** T1229: one cache for the session — a re-bound file is a hit, not a second walk. */
const preAnalyser = createPreAnalyser();

async function preAnalyseFile(config: CaptureConfig, fps: number): Promise<Awaited<ReturnType<typeof preAnalyser.analyse>>> {
  const response = await fetch(config.url);
  if (!response.ok) throw new Error(`the file could not be read (${String(response.status)})`);
  return preAnalyser.analyse(await response.arrayBuffer(), fps, config.detector, config.tonal, config.inputGainDb);
}

/**
 * T1229 — the status line's sentence, numbers a person can copy into the node's Declared
 * knobs (T1228): the bar estimate lives HERE and not in the record, on purpose.
 */
export function preAnalysisMessage(analysis: OfflineAnalysis): string {
  const { tempo, bar } = analysis;
  if (tempo.confidence <= 0) return "Pre-analysed: no tempo found.";
  const parts = [`${tempo.bpm.toFixed(1)} BPM (confidence ${tempo.confidence.toFixed(2)})`];
  if (bar.beatsPerBar > 0) parts.push(`${String(bar.beatsPerBar)} beats per bar, downbeat at ${bar.downbeatSeconds.toFixed(2)} s`);
  return `Pre-analysed: ${parts.join(", ")}.`;
}

export interface AudioInputSource {
  /** Per-frame reader for the frame driver. Null while no capture is live. */
  readonly read: (frame: FrameEvaluationInput) => AudioFeatures | null;
  /** T1229: the detector knobs of the live capture, for a track's provenance. Null between captures. */
  readonly detector: () => DetectorSettings | null;
  readonly status: () => AudioInputStatus;
  /**
   * T493 — put the file where its transport says, once per rendered frame.
   *
   * The movie node's `sync` verbatim, and deliberately so: both doors call
   * `applyMediaPlayhead` with a head from the same `mediaPlayhead`, so "cue" cannot come
   * to mean one thing for pictures and another for sound.
   */
  readonly sync: (frame: FrameEvaluationInput, channels?: ChannelResolver) => void;
  /** A replay starts from the document's retained transport, never the prior live frame. */
  readonly reset: () => void;
  /** The app transport stopped: hold the file rather than letting it run on unwatched. */
  readonly setRunning: (running: boolean) => void;
  /** Prepares the bound timeline-locked file for deterministic audible export. */
  readonly prepareRenderAudio: (
    range: FrameRange,
    timelineFps: number,
    outputFps: number,
    signal: AbortSignal,
  ) => Promise<PreparedRenderAudio | null>;
  /** Silence speaker monitoring for a take without disconnecting analysis. Returns restore. */
  readonly muteMonitorForRender: () => (() => void);
  readonly renderAudioRequirement: () => RenderAudioRequirement;
}

export type RenderAudioRequirement =
  | { readonly kind: "none" }
  | { readonly kind: "required" }
  | { readonly kind: "invalid"; readonly reason: string };

export interface PreparedRenderAudio {
  readonly pcm: AudioPcmProvider;
  close(): void;
}

/** Monitoring is the speaker path only: it never reaches the analysis (which hears the source through the Input Gain trim, T1769b) or the exported PCM (unity). */
export function monitorGainLevel(level: number, renderMuted: boolean): number {
  return renderMuted ? 0 : level;
}

/**
 * Offline audio is read from pre-decoded PCM, so the browser media element has no render
 * job. Letting it play on wall time forces a corrective seek on nearly every slow offline
 * frame and queues decoder work that grows through the take.
 */
export function syncAudioMediaElement(
  element: PlayableMedia,
  transport: MediaTransportValues,
  head: MediaPlayhead,
  offlineRender: boolean,
  continuous?: boolean,
  correction?: number,
): boolean {
  if (!offlineRender) return applyMediaPlayhead(element, transport, head, continuous, correction);
  if (!element.paused) element.pause();
  return false;
}

export interface AudioReplayBaseline {
  readonly transport: MediaTransportValues;
  readonly leadSeconds: number;
}

/** The deterministic state frame zero reads before driven channels have produced a value. */
export function audioReplayBaselineOf(
  graph: GraphDocument,
  nodeId: NodeId,
): AudioReplayBaseline | null {
  const node = graph.nodes[nodeId];
  if (node === undefined) return null;
  const readStatic = (key: string): ParameterValue | undefined => {
    return staticValueOf(node, key) as ParameterValue | undefined;
  };
  return {
    transport: mediaTransportFrom(readStatic),
    leadSeconds: syncLeadOf(readStatic),
  };
}

/** The string a capture is identified by: equal keys keep the capture, anything else rebuilds it. */
export function captureKeyOf(config: CaptureConfig | null, reloadToken: number, analysisFps?: number): string {
  if (config === null) return "";
  const { detector } = config;
  // T1769b: a file's Input Gain is walked into its pre-analysed track, so it rebuilds; a
  // microphone's is a live value on the trim node and must not.
  const analysisGrid = config.source === "file" ? `|${String(analysisFps ?? "none")}|${String(config.inputGainDb)}` : "";
  return `${config.source}|${config.url}|${config.device}|${config.voiceProcessing ? "voice" : "raw"}|${config.monitor}|${detector.threshold}|${detector.retrigger}|${config.tonal ? "tonal" : "plain"}|${reloadToken}${analysisGrid}`;
}

/**
 * T434: which capture the session runs. An `audioFileIn` with a file BOUND takes
 * precedence — a bound file is deliberate authoring, where a mic node is often just
 * present — otherwise the first `audioIn` by node id opens the microphone with its
 * device selection. Exported pure so the precedence is pinned by test.
 */
/** B74: an audioFileIn with no file is a node WAITING — the status must say so. */
export function hasUnboundAudioFile(graph: GraphDocument): boolean {
  return Object.values(graph.nodes).some(
    (node) =>
      node.type === "audioFileIn" &&
      // T555: a node that is OFF is not waiting for anything. "Waiting for a file" beside
      // a muted node would be the panel asking for something it would then ignore.
      !isSilencedSource(node as GraphNode) &&
      urlOf(staticValueOf(node as GraphNode, "file")).trim() === "",
  );
}

export function renderAudioRequirementOf(graph: GraphDocument): RenderAudioRequirement {
  const config = captureConfigOf(graph);
  if (config === null) return { kind: "none" };
  if (config.source !== "file" || config.nodeId === null) {
    return { kind: "invalid", reason: "Live microphone audio cannot be reproduced offline." };
  }
  const node = graph.nodes[config.nodeId];
  if (node === undefined || staticValueOf(node, "playMode") !== "timeline") {
    return { kind: "invalid", reason: "Audio File In must be Locked to Timeline." };
  }
  return { kind: "required" };
}

interface LiveCapture {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly dispose: () => void;
  /** T493: present only for a file capture — a mic has no playhead to drive. */
  readonly element?: PlayableMedia;
  /** T493: monitoring level, on a branch of its own off the source, so volume never rescales the channels. */
  readonly gain?: GainNode;
  /** T1769b: the Input Gain, between the source and every analysis consumer. */
  readonly trim: GainNode;
}

/**
 * T1769b — the time constant a changed Input Gain is approached with on the audio thread.
 * A step in gain is a step in the signal, which the onset detectors would count as a hit of
 * its own; 20 ms settles within a few hops and is far below anything a hand does to a slider.
 */
export const INPUT_GAIN_SMOOTHING_SECONDS = 0.02;

/**
 * T1769b: the capturing node's Input Gain as resolved on this frame, in decibels — or its
 * value at rest where nothing can resolve it (no registry: a test that pins capture alone).
 */
export function resolvedInputGainDb(
  config: CaptureConfig,
  frame: FrameEvaluationInput,
  graph: FlatGraph,
  registry: AppRuntime["registry"] | undefined,
  channels: ChannelResolver | undefined,
  flattening: FlatteningReads,
): number {
  const node = graph.nodes[config.sourceNodeId];
  const definition = node === undefined ? undefined : registry?.get(node.type);
  if (node === undefined || definition === undefined || registry === undefined) return config.inputGainDb;
  const resolved = resolveParameters(node, definition, parameterReadOptions({ graph, registry, frame, channels, flattening }));
  return inputGainDbOf((key) => resolved.get(key)?.value);
}

export function useAudioInput(
  getGraph: () => FlatGraph,
  /**
   * T493 — the node registry, so transport parameters resolve through the ONE read path
   * (§V61) and take every mode. Optional because `captureConfigOf` and the analysis half
   * need nothing from it, and a test that only pins capture precedence should not have to
   * build a registry to do it.
   */
  registry?: AppRuntime["registry"],
  /** T493: where `media.cue` and `media.reload` find the node that supplied the file. */
  controls?: MediaControlRegistry,
  /** T1229: the project's frame rate — the grid a file is pre-analysed on. Absent, no file is pre-analysed. */
  fps?: () => number,
  /**
   * §T1559b: the flattening the graph `getGraph` returns came out of, whole — the preset
   * morphs in flight (T1524b: a transport parameter or the volume a bank is fading follows
   * the fade) and the instances `op('<instance>').chan.<c>` names (T1485b). Absent (a test
   * that pins capture alone), the transport reads with `NO_FLATTENING`.
   */
  getFlattening?: () => FlatteningReads,
): AudioInputSource {
  const captureRef = useRef<LiveCapture | null>(null);
  const configRef = useRef<CaptureConfig | null>(null);
  /** T1229: the bound file's playhead-indexed track, once the walk has finished. Null until then, and for a mic. */
  const offlineRef = useRef<OfflineAnalysis | null>(null);
  const pcmRef = useRef<Awaited<ReturnType<typeof preAnalyser.analyse>>["pcm"] | null>(null);
  const preAnalysisPendingRef = useRef<Promise<Awaited<ReturnType<typeof preAnalyser.analyse>>> | null>(null);
  const renderCaptureRef = useRef<OfflineAudioCapture | null>(null);
  const renderMutedRef = useRef(false);
  const monitorLevelRef = useRef(1);
  /** T1769b: the Input Gain the live trim was last sent to, in decibels. */
  const trimDbRef = useRef(0);
  /** T1229: the transport as `sync` last resolved it — the previous frame's channels (§V887). */
  const transportRef = useRef<MediaTransportValues | null>(null);
  /** T1312b: the capturing node's sync offset, resolved with the transport it belongs to. */
  const leadRef = useRef(0);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const statusRef = useRef<AudioInputStatus>({ kind: "idle" });
  /** T1226: the live path's reader — the worklet's reducer, or the polled engine. Null between captures. */
  const readerRef = useRef<FeatureReader | null>(null);
  const configKeyRef = useRef<string>("");
  const getGraphRef = useRef(getGraph);
  getGraphRef.current = getGraph;
  const getFlatteningRef = useRef(getFlattening);
  getFlatteningRef.current = getFlattening;
  const registryRef = useRef(registry);
  registryRef.current = registry;
  /** T493: the transport of the node whose file is playing. Null for a mic. */
  const runnerRef = useRef<MediaTransportRunner | null>(null);
  const channelsRef = useRef<ChannelResolver | undefined>(undefined);
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  /** Undoes this capture's control registration. Torn down with the capture itself. */
  const releaseControlRef = useRef<(() => void) | null>(null);
  /**
   * T493 — a `reload` re-acquires. Bumping this makes the config key differ, which is the
   * SAME door a changed file goes through, so there is one teardown/acquire path rather
   * than a second one that can drift out of step with it.
   */
  const reloadTokenRef = useRef(0);
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;

    const teardown = (): void => {
      captureRef.current?.dispose();
      captureRef.current = null;
      configRef.current = null;
      offlineRef.current = null;
      pcmRef.current = null;
      preAnalysisPendingRef.current = null;
      renderCaptureRef.current = null;
      monitorLevelRef.current = 1;
      transportRef.current = null;
      readerRef.current = null;
      runnerRef.current = null;
      releaseControlRef.current?.();
      releaseControlRef.current = null;
      statusRef.current = { kind: "idle" };
    };

    const acquire = async (config: CaptureConfig): Promise<void> => {
      /*
       * §T1548b — the app's ONE context, shared with movie sound, so it is never closed
       * here: a capture that ends disconnects the nodes it made (`release`) and leaves the
       * context to the movies routed into it. That disconnect is what takes a muted node off
       * the speakers (T555).
       */
      const context = appAudioContext();
      if (context === null) {
        statusRef.current = { kind: "error", message: "This browser has no Web Audio." };
        return;
      }
      const nodes: AudioNode[] = [];
      const made = <T extends AudioNode>(node: T): T => {
        nodes.push(node);
        return node;
      };
      let stopEngine = (): void => undefined;
      const release = (): void => {
        stopEngine();
        stopEngine = () => undefined;
        for (const node of nodes) node.disconnect();
        nodes.length = 0;
      };
      const analyser = made(context.createAnalyser());
      // The engine's window, so the polled fallback analyses exactly what the worklet would.
      analyser.fftSize = polledAnalyserSize(analysisOptionsFor(config.detector, context.sampleRate, config.tonal));
      // Zero: valueLag downstream owns smoothing; the default 0.8 would pre-damp
      // every transient before a trigger could see it.
      analyser.smoothingTimeConstant = 0;
      /*
       * T1769b — THE TRIM SITS AHEAD OF EVERY ANALYSIS CONSUMER, and it is a node in the
       * graph rather than a factor inside each analysis.
       *
       * The analyser (the polled fallback's window) and the worklet (the hop engine and the
       * tonal pass) are both fed from this one node, so there is one place the level is set
       * and none of the three can be forgotten. As an `AudioParam` it is ramped on the audio
       * thread, sample-accurate, with no message to the worklet and no rebuild. The graph
       * carries floats, so a trimmed signal above full scale passes through unclipped; what
       * saturates is the analysers' own byte map (`stft.ts`: a sample past ±1 reads the end
       * of the time-domain byte, a bin past -30 dB reads 255), exactly as an input that
       * arrived that loud would.
       */
      const trim = made(context.createGain());
      trim.gain.value = inputGainLinear(config.inputGainDb);
      trimDbRef.current = config.inputGainDb;
      trim.connect(analyser);

      /*
       * T1226: the engine first — it depends on nothing the source does, and a fallback
       * message must be decided before the status goes "live" below. `messages` collects
       * every reason the live status has to name; there can be two (device AND worklet).
       */
      const messages: string[] = [];
      // T1230: the source's detector knobs, on this context's hop grid — both paths get the same picker.
      const options = analysisOptionsFor(config.detector, context.sampleRate, config.tonal);
      const engine = await attachAnalysisEngine(context, options);
      if ("failure" in engine) messages.push(workletFallbackMessage(engine.failure));
      else {
        made(engine.node);
        // The processor runs until told otherwise; the context outlives this capture.
        const stop: AudioAnalysisStopMessage = { type: "stop" };
        stopEngine = () => {
          engine.node.port.onmessage = null;
          engine.node.port.postMessage(stop);
        };
      }
      const attachEngine = (input: AudioNode): void => {
        if ("failure" in engine) {
          readerRef.current = polledReader(context, analyser, options);
          return;
        }
        input.connect(engine.node);
        readerRef.current = engine.read;
        engine.node.onprocessorerror = () => {
          // The processor threw on the audio thread: it posts nothing from here on, and
          // a reader left on it would report silence forever. Same fallback, same name.
          if (readerRef.current !== engine.read) return;
          readerRef.current = polledReader(context, analyser, options);
          statusRef.current = { kind: "live", message: workletFallbackMessage("the processor failed") };
        };
      };
      if (cancelled) {
        release();
        return;
      }

      try {
        if (config.source === "mic") {
          /*
           * T434: an exact deviceId when one is chosen. A device that vanished
           * mid-session (unplugged) throws OverconstrainedError; falling back to the
           * default silently would leave the picker lying about what is live, so the
           * fallback is taken AND the status names it.
           */
          let stream: MediaStream;
          /*
           * T1776b: the device is asked for RAW unless the node's Voice Processing is on.
           * `{ audio: true }` took the browser's defaults, which are a telephone's (echo
           * cancellation, noise suppression, automatic gain), on every path including the
           * fallback below. The three are plain (ideal) constraints, so they can never be the
           * reason a device is refused; only the exact deviceId can.
           */
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: captureAudioConstraints(config.voiceProcessing, config.device) });
          } catch (constrained) {
            if (config.device.trim() === "" || (constrained as { name?: string }).name !== "OverconstrainedError") throw constrained;
            stream = await navigator.mediaDevices.getUserMedia({ audio: captureAudioConstraints(config.voiceProcessing, "") });
            messages.push("The selected device is unavailable; using the system default.");
          }
          // A constraint is a request: read back what the track was granted and name the difference (§V288).
          const processing = captureProcessingMessage(config.voiceProcessing, stream.getAudioTracks()[0]?.getSettings() as Record<string, unknown> | undefined);
          if (processing !== null) messages.push(processing);
          if (cancelled) {
            for (const track of stream.getTracks()) track.stop();
            release();
            return;
          }
          const input = made(context.createMediaStreamSource(stream));
          // T1769b: through the trim, and nowhere else — a live input is never routed to the
          // speakers, so no gain here can feed back or change what is heard.
          input.connect(trim);
          attachEngine(trim);
          captureRef.current = {
            context,
            analyser,
            trim,
            dispose: () => {
              for (const track of stream.getTracks()) track.stop();
              release();
            },
          };
        } else {
          if (config.url.trim() === "") {
            statusRef.current = { kind: "error", message: "File source needs a URL." };
            release();
            return;
          }
          const element = new Audio();
          element.crossOrigin = "anonymous";
          // T493: `element.loop = true` used to live here and was the whole transport —
          // looping you could not turn off, with no parameter naming it. `extend` owns
          // wrapping now, and the element's own loop would fight every seek.
          element.loop = false;
          element.src = config.url;
          const input = made(context.createMediaElementSource(element));
          input.connect(trim);
          attachEngine(trim);
          /*
           * T493 — VOLUME IS NOT UPSTREAM OF THE ANALYSER, and that placement is the feature.
           *
           * The analysis gets the file whatever the monitoring level is, so turning the room
           * down does not silently rescale every parameter driven by `level`. A volume node
           * upstream of the analyser would have made the volume slider a hidden master fader
           * on the whole graph — the plausible-wrong wiring, with no error to find it by.
           *
           * T1769b — and the mirror: THE MONITOR IS NOT DOWNSTREAM OF THE TRIM. It used to
           * hang off the analyser's output, which was the source at unity; the analyser now
           * sits behind the Input Gain, so the monitor is tapped off the SOURCE instead. Two
           * branches from one source: source → trim → analysis, source → volume → speakers.
           * Raising the Input Gain by 40 dB therefore moves no loudspeaker.
           */
          const gain = made(context.createGain());
          gain.gain.value = monitorGainLevel(monitorLevelRef.current, renderMutedRef.current);
          input.connect(gain);
          // §T1809b: through the program bus, so a stream can carry what is heard.
          if (config.monitor) gain.connect(appProgramOutput(context));
          // T493/§V369: kicked, never AWAITED. `play()` on a source that never decodes
          // stays pending forever, so awaiting it left the capture in `idle` — reading
          // exactly like "everything is fine" — for a file that could not be opened.
          // `awaitMediaReady` is the half that can actually fail, and it does so by name.
          void element.play().catch(() => undefined);
          await awaitMediaReady(element);
          if (cancelled) {
            element.pause();
            release();
            return;
          }
          captureRef.current = {
            context,
            analyser,
            element,
            gain,
            trim,
            dispose: () => {
              element.pause();
              element.src = "";
              release();
            },
          };
          const nodeId = config.nodeId;
          const nodeRegistry = registryRef.current;
          if (nodeId !== null && nodeRegistry !== undefined) {
            const runner = createMediaTransportRunner(nodeId, {
              graph: () => getGraphRef.current(),
              registry: nodeRegistry,
              channels: () => channelsRef.current,
              flattening: () => getFlatteningRef.current?.() ?? NO_FLATTENING,
            });
            runnerRef.current = runner;
            releaseControlRef.current =
              controlsRef.current?.register(nodeId, {
                cue: () => runner.cue(),
                reload: () => {
                  reloadTokenRef.current += 1;
                  refreshRef.current?.();
                },
              }) ?? null;
          } else {
            runnerRef.current = null;
          }
        }
        configRef.current = config;
        const publish = (extra: string | null): void => {
          const all = extra === null ? messages : [...messages, extra];
          statusRef.current = all.length === 0 ? { kind: "live" } : { kind: "live", message: all.join(" ") };
        };
        publish(null);
        const rate = fpsRef.current?.();
        if (config.source === "file" && rate !== undefined) {
          publish("Pre-analysing file…");
          const key = configKeyRef.current;
          const pending = preAnalyseFile(config, rate);
          preAnalysisPendingRef.current = pending;
          void pending.then(
            (outcome) => {
              // The capture this walk was for may be gone: a re-bound file has its own walk.
              if (cancelled || configKeyRef.current !== key || configRef.current !== config) return;
              offlineRef.current = outcome.analysis;
              pcmRef.current = outcome.pcm;
              preAnalysisPendingRef.current = null;
              publish([preAnalysisMessage(outcome.analysis), outcome.fallback].filter((part) => part !== null).join(" "));
            },
            (error: unknown) => {
              if (cancelled || configKeyRef.current !== key) return;
              preAnalysisPendingRef.current = null;
              // Named, never silent: the live path still runs, but a timeline scrub is now
              // the live hops and not a record, and the panel has to say why (§V288).
              publish(`Pre-analysis failed, so a timeline scrub reads the live hops: ${error instanceof Error ? error.message : String(error)}`);
            },
          );
        }
      } catch (error) {
        release();
        statusRef.current = {
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    };

    /*
     * Poll the document for the capture CONFIG rather than subscribing to the store:
     * config changes are rare, per-second is plenty, and a subscription would re-run
     * this effect on every unrelated graph edit.
     */
    const refresh = () => {
      const config = captureConfigOf(getGraphRef.current());
      const key = captureKeyOf(config, reloadTokenRef.current, fpsRef.current?.());
      if (key === configKeyRef.current) return;
      configKeyRef.current = key;
      teardown();
      if (config !== null) {
        void acquire(config);
      } else if (hasUnboundAudioFile(getGraphRef.current())) {
        // B74/§V363: no capture, but a file node is WAITING — name that state instead
        // of an idle that reads identically to "everything is fine".
        statusRef.current = {
          kind: "idle",
          message: "Waiting for a file — choose one on the Audio File In node.",
        };
      }
    };
    refreshRef.current = refresh;
    // A `reload` pulse must act NOW, not on the next poll: the poll is how a config CHANGE
    // is noticed, and a button that takes up to a second to do anything reads as broken.
    const interval = setInterval(refresh, 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      refreshRef.current = null;
      teardown();
    };
  }, []);

  const read = useCallback((frame: FrameEvaluationInput): AudioFeatures | null => {
    const capture = captureRef.current;
    if (capture === null) return null;
    // T1229: under the timeline lock, the pre-analysed track at the playhead — the same
    // `mediaPlayhead` arithmetic `sync` applies to the element, on the transport it last
    // resolved, at THIS frame's timeline time (under the lock elapsed IS the timeline).
    const offline = offlineRef.current;
    const transport = transportRef.current;
    if (offline !== null && transport !== null && transport.playMode !== "freeRun" && capture.element !== undefined) {
      return readTrackAtPlayhead(
        offline.track,
        transport,
        frame.timeSeconds,
        durationOf(capture.element),
        leadRef.current,
      );
    }
    // T1226: the engine's hops since the last frame, or the polled engine — the named fallback.
    const reader = readerRef.current;
    return reader === null ? null : reader();
  }, []);

  /*
   * T1319b: the latency is computed HERE, per call, off the live context — not stored when
   * the capture opened. `outputLatency` moves when the device or the buffer size changes,
   * and a number captured once would go quietly stale, which is the failure this whole row
   * exists to end. Computing it on read costs two property lookups.
   */
  const status = useCallback((): AudioInputStatus => {
    const context = captureRef.current?.context;
    if (context === undefined) return statusRef.current;
    return { ...statusRef.current, latency: audioLatencyEstimate(context, fpsRef.current?.() ?? 0) };
  }, []);

  const detector = useCallback((): DetectorSettings | null => configRef.current?.detector ?? null, []);

  /**
   * T493 — the per-frame half. Identical in shape to the movie node's, by construction.
   *
   * `volume` is read here rather than in the capture config on purpose: it is a VALUE, so
   * it animates through the ordinary path (§V5) and changing it must not tear down and
   * re-acquire the whole capture the way `monitor` and `file` — which are STRUCTURAL — do.
   * A volume slider that restarted the track on every drag would be unusable.
   */
  const sync = useCallback((frame: FrameEvaluationInput, channels?: ChannelResolver) => {
    channelsRef.current = channels;
    const capture = captureRef.current;
    const runner = runnerRef.current;
    /*
     * T1769b — a MICROPHONE's Input Gain, per frame, through the one read path (§V61), so it
     * takes every mode: a typed number, an expression, a preset fade, a Panel fader. It is a
     * VALUE in the sense `volume` below is: sent to the trim node as a ramp, never through
     * the capture key, so listening goes on without a gap while it moves. A file's is read
     * at rest by the capture config instead (its pre-analysed track is walked at one gain).
     */
    const config = configRef.current;
    if (capture !== null && config !== null && config.source === "mic") {
      const decibels = resolvedInputGainDb(
        config,
        frame,
        getGraphRef.current(),
        registryRef.current,
        channels,
        getFlatteningRef.current?.() ?? NO_FLATTENING,
      );
      if (decibels !== trimDbRef.current) {
        trimDbRef.current = decibels;
        capture.trim.gain.setTargetAtTime(inputGainLinear(decibels), capture.context.currentTime, INPUT_GAIN_SMOOTHING_SECONDS);
      }
    }
    if (capture?.element === undefined || runner === null) return;
    const stepped = runner.step(frame, durationOf(capture.element), capture.element.currentTime);
    if (stepped === null) return;
    transportRef.current = stepped.transport;
    /*
     * T1312b — read like `volume` below, from the SAME resolve (§B8's shape), because it is
     * a VALUE and not structural: changing it must not tear down the capture and re-analyse
     * the file, and it animates through the ordinary path. It is deliberately NOT part of
     * `captureKeyOf`, which is what a knob that rebuilt the capture on every drag would be.
     */
    leadRef.current = syncLeadOf(stepped.read);
    const deterministicOfflineAudio = renderMutedRef.current &&
      offlineRef.current !== null &&
      stepped.transport.playMode !== "freeRun";
    syncAudioMediaElement(capture.element, stepped.transport, stepped.head, deterministicOfflineAudio, stepped.continuous, stepped.correction);
    if (capture.gain !== undefined) {
      // Read from the SAME resolve the playhead came from, so volume and position can
      // never come from two different reads of one frame (§B8's shape). And `visible`
      // mutes: an `extend: "black"` window is black AND silent through one control.
      const raw = stepped.read("volume");
      const volume = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 1;
      const level = stepped.head.visible ? volume : 0;
      monitorLevelRef.current = level;
      const monitorLevel = monitorGainLevel(level, renderMutedRef.current);
      if (capture.gain.gain.value !== monitorLevel) capture.gain.gain.value = monitorLevel;
      renderCaptureRef.current?.note({
        frameIndex: frame.frameIndex,
        timelineSeconds: frame.timeSeconds,
        transport: stepped.transport,
        volume,
      });
    }
  }, []);

  const setRunning = useCallback((running: boolean) => {
    if (running) return;
    const element = captureRef.current?.element;
    if (element !== undefined && !element.paused) element.pause();
  }, []);

  const muteMonitorForRender = useCallback((): (() => void) => {
    renderMutedRef.current = true;
    const element = captureRef.current?.element;
    const deterministicOfflineAudio = offlineRef.current !== null && transportRef.current?.playMode !== "freeRun";
    if (deterministicOfflineAudio && element !== undefined && !element.paused) element.pause();
    const liveGain = captureRef.current?.gain?.gain;
    if (liveGain !== undefined) liveGain.value = 0;
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      renderMutedRef.current = false;
      const currentGain = captureRef.current?.gain?.gain;
      if (currentGain !== undefined) currentGain.value = monitorLevelRef.current;
    };
  }, []);

  const reset = useCallback(() => {
    runnerRef.current?.reset();
    const config = configRef.current;
    const baseline = config?.nodeId === null || config?.nodeId === undefined
      ? null
      : audioReplayBaselineOf(getGraphRef.current(), config.nodeId);
    if (baseline === null) {
      transportRef.current = null;
      leadRef.current = 0;
      return;
    }
    transportRef.current = baseline.transport;
    leadRef.current = baseline.leadSeconds;
  }, []);

  const prepareRenderAudio = useCallback(async (
    range: FrameRange,
    timelineRate: number,
    outputRate: number,
    signal: AbortSignal,
  ): Promise<PreparedRenderAudio | null> => {
    const config = configRef.current;
    if (config === null) return null;
    if (config.source !== "file" || config.nodeId === null) {
      throw new Error("Audible offline export requires an Audio File In node, not a live microphone.");
    }
    const node = getGraphRef.current().nodes[config.nodeId];
    if (node === undefined || staticValueOf(node, "playMode") !== "timeline") {
      throw new Error("Audible offline export requires Audio File In to be Locked to Timeline.");
    }
    const pending = preAnalysisPendingRef.current;
    if (pending !== null) await pending;
    if (signal.aborted) throw new DOMException("The video render was cancelled.", "AbortError");
    let pcm = pcmRef.current;
    let analysis = offlineRef.current;
    if (pcm === null || analysis === null) {
      throw new Error("The audio file has not completed deterministic pre-analysis.");
    }
    if (analysis.track.fps !== timelineRate) {
      const outcome = await preAnalyseFile(config, timelineRate);
      if (signal.aborted) throw new DOMException("The video render was cancelled.", "AbortError");
      if (configRef.current !== config) {
        throw new Error("The audio source changed while its render analysis was being rebuilt.");
      }
      analysis = outcome.analysis;
      pcm = outcome.pcm;
      offlineRef.current = analysis;
      pcmRef.current = pcm;
      configKeyRef.current = captureKeyOf(config, reloadTokenRef.current, timelineRate);
      statusRef.current = {
        kind: "live",
        message: [preAnalysisMessage(analysis), outcome.fallback].filter((part) => part !== null).join(" "),
      };
    }
    const capture = createOfflineAudioCapture(
      pcm,
      pcm.samples.length / pcm.sampleRate,
      range,
      timelineRate,
      outputRate,
    );
    renderCaptureRef.current = capture;
    let closed = false;
    return {
      pcm: () => capture.source(),
      close() {
        if (closed) return;
        closed = true;
        if (renderCaptureRef.current === capture) renderCaptureRef.current = null;
      },
    };
  }, []);

  const renderAudioRequirement = useCallback((): RenderAudioRequirement => {
    return renderAudioRequirementOf(getGraphRef.current());
  }, []);

  return {
    read,
    status,
    detector,
    sync,
    reset,
    setRunning,
    prepareRenderAudio,
    muteMonitorForRender,
    renderAudioRequirement,
  };
}
