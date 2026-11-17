// @vitest-environment jsdom
import { flatDocument } from "@compiler/test-support.ts";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import { captureAudioConstraints, captureConfigOf, captureProcessingMessage } from "./audio-capture-config.ts";
import { captureKeyOf, useAudioInput, type AudioInputSource } from "./use-audio-input.ts";

/**
 * T1776b — THE MICROPHONE IS OPENED RAW, and what the browser granted is read back.
 *
 * `getUserMedia({ audio: true })` takes the browser's defaults: echo cancellation, noise
 * suppression and automatic gain, a telephone's processing. On music each one removes what
 * the analysis is there to measure, and the owner's complaint that a live input barely moved
 * the picture is what three stages flattening and gating the signal look like downstream.
 *
 * The real hook runs here against a `getUserMedia` that records what it was asked and hands
 * back a track whose `getSettings()` the test chooses. Asserted: the constraints of every
 * call (the fallback after a vanished device included: that call took the defaults too), and
 * the status line a user reads when the browser did not grant what was asked. A constraint is
 * a request; a test that stopped at the request would pass on a browser that ignored it.
 *
 * What this cannot say: what a real browser grants on a real device. That is a human test.
 */

type Settings = Record<string, unknown>;
interface Stage {
  readonly calls: MediaStreamConstraints[];
  /** What each opened track reports; the test sets it before the capture opens. */
  settings: Settings | undefined;
  /** Device ids `getUserMedia` refuses as gone. */
  readonly missing: Set<string>;
  stopped: number;
}
let stage: Stage;

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const VOICE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

function install(): void {
  const made: Stage = { calls: [], settings: RAW, missing: new Set(), stopped: 0 };
  stage = made;
  const audioNode = () => ({ connect: () => undefined, disconnect: () => undefined });
  class FakeContext {
    readonly sampleRate = 48_000;
    readonly destination = audioNode();
    readonly state = "running";
    readonly currentTime = 0;
    createAnalyser() {
      return { ...audioNode(), fftSize: 2048, smoothingTimeConstant: 0, getFloatTimeDomainData: () => undefined };
    }
    createGain() {
      return { ...audioNode(), gain: { value: 1 } };
    }
    createMediaStreamSource() {
      return audioNode();
    }
    resume(): Promise<void> {
      return Promise.resolve();
    }
  }
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeContext;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: (constraints: MediaStreamConstraints) => {
        made.calls.push(constraints);
        const device = ((constraints.audio as MediaTrackConstraints).deviceId as { exact?: string } | undefined)?.exact;
        if (device !== undefined && made.missing.has(device)) {
          return Promise.reject(Object.assign(new Error("gone"), { name: "OverconstrainedError" }));
        }
        const track = { stop: () => { made.stopped += 1; }, getSettings: () => made.settings };
        return Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] });
      },
    },
  });
}

