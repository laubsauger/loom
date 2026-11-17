// @vitest-environment jsdom
import { flatDocument } from "@compiler/test-support.ts";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { INPUT_GAIN_SMOOTHING_SECONDS, useAudioInput, type AudioInputSource } from "./use-audio-input.ts";

/**
 * T1769b — THE INPUT GAIN IN THE LIVE CAPTURE GRAPH: the real hook, on a Web Audio stand-in
 * that carries signal.
 *
 * `audio-input-gain.test.ts` pins what a gain does to a reading on the offline walk. This
 * file pins WHERE the hook puts it, by the things a wrong placement would change:
 *
 *  - what the session READS (`source.read`, the frame driver's own call) is the trimmed
 *    signal, at the closed-form value for the trimmed amplitude;
 *  - what the loudspeakers GET is the source at the monitor level, whatever the trim is
 *    (a trim downstream of the monitor tap, or a monitor downstream of the trim, fails it);
 *  - a microphone reaches no loudspeaker at all, at any gain;
 *  - moving a microphone's gain does not reopen the device: the same stream, the same nodes,
 *    one `getUserMedia`, through a document poll and after it.
 *
 * ## The stand-in
 *
 * Nodes that remember what is connected to them and render their inputs: a source renders a
 * tone, a gain multiplies by its `gain.value` in float32 (what a `GainNode` does), an
 * analyser's `getFloatTimeDomainData` hands back what reaches it, the destination is a node
 * whose input is what the room would hear. It has no `audioWorklet`, so the hook takes its
 * named fallback, the polled reader: the same engine core on the analyser's window. The
 * worklet path through a real `GainNode` is the e2e spec's.
 *
 * The tone is the one `audio-input-gain.test.ts` derives its closed form for (bin 64 of
 * 2048 at 48 kHz, half a sample off the zero crossing), so the expected readings are that
 * file's numbers: bytes 96/79/21 at amplitude 0.001, 169/152/94 at 0.01, 242/225/167 at 0.1.
 */

const SAMPLE_RATE = 48_000;
const TONE_BIN = 64;
const AMPLITUDE = 0.01;
const LOW_MID_AT = {
  "0.001": (96 + 2 * 79 + 2 * 21) / 75 / 255,
  "0.01": (169 + 2 * 152 + 2 * 94) / 75 / 255,
  "0.1": (242 + 2 * 225 + 2 * 167) / 75 / 255,
} as const;

class FakeNode {
  readonly inputs: FakeNode[] = [];
  readonly outputs: FakeNode[] = [];
  connect(target: FakeNode): void {
    this.outputs.push(target);
    target.inputs.push(this);
  }
  disconnect(): void {
    for (const target of this.outputs) target.inputs.splice(target.inputs.indexOf(this), 1);
    this.outputs.length = 0;
  }
  /** What reaches this node: its inputs, summed. */
  heard(length: number): Float32Array {
    const out = new Float32Array(length);
    for (const input of this.inputs) {
      const rendered = input.render(length);
      for (let index = 0; index < length; index += 1) out[index] = (out[index] as number) + (rendered[index] as number);
    }
    return out;
  }
  render(length: number): Float32Array {
    return this.heard(length);
  }
  /** Whether `target` is anywhere downstream of this node. */
  reaches(target: FakeNode): boolean {
    return this.outputs.some((next) => next === target || next.reaches(target));
  }
}

class FakeSource extends FakeNode {
  override render(length: number): Float32Array {
    const out = new Float32Array(length);
    for (let index = 0; index < length; index += 1) out[index] = AMPLITUDE * Math.sin((2 * Math.PI * TONE_BIN * (index + 0.5)) / 2048);
    return out;
  }
}

