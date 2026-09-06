import { useCallback, useEffect, useRef } from "react";
import type { AudioFeatures, FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { createHopAnalyser } from "@domain/audio/analysis/hop-analyser.ts";
import { awaitMediaReady } from "./media-sources.ts";
import { createAudioHopReducer } from "./audio-analysis-frame.ts";
import {
  AUDIO_ANALYSIS_OPTIONS,
  AUDIO_ANALYSIS_PROCESSOR_NAME,
  analysisOptionsFor,
  type AudioAnalysisProcessorOptions,
  type AudioAnalysisWorkletMessage,
  type DetectorSettings,
} from "./audio-analysis-protocol.ts";
import { AUDIO_DETECTOR_DEFAULTS } from "@nodes/definitions/audio.ts";
import { AUDIO_ANALYSIS_WORKLET_URL } from "./audio-analysis-worklet-url.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { MediaControlRegistry } from "./media-commands.ts";
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
 * the record is produced by the same code on both paths, T1225/T1227), and for a file
 * it is where the monitoring gain hangs (see the placement note below).
 *
 * Failure is LOUD but not fatal: a denied microphone or an unloadable URL parks the
 * capture in an error status (readable for UI) and the reader returns null — the same
 * deterministic silence a session with no audio has, never a half-working stream.
 */

/** §V288: the fallback is taken AND named. Anything reading "Live" with this beside it is on the polled path. */
function workletFallbackMessage(reason: string): string {
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
function polledReader(
  context: AudioContext,
  analyser: AnalyserNode,
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
  return () => {
    analyser.getFloatTimeDomainData(samples);
    reducer.push(core.analyse(samples));
    return reducer.read().features;
  };
}

type EngineAttachment = { readonly node: AudioWorkletNode; readonly read: FeatureReader } | { readonly failure: string };

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
    await context.audioWorklet.addModule(AUDIO_ANALYSIS_WORKLET_URL);
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
    };
    return { node, read: () => reducer.read().features };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

export interface AudioInputStatus {
  readonly kind: "idle" | "live" | "error";
  readonly message?: string;
}

export interface AudioInputSource {
  /** Per-frame reader for the frame driver. Null while no capture is live. */
  readonly read: () => AudioFeatures | null;
  readonly status: () => AudioInputStatus;
  /**
   * T493 — put the file where its transport says, once per rendered frame.
   *
   * The movie node's `sync` verbatim, and deliberately so: both doors call
   * `applyMediaPlayhead` with a head from the same `mediaPlayhead`, so "cue" cannot come
   * to mean one thing for pictures and another for sound.
   */
  readonly sync: (frame: FrameEvaluationInput, channels?: ChannelResolver) => void;
  /** The app transport stopped: hold the file rather than letting it run on unwatched. */
  readonly setRunning: (running: boolean) => void;
}

export interface CaptureConfig {
  readonly source: "mic" | "file";
  /** File URL for `source: "file"`; microphone deviceId (or "") for `source: "mic"`. */
  readonly url: string;
  readonly device: string;
  readonly monitor: boolean;
  /**
   * T493 — WHICH node's transport drives this capture. The session has one capture, so it
   * has one transport, and it belongs to the node that supplied the file. Null for a mic:
   * a live input has no playhead, exactly as a webcam has none.
   */
  readonly nodeId: NodeId | null;
  /**
   * T1230 — the capturing node's detector knobs. Part of the config KEY, so a change
   * re-acquires: the picker is built into the engine when the capture is, and rebuilding
   * the capture is the one door every structural change already goes through.
   */
  readonly detector: DetectorSettings;
}

/** Static parameter value, mode-envelope tolerant. Capture config never animates. */
function staticValueOf(node: GraphNode, key: string): unknown {
  const stored = node.parameters[key];
  if (typeof stored === "object" && stored !== null && "bindings" in stored) {
    const slot = stored as { bindings?: { static?: { value?: unknown } } };
    return slot.bindings?.static?.value;
  }
  return stored;
}

/** An asset parameter's URL: a plain string, or `{ url }` — the media-sources tolerance. */
function urlOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const url = (value as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return "";
}

/** T1230: the node's detector knobs, or the shipped defaults where it never stored them. */
function detectorOf(node: GraphNode): DetectorSettings {
  const number = (key: keyof DetectorSettings): number => {
    const value = staticValueOf(node, key);
    return typeof value === "number" && Number.isFinite(value) ? value : AUDIO_DETECTOR_DEFAULTS[key];
  };
  return { threshold: number("threshold"), retrigger: number("retrigger") };
}