const node = (id: string, parameters: Record<string, unknown>): GraphNode =>
  ({ id, type: "audioIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id }) as GraphNode;
const graphOf = (...nodes: GraphNode[]): GraphDocument =>
  ({ revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: {}, groups: {} }) as never;

function mount(graph: { current: GraphDocument }): () => AudioInputSource {
  let source: AudioInputSource | null = null;
  function Wired(): null {
    source = useAudioInput(() => flatDocument(graph.current));
    return null;
  }
  render(<Wired />);
  return () => source as unknown as AudioInputSource;
}

async function poll(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1000);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  install();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("T1776b — what the capture asks the device for", () => {
  it("by default all three stages are asked OFF, and nothing else is constrained", async () => {
    const source = mount({ current: graphOf(node("mic", {})) });
    await poll();
    expect(stage.calls).toEqual([{ audio: RAW }]);
    // Granted as asked: live, with nothing to say about the browser. (The stand-in has no
    // worklet, so the status does name the polled fallback; that sentence is not this row's.)
    expect(source().status()).toMatchObject({ kind: "live" });
    expect(source().status().message).not.toContain("The browser");
  });

  it("a chosen device is asked for exactly, with the same three off", async () => {
    mount({ current: graphOf(node("mic", { device: "dev-42" })) });
    await poll();
    expect(stage.calls).toEqual([{ audio: { deviceId: { exact: "dev-42" }, ...RAW } }]);
  });

  it("a device that vanished falls back to the default device STILL raw: the fallback is not a way back to the defaults", async () => {
    stage.missing.add("dev-42");
    const source = mount({ current: graphOf(node("mic", { device: "dev-42" })) });
    await poll();
    expect(stage.calls).toEqual([{ audio: { deviceId: { exact: "dev-42" }, ...RAW } }, { audio: RAW }]);
    expect(source().status().message).toContain("The selected device is unavailable; using the system default.");
    expect(source().status().message).not.toContain("The browser");
  });

  it("Voice Processing on asks all three ON, for a speech source", async () => {
    mount({ current: graphOf(node("mic", { voiceProcessing: true })) });
    stage.settings = VOICE;
    await poll();
    expect(stage.calls).toEqual([{ audio: VOICE }]);
  });

  it("the switch is a constraint, so flipping it reopens the device: the old stream is stopped and a new one asked for", async () => {
    const graph = { current: graphOf(node("mic", {})) };
    mount(graph);
    await poll();
    graph.current = graphOf(node("mic", { voiceProcessing: true }));
    await poll();
    expect(stage.calls).toEqual([{ audio: RAW }, { audio: VOICE }]);
    expect(stage.stopped).toBe(1);
    const key = (voiceProcessing: boolean) => captureKeyOf(captureConfigOf(graphOf(node("mic", { voiceProcessing }))), 0);
    expect(key(true)).not.toBe(key(false));
  });

  it("the constraint builder constrains exactly those keys", () => {
    expect(captureAudioConstraints(false, "")).toEqual(RAW);
    expect(captureAudioConstraints(true, " ")).toEqual(VOICE);
    expect(Object.keys(captureAudioConstraints(false, "x")).sort()).toEqual(["autoGainControl", "deviceId", "echoCancellation", "noiseSuppression"]);
  });
});

describe("T1776b — a constraint is a request: what was granted is read back and named", () => {
  it("a browser that kept a stage on says so on the status line, by name, and the capture still runs", async () => {
    stage.settings = { echoCancellation: false, noiseSuppression: true, autoGainControl: true };
    const source = mount({ current: graphOf(node("mic", {})) });
    await poll();
    expect(source().status().kind).toBe("live");
    expect(source().status().message).toContain("The browser left noise suppression, automatic gain control on though it was asked off.");
  });

  it("a stage the browser does not report is unknown, not off, and is named as that", async () => {
    stage.settings = { echoCancellation: false, noiseSuppression: false };
    const source = mount({ current: graphOf(node("mic", {})) });
    await poll();
    expect(source().status().message).toContain("The browser does not report automatic gain control, asked off.");
  });

  it("the sentence, for each way a grant can differ", () => {
    expect(captureProcessingMessage(false, RAW)).toBeNull();
    expect(captureProcessingMessage(true, VOICE)).toBeNull();
    expect(captureProcessingMessage(true, RAW)).toBe("The browser left echo cancellation, noise suppression, automatic gain control off though it was asked on.");
    expect(captureProcessingMessage(false, undefined)).toBe("The browser does not report echo cancellation, noise suppression, automatic gain control, asked off.");
    expect(captureProcessingMessage(false, { echoCancellation: true, noiseSuppression: false })).toBe(
      "The browser left echo cancellation on though it was asked off. The browser does not report automatic gain control, asked off.",
    );
  });

  it("a file has no device: its capture never asks for one and carries no switch", () => {
    const file = captureConfigOf(graphOf({ ...node("song", { file: "blob:a", voiceProcessing: true }), type: "audioFileIn" } as GraphNode));
    expect(file).toMatchObject({ source: "file", voiceProcessing: false });
  });
});
