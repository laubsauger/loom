import { useCallback, useEffect, useRef } from "react";
import type { AudioFeatures } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import { computeAudioFeatures } from "./audio-features.ts";
import type { AudioAnalysisState } from "./audio-features.ts";

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
}

export interface CaptureConfig {
  readonly source: "mic" | "file";
  /** File URL for `source: "file"`; microphone deviceId (or "") for `source: "mic"`. */
  readonly url: string;
  readonly device: string;
  readonly monitor: boolean;
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
export function captureConfigOf(graph: GraphDocument): CaptureConfig | null {
  const nodesOf = (type: string): GraphNode[] =>
    Object.keys(graph.nodes)
      .filter((nodeId) => graph.nodes[nodeId]?.type === type)
      .sort()
      .map((nodeId) => graph.nodes[nodeId] as GraphNode);

  for (const node of nodesOf("audioFileIn")) {
    const url = urlOf(staticValueOf(node, "file"));
    if (url.trim() === "") continue;
    return { source: "file", url, device: "", monitor: staticValueOf(node, "monitor") !== false };
  }
  const mic = nodesOf("audioIn")[0];
  if (mic === undefined) return null;
  const device = staticValueOf(mic, "device");
  return {
    source: "mic",
    url: "",
    device: typeof device === "string" ? device : "",
    monitor: false,
  };
}

interface LiveCapture {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly dispose: () => void;
}

export function useAudioInput(getGraph: () => GraphDocument): AudioInputSource {
  const captureRef = useRef<LiveCapture | null>(null);
  const statusRef = useRef<AudioInputStatus>({ kind: "idle" });
  const stateRef = useRef<AudioAnalysisState>({ previousSpectrum: null, previousOnset: 0 });
  const configKeyRef = useRef<string>("");
  const frequencyRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const timeDomainRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const getGraphRef = useRef(getGraph);
  getGraphRef.current = getGraph;

  useEffect(() => {
    let cancelled = false;

    const teardown = (): void => {
      captureRef.current?.dispose();
      captureRef.current = null;
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
          element.loop = true;
          element.src = config.url;
          const input = context.createMediaElementSource(element);
          input.connect(analyser);
          if (config.monitor) analyser.connect(context.destination);
          await element.play();
          if (cancelled) {
            element.pause();
            void context.close();
            return;
          }
          captureRef.current = {
            context,
            analyser,
            dispose: () => {
              element.pause();
              element.src = "";
              void context.close();
            },
          };
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
    const interval = setInterval(() => {
      const config = captureConfigOf(getGraphRef.current());
      const key = config === null ? "" : `${config.source}|${config.url}|${config.device}|${config.monitor}`;
      if (key === configKeyRef.current) return;
      configKeyRef.current = key;
      teardown();
      if (config !== null) void acquire(config);
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
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

  return { read, status };
}