/** The string a capture is identified by: equal keys keep the capture, anything else rebuilds it. */
export function captureKeyOf(config: CaptureConfig | null, reloadToken: number): string {
  if (config === null) return "";
  const { detector } = config;
  return `${config.source}|${config.url}|${config.device}|${config.monitor}|${detector.threshold}|${detector.retrigger}|${reloadToken}`;
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

export function captureConfigOf(graph: GraphDocument): CaptureConfig | null {
  const nodesOf = (type: string): GraphNode[] =>
    Object.keys(graph.nodes)
      .filter((nodeId) => graph.nodes[nodeId]?.type === type)
      .sort()
      .map((nodeId) => graph.nodes[nodeId] as GraphNode);

  for (const node of nodesOf("audioFileIn")) {
    // T555 (T541's rule, the AUDIBLE half). The owner: "audio file in is muted but still
    // audible. that probably needs to not play if the node is not actually cooking / is
    // bypassed / muted." A silenced node is not a capture CANDIDATE at all — the exact
    // analogue of the compiler dropping a muted node from the graph (T250) — which is
    // what stops the sound at its source rather than turning a gain down after it.
    //
    // MUTE OVERRIDES `monitor`, and the ordering is structural rather than a rule someone
    // has to remember: `monitor` says "route this to the speakers" and is only ever read
    // for a node that got this far, so an off node never reaches the question.
    //
    // It also promotes the NEXT candidate, and answers for the microphone below, which
    // has no gain stage to turn down — a muted `audioIn` must not open the device at all
    // (§V476's spirit: a permission prompt from a node that is switched off is an ambush).
    if (isSilencedSource(node)) continue;
    const url = urlOf(staticValueOf(node, "file"));
    if (url.trim() === "") continue;
    return {
      source: "file",
      url,
      device: "",
      monitor: staticValueOf(node, "monitor") !== false,
      nodeId: node.id,
      detector: detectorOf(node),
    };
  }
  const mic = nodesOf("audioIn").find((node) => !isSilencedSource(node));
  if (mic === undefined) return null;
  const device = staticValueOf(mic, "device");
  return {
    source: "mic",
    url: "",
    device: typeof device === "string" ? device : "",
    monitor: false,
    nodeId: null,
    detector: detectorOf(mic),
  };
}

interface LiveCapture {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly dispose: () => void;
  /** T493: present only for a file capture — a mic has no playhead to drive. */
  readonly element?: PlayableMedia;
  /** T493: monitoring level, AFTER the analyser, so volume never rescales the channels. */
  readonly gain?: GainNode;
}

export function useAudioInput(
  getGraph: () => GraphDocument,
  /**
   * T493 — the node registry, so transport parameters resolve through the ONE read path
   * (§V61) and take every mode. Optional because `captureConfigOf` and the analysis half
   * need nothing from it, and a test that only pins capture precedence should not have to
   * build a registry to do it.
   */
  registry?: AppRuntime["registry"],
  /** T493: where `media.cue` and `media.reload` find the node that supplied the file. */
  controls?: MediaControlRegistry,
): AudioInputSource {
  const captureRef = useRef<LiveCapture | null>(null);
  const statusRef = useRef<AudioInputStatus>({ kind: "idle" });
  /** T1226: the live path's reader — the worklet's reducer, or the polled engine. Null between captures. */
  const readerRef = useRef<FeatureReader | null>(null);
  const configKeyRef = useRef<string>("");
  const getGraphRef = useRef(getGraph);
  getGraphRef.current = getGraph;
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
      readerRef.current = null;
      runnerRef.current = null;
      releaseControlRef.current?.();
      releaseControlRef.current = null;
      statusRef.current = { kind: "idle" };
    };

    const acquire = async (config: CaptureConfig): Promise<void> => {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      // The engine's window, so the polled fallback analyses exactly what the worklet would.
      analyser.fftSize = AUDIO_ANALYSIS_OPTIONS.fftSize;
      // Zero: valueLag downstream owns smoothing; the default 0.8 would pre-damp
      // every transient before a trigger could see it.
      analyser.smoothingTimeConstant = 0;

      /*
       * T1226: the engine first — it depends on nothing the source does, and a fallback
       * message must be decided before the status goes "live" below. `messages` collects
       * every reason the live status has to name; there can be two (device AND worklet).
       */
      const messages: string[] = [];
      // T1230: the source's detector knobs, on this context's hop grid — both paths get the same picker.
      const options = analysisOptionsFor(config.detector, context.sampleRate);
      const engine = await attachAnalysisEngine(context, options);
      if ("failure" in engine) messages.push(workletFallbackMessage(engine.failure));
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
        void context.close();
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
          if (config.device.trim() === "") {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } else {
            try {
              stream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: config.device } },
              });
            } catch (constrained) {
              if ((constrained as { name?: string }).name !== "OverconstrainedError") throw constrained;
              stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              messages.push("The selected device is unavailable; using the system default.");
            }
          }
          if (cancelled) {
            for (const track of stream.getTracks()) track.stop();
            void context.close();
            return;
          }
          const input = context.createMediaStreamSource(stream);
          input.connect(analyser);
          attachEngine(input);
          captureRef.current = {
            context,
            analyser,
            dispose: () => {
              for (const track of stream.getTracks()) track.stop();
              void context.close();
            },
          };
        } else {
          if (config.url.trim() === "") {
            statusRef.current = { kind: "error", message: "File source needs a URL." };
            void context.close();
            return;
          }
          const element = new Audio();
          element.crossOrigin = "anonymous";
          // T493: `element.loop = true` used to live here and was the whole transport —
          // looping you could not turn off, with no parameter naming it. `extend` owns
          // wrapping now, and the element's own loop would fight every seek.
          element.loop = false;
          element.src = config.url;
          const input = context.createMediaElementSource(element);
          input.connect(analyser);
          attachEngine(input);
          /*
           * T493 — VOLUME SITS AFTER THE ANALYSER, and that placement is the feature.
           *
           * The analyser gets the file at unity whatever the monitoring level is, so
           * turning the room down does not silently rescale every parameter driven by
           * `level`. A gain node upstream of the analyser would have made the volume
           * slider a hidden master fader on the whole graph — the plausible-wrong wiring,
           * with no error to find it by.
           */
          const gain = context.createGain();
          analyser.connect(gain);
          if (config.monitor) gain.connect(context.destination);
          // T493/§V369: kicked, never AWAITED. `play()` on a source that never decodes
          // stays pending forever, so awaiting it left the capture in `idle` — reading
          // exactly like "everything is fine" — for a file that could not be opened.
          // `awaitMediaReady` is the half that can actually fail, and it does so by name.
          void element.play().catch(() => undefined);
          await awaitMediaReady(element);
          if (cancelled) {
            element.pause();
            void context.close();
            return;
          }
          captureRef.current = {
            context,
            analyser,
            element,
            gain,
            dispose: () => {
              element.pause();
              element.src = "";
              void context.close();
            },
          };
          const nodeId = config.nodeId;
          const nodeRegistry = registryRef.current;
          if (nodeId !== null && nodeRegistry !== undefined) {
            const runner = createMediaTransportRunner(nodeId, {
              graph: () => getGraphRef.current(),
              registry: nodeRegistry,
              channels: () => channelsRef.current,
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
        statusRef.current = messages.length === 0 ? { kind: "live" } : { kind: "live", message: messages.join(" ") };
      } catch (error) {
        void context.close();
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
      const key = captureKeyOf(config, reloadTokenRef.current);
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

  const read = useCallback((): AudioFeatures | null => {
    if (captureRef.current === null) return null;
    // T1226: the engine's hops since the last frame, or the polled engine — the named fallback.
    const reader = readerRef.current;
    return reader === null ? null : reader();
  }, []);

  const status = useCallback((): AudioInputStatus => statusRef.current, []);

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
    if (capture?.element === undefined || runner === null) return;
    const stepped = runner.step(frame, durationOf(capture.element));
    if (stepped === null) return;
    applyMediaPlayhead(capture.element, stepped.transport, stepped.head);
    if (capture.gain !== undefined) {
      // Read from the SAME resolve the playhead came from, so volume and position can
      // never come from two different reads of one frame (§B8's shape). And `visible`
      // mutes: an `extend: "black"` window is black AND silent through one control.
      const raw = stepped.read("volume");
      const volume = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 1;
      const level = stepped.head.visible ? volume : 0;
      if (capture.gain.gain.value !== level) capture.gain.gain.value = level;
    }
  }, []);

  const setRunning = useCallback((running: boolean) => {
    if (running) return;
    const element = captureRef.current?.element;
    if (element !== undefined && !element.paused) element.pause();
  }, []);

  return { read, status, sync, setRunning };
}
