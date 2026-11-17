import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { TONAL_NODE_TYPES } from "@domain/audio/tonal-fields.ts";
import { AUDIO_DETECTOR_DEFAULTS, AUDIO_INPUT_GAIN_DB } from "@nodes/definitions/audio.ts";
import type { DetectorSettings } from "./audio-analysis-protocol.ts";

/**
 * T434 — WHICH capture the session runs, as pure functions of the document.
 *
 * An `audioFileIn` with a file BOUND takes precedence — a bound file is deliberate
 * authoring, where a mic node is often just present — otherwise the first `audioIn` by node
 * id opens the microphone with its device selection.
 *
 * T1754b: here, apart from the capture hook (`use-audio-input.ts`, which re-exports it), so
 * `pnpm render` reads the SAME precedence. The hook's module cannot be imported outside a
 * page (it loads the worklet's URL through Vite), and a second reading of "which node is the
 * source" in the tooling would be the two-answers bug waiting for the day one of them moves.
 */

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
  /**
   * T1751b — whether the document holds a tonal node (`TONAL_NODE_TYPES`) that is not
   * switched off. The tonal pass costs audio-thread time, so it runs only then; part of the
   * config KEY like the knobs, so adding the first tonal node re-acquires with the pass on.
   */
  readonly tonal: boolean;
  /**
   * T1769b — the node that supplied the capture, for both sources. `nodeId` above is null for
   * a microphone because it means "whose transport"; the microphone's Input Gain is still a
   * parameter of a node, and the hook reads it there every frame.
   */
  readonly sourceNodeId: NodeId;
  /**
   * T1769b — the source node's Input Gain AT REST, in decibels (`inputGainDbOf`).
   *
   * For a FILE this is the gain: the pre-analysed track is walked at one gain, so it is part
   * of the config KEY and a change re-acquires and re-analyses, like the detector knobs. For
   * a MICROPHONE it is only where the trim starts: the hook then follows the resolved
   * parameter per frame, and the value is deliberately NOT in the key (`captureKeyOf`), so a
   * live trim never rebuilds the capture.
   */
  readonly inputGainDb: number;
  /**
   * T1776b — a microphone's Voice Processing switch: whether the browser's echo
   * cancellation, noise suppression and automatic gain are asked ON (a speech source) or
   * OFF (the default: the raw device, for analysis). Constraints are fixed when the device
   * opens, so it is part of the config KEY. Always false for a file, which has no device.
   */
  readonly voiceProcessing: boolean;
}

/** T1776b: the three processing stages `getUserMedia` turns on by default, in the order the status names them. */
export const CAPTURE_PROCESSING_STAGES = [
  ["echoCancellation", "echo cancellation"],
  ["noiseSuppression", "noise suppression"],
  ["autoGainControl", "automatic gain control"],
] as const;

/**
 * T1776b — what the capture asks the device for. All three stages follow the one switch, and
 * nothing else is constrained: the analysis mixes to mono itself (the worklet's
 * `channelCount: 1`), the context resamples whatever rate the device runs at, and a latency
 * hint buys nothing a Sync Offset does not already own.
 */
export function captureAudioConstraints(voiceProcessing: boolean, device: string): MediaTrackConstraints {
  return {
    ...(device.trim() === "" ? {} : { deviceId: { exact: device } }),
    echoCancellation: voiceProcessing,
    noiseSuppression: voiceProcessing,
    autoGainControl: voiceProcessing,
  };
}

/**
 * T1776b — the constraints are a REQUEST. What the track says it was granted, against what
 * was asked, as the sentence the status line carries, or null when all three match. A stage
 * the browser does not report at all is named too: unknown is not the same as off.
 */
export function captureProcessingMessage(voiceProcessing: boolean, settings: Readonly<Record<string, unknown>> | undefined): string | null {
  const wanted = voiceProcessing ? "on" : "off";
  const kept: string[] = [];
  const unreported: string[] = [];
  for (const [key, name] of CAPTURE_PROCESSING_STAGES) {
    const granted = settings?.[key];
    if (typeof granted !== "boolean") unreported.push(name);
    else if (granted !== voiceProcessing) kept.push(name);
  }
  const parts: string[] = [];
  if (kept.length > 0) parts.push(`The browser left ${kept.join(", ")} ${voiceProcessing ? "off" : "on"} though it was asked ${wanted}.`);
  if (unreported.length > 0) parts.push(`The browser does not report ${unreported.join(", ")}, asked ${wanted}.`);
  return parts.length === 0 ? null : parts.join(" ");
}

/** Static parameter value, mode-envelope tolerant. Capture config never animates. */
export function staticValueOf(node: GraphNode, key: string): unknown {
  const stored = node.parameters[key];
  if (typeof stored === "object" && stored !== null && "bindings" in stored) {
    const slot = stored as { bindings?: { static?: { value?: unknown } } };
    return slot.bindings?.static?.value;
  }
  return stored;
}

/** An asset parameter's URL: a plain string, or `{ url }` — the media-sources tolerance. */
export function urlOf(value: unknown): string {
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

/**
 * T1769b — a source node's Input Gain, in decibels, from a parameter read. Anything that is
 * not a finite number is 0 dB (a document that never stored the parameter is analysed at
 * unity, as it always was), and the value is held inside the declared range, which is what
 * keeps an expression from asking the trim for a factor of a million.
 */
export function inputGainDbOf(read: (key: string) => unknown): number {
  const value = read("inputGain");
  if (typeof value !== "number" || !Number.isFinite(value)) return AUDIO_INPUT_GAIN_DB.default;
  return Math.min(AUDIO_INPUT_GAIN_DB.max, Math.max(AUDIO_INPUT_GAIN_DB.min, value));
}

/**
 * T1312b — the capturing node's sync offset, in seconds, from a resolved parameter read.
 *
 * Exported and pure so the two claims that matter can be pinned without an AudioContext:
 * an absent or non-finite value is 0 (a document that never stored the parameter hears
 * exactly what it heard before), and the number passes through untouched.
 *
 * It is deliberately absent from `CaptureConfig` and therefore from `captureKeyOf`: the
 * detector knobs are STRUCTURAL — changing one rebuilds the capture and re-analyses the
 * file — and routing the offset through that door would re-analyse the whole track on
 * every drag of the slider. It is a value, read per frame beside `volume`.
 */
export function syncLeadOf(read: (key: string) => ParameterValue | undefined): number {
  const value = read("syncOffset");
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function captureConfigOf(graph: GraphDocument): CaptureConfig | null {
  const nodesOf = (type: string): GraphNode[] =>
    Object.keys(graph.nodes)
      .filter((nodeId) => graph.nodes[nodeId]?.type === type)
      .sort()
      .map((nodeId) => graph.nodes[nodeId] as GraphNode);

  // T1751b: a silenced tonal node asks for nothing, as a silenced source captures nothing.
  const tonal = Object.values(graph.nodes).some(
    (node) => TONAL_NODE_TYPES.includes(node.type) && !isSilencedSource(node as GraphNode),
  );
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
      tonal,
      sourceNodeId: node.id,
      inputGainDb: inputGainDbOf((key) => staticValueOf(node, key)),
      voiceProcessing: false,
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
    tonal,
    sourceNodeId: mic.id,
    inputGainDb: inputGainDbOf((key) => staticValueOf(mic, key)),
    voiceProcessing: staticValueOf(mic, "voiceProcessing") === true,
  };
}