class FakeParam {
  value = 1;
  readonly ramps: Array<{ target: number; at: number; timeConstant: number }> = [];
  /** Recorded, and settled at once: the reading a frame takes long after the ramp. */
  setTargetAtTime(target: number, at: number, timeConstant: number): void {
    this.ramps.push({ target, at, timeConstant });
    this.value = target;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
  override render(length: number): Float32Array {
    return this.heard(length).map((sample) => sample * Math.fround(this.gain.value));
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  getFloatTimeDomainData(array: Float32Array): void {
    array.set(this.heard(array.length));
  }
}

interface Stage {
  readonly destination: FakeNode;
  readonly sources: FakeSource[];
  readonly gains: FakeGain[];
  readonly analysers: FakeAnalyser[];
  userMediaCalls: number;
  stoppedTracks: number;
  currentTime: number;
}
let stage: Stage;

function installWebAudio(): void {
  const made: Stage = { destination: new FakeNode(), sources: [], gains: [], analysers: [], userMediaCalls: 0, stoppedTracks: 0, currentTime: 0 };
  stage = made;

  class FakeContext {
    readonly sampleRate = SAMPLE_RATE;
    readonly destination = made.destination;
    readonly state = "running";
    get currentTime(): number {
      return made.currentTime;
    }
    createAnalyser(): FakeAnalyser {
      const analyser = new FakeAnalyser();
      made.analysers.push(analyser);
      return analyser;
    }
    createGain(): FakeGain {
      const gain = new FakeGain();
      made.gains.push(gain);
      return gain;
    }
    createMediaStreamSource(): FakeSource {
      const source = new FakeSource();
      made.sources.push(source);
      return source;
    }
    createMediaElementSource(): FakeSource {
      return this.createMediaStreamSource();
    }
    resume(): Promise<void> {
      return Promise.resolve();
    }
  }

  class FakeAudio {
    src = "";
    crossOrigin: string | null = null;
    loop = false;
    currentTime = 0;
    playbackRate = 1;
    readonly duration = 30;
    paused = true;
    readonly readyState = 1;
    play(): Promise<void> {
      this.paused = false;
      return Promise.resolve();
    }
    pause(): void {
      this.paused = true;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
  }

  (globalThis as { AudioContext?: unknown }).AudioContext = FakeContext;
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => {
        made.userMediaCalls += 1;
        const track = { stop: () => { made.stoppedTracks += 1; }, getSettings: () => ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }) };
        return Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] });
      },
    },
  });
}

function node(id: string, type: string, parameters: Record<string, unknown>): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id } as GraphNode;
}
const graphOf = (...nodes: GraphNode[]): GraphDocument =>
  ({ revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: {}, groups: {} }) as never;

const frame = (index: number): FrameEvaluationInput => ({ timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode: "realtime", randomSeed: 1 });

/** The real hook, with the registry the app gives it, over a graph the test can swap. */
function mount(graph: { current: GraphDocument }): () => AudioInputSource {
  const registry = createNodeRegistry(allNodeDefinitions);
  let source: AudioInputSource | null = null;
  function Wired(): null {
    source = useAudioInput(() => flatDocument(graph.current), registry);
    return null;
  }
  render(<Wired />);
  return () => {
    if (source === null) throw new Error("the hook did not mount");
    return source;
  };
}

