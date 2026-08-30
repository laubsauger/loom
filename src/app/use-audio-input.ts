import { useCallback, useEffect, useRef } from "react";
import type { AudioFeatures, FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { computeAudioFeatures } from "./audio-features.ts";
import { awaitMediaReady } from "./media-sources.ts";
import type { AudioAnalysisState } from "./audio-features.ts";
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
 * Failure is LOUD but not fatal: a denied microphone or an unloadable URL parks the
 * capture in an error status (readable for UI) and the reader returns null — the same
 * deterministic silence a session with no audio has, never a half-working stream.
 */

const ANALYSER_FFT_SIZE = 2048;

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

/**
 * T434: which capture the session runs. An `audioFileIn` with a file BOUND takes
 * precedence — a bound file is deliberate authoring, where a mic node is often just
 * present — otherwise the first `audioIn` by node id opens the microphone with its
 * device selection. Exported pure so the precedence is pinned by test.
 */
/** B74: an audioFileIn with no file is a node WAITING — the status must say so. */
export function hasUnboundAudioFile(graph: GraphDocument): boolean {
  return Object.values(graph.nodes).some(
    (node) => node.type === "audioFileIn" && urlOf(staticValueOf(node as GraphNode, "file")).trim() === "",
  );
}

export function captureConfigOf(graph: GraphDocument): CaptureConfig | null {
  const nodesOf = (type: string): GraphNode[] =>
    Object.keys(graph.nodes)
      .filter((nodeId) => graph.nodes[nodeId]?.type === type)
      .sort()
      .map((nodeId) => graph.nodes[nodeId] as GraphNode);

  for (const node of nodesOf("audioFileIn")) {
    const url = urlOf(staticValueOf(node, "file"));
    if (url.trim() === "") continue;
    return {
      source: "file",
      url,
      device: "",
      monitor: staticValueOf(node, "monitor") !== false,
      nodeId: node.id,
    };
  }
  const mic = nodesOf("audioIn")[0];
  if (mic === undefined) return null;
  const device = staticValueOf(mic, "device");
  return {
    source: "mic",
    url: "",
    device: typeof device === "string" ? device : "",
    monitor: false,
    nodeId: null,
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
  const stateRef = useRef<AudioAnalysisState>({ previousSpectrum: null, previousOnset: 0 });
  const configKeyRef = useRef<string>("");
  const frequencyRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const timeDomainRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
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
      runnerRef.current = null;
      releaseControlRef.current?.();
      releaseControlRef.current = null;
      stateRef.current.previousSpectrum = null;
      stateRef.current.previousOnset = 0;
      statusRef.current = { kind: "idle" };
    };

    const acquire = async (config: CaptureConfig): Promise<void> => {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = ANALYSER_FFT_SIZE;
      // Zero: valueLag downstream owns smoothing; the default 0.8 would pre-damp
      // every transient before a trigger could see it.
      analyser.smoothingTimeConstant = 0;

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
              statusRef.current = {
                kind: "live",
                message: "The selected device is unavailable; using the system default.",
              };
            }
          }
          if (cancelled) {
            for (const track of stream.getTracks()) track.stop();
            void context.close();
            return;
          }
          const input = context.createMediaStreamSource(stream);
          input.connect(analyser);
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
        if (statusRef.current.kind !== "live") statusRef.current = { kind: "live" };
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
      const key =
        config === null
          ? ""
          : `${config.source}|${config.url}|${config.device}|${config.monitor}|${reloadTokenRef.current}`;
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
    const capture = captureRef.current;
    if (capture === null) return null;
    const bins = capture.analyser.frequencyBinCount;
    if (frequencyRef.current?.length !== bins) frequencyRef.current = new Uint8Array(bins);
    if (timeDomainRef.current?.length !== capture.analyser.fftSize) {
      timeDomainRef.current = new Uint8Array(capture.analyser.fftSize);
    }
    capture.analyser.getByteFrequencyData(frequencyRef.current);
    capture.analyser.getByteTimeDomainData(timeDomainRef.current);
    return computeAudioFeatures({
      frequency: frequencyRef.current,
      timeDomain: timeDomainRef.current,
      sampleRate: capture.context.sampleRate,
      fftSize: capture.analyser.fftSize,
      state: stateRef.current,
    });
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
