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

interface CaptureConfig {
  readonly source: "mic" | "file";
  readonly url: string;
  readonly monitor: boolean;
}

function captureConfigOf(graph: GraphDocument): CaptureConfig | null {
  const nodeIds = Object.keys(graph.nodes)
    .filter((nodeId) => graph.nodes[nodeId]?.type === "audioIn")
    .sort();
  const first = nodeIds[0];
  if (first === undefined) return null;
  const node = graph.nodes[first] as GraphNode;
  const raw = (key: string): unknown => {
    const stored = node.parameters[key];
    // Static values only: capture config is identity-like, not animatable.
    if (typeof stored === "object" && stored !== null && "bindings" in stored) {
      const slot = stored as { bindings?: { static?: { value?: unknown } } };
      return slot.bindings?.static?.value;
    }
    return stored;
  };
  const source = raw("source") === "file" ? "file" : "mic";
  const url = typeof raw("url") === "string" ? (raw("url") as string) : "";
  const monitor = raw("monitor") !== false;
  return { source, url, monitor };
}

interface LiveCapture {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly dispose: () => void;
}

export function useAudioInput(getGraph: () => GraphDocument): AudioInputSource {
  const captureRef = useRef<LiveCapture | null>(null);
  const statusRef = useRef<AudioInputStatus>({ kind: "idle" });
  const stateRef = useRef<AudioAnalysisState>({ previousSpectrum: null });
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
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        statusRef.current = { kind: "live" };
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
      const key = config === null ? "" : `${config.source}|${config.url}|${config.monitor}`;
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