/** One poll of the hook's config watcher (once a second by design), and the acquire it may start. */
async function poll(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1000);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  installWebAudio();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("T1769b — a microphone's Input Gain, live", () => {
  it("what the session reads is the trimmed tone: 0 dB, then +20 dB, then -20 dB, each at its closed form", async () => {
    const graph = { current: graphOf(node("mic", "audioIn", {})) };
    const source = mount(graph);
    await poll();
    expect(source().status().kind, "the capture never went live, so nothing below proves anything").toBe("live");

    source().sync(frame(0));
    expect(source().read(frame(0))?.lowMid).toBe(LOW_MID_AT["0.01"]);

    graph.current = graphOf(node("mic", "audioIn", { inputGain: 20 }));
    source().sync(frame(1));
    expect(source().read(frame(1))?.lowMid).toBe(LOW_MID_AT["0.1"]);

    graph.current = graphOf(node("mic", "audioIn", { inputGain: -20 }));
    source().sync(frame(2));
    expect(source().read(frame(2))?.lowMid).toBe(LOW_MID_AT["0.001"]);
  });

  it("a change does not reopen the device: one getUserMedia, the stream never stopped, the same nodes, across a document poll", async () => {
    const graph = { current: graphOf(node("mic", "audioIn", {})) };
    const source = mount(graph);
    await poll();
    const trim = stage.gains[0];
    expect(stage.userMediaCalls).toBe(1);

    graph.current = graphOf(node("mic", "audioIn", { inputGain: 20 }));
    stage.currentTime = 2.5;
    source().sync(frame(1));
    // The poll is where a STRUCTURAL change would tear the capture down and open another.
    await poll();
    await poll();
    source().sync(frame(2));

    expect(stage.userMediaCalls).toBe(1);
    expect(stage.stoppedTracks).toBe(0);
    expect(stage.sources.length).toBe(1);
    expect(stage.gains).toEqual([trim]);
    expect(stage.analysers.length).toBe(1);
    expect(source().status().kind).toBe("live");
    // And it was sent as ONE ramp from now, not as a jump and not once per frame.
    expect(trim?.gain.ramps).toEqual([{ target: 10, at: 2.5, timeConstant: INPUT_GAIN_SMOOTHING_SECONDS }]);
  });

  it("the trim starts where the document has it: a microphone opened at +20 dB reads the trimmed tone on its first frame", async () => {
    const graph = { current: graphOf(node("mic", "audioIn", { inputGain: 20 })) };
    const source = mount(graph);
    await poll();
    expect(source().read(frame(0))?.lowMid).toBe(LOW_MID_AT["0.1"]);
    // Nothing moved, so nothing was ramped.
    source().sync(frame(0));
    expect(stage.gains[0]?.gain.ramps).toEqual([]);
  });

  it("it is a value like any other: an expression drives it through the one read path", async () => {
    const expression = { mode: "expression", bindings: { static: { kind: "static", value: 0 }, expression: { kind: "expression", source: "12 + 8" } } };
    const graph = { current: graphOf(node("mic", "audioIn", { inputGain: expression })) };
    const source = mount(graph);
    await poll();
    // At rest the capture opened at the retained static, 0 dB.
    expect(source().read(frame(0))?.lowMid).toBe(LOW_MID_AT["0.01"]);
    source().sync(frame(1));
    expect(source().read(frame(1))?.lowMid).toBe(LOW_MID_AT["0.1"]);
  });

  it("a live input reaches no loudspeaker, at any gain: the trim cannot feed back or be heard", async () => {
    const graph = { current: graphOf(node("mic", "audioIn", { inputGain: 48 })) };
    mount(graph);
    await poll();
    const [microphone] = stage.sources;
    expect(microphone?.outputs.length, "the microphone feeds the trim and nothing else").toBe(1);
    expect(microphone?.reaches(stage.destination)).toBe(false);
    expect(stage.destination.inputs).toEqual([]);
  });
});

describe("T1769b — a file's Input Gain and its Volume never cross", () => {
  const FILE = { file: "blob:track.mp3", monitor: true };

  it("the analysis reads the trimmed file while the loudspeakers get the file at the monitor level, untouched by the trim", async () => {
    const graph = { current: graphOf(node("song", "audioFileIn", { ...FILE, inputGain: 20 })) };
    const source = mount(graph);
    await poll();
    source().sync(frame(0));

    // The analysis: ten times the file.
    expect(source().read(frame(0))?.lowMid).toBe(LOW_MID_AT["0.1"]);
    // The room: the file's own samples, at Volume 1. Not ten times anything.
    const file = stage.sources[0] as FakeSource;
    expect(stage.destination.inputs.length).toBe(1);
    expect(stage.destination.heard(2048)).toEqual(file.render(2048));
  });

  it("Volume does not touch the analysis: at half the monitor level the room hears half and the reading does not move", async () => {
    const graph = { current: graphOf(node("song", "audioFileIn", { ...FILE, inputGain: 20, volume: 0.5 })) };
    const source = mount(graph);
    await poll();
    source().sync(frame(0));

    expect(source().read(frame(0))?.lowMid).toBe(LOW_MID_AT["0.1"]);
    const file = stage.sources[0] as FakeSource;
    expect(stage.destination.heard(2048)).toEqual(file.render(2048).map((sample) => sample * 0.5));
  });

  it("the trim is on no path to the loudspeakers", async () => {
    const graph = { current: graphOf(node("song", "audioFileIn", { ...FILE, inputGain: 20 })) };
    mount(graph);
    await poll();
    const trim = stage.gains.find((gain) => gain.gain.value === 10);
    expect(trim, "no gain node carries the trim").toBeDefined();
    expect(trim?.reaches(stage.destination)).toBe(false);
  });
});
