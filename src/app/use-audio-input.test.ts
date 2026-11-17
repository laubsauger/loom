import { describe, expect, it } from "vitest";

import type { GraphDocument } from "@domain/types/graph.ts";
import { createHopAnalyser } from "@domain/audio/analysis/hop-analyser.ts";
import { createTonalAnalyser } from "@domain/audio/analysis/tonal-analyser.ts";
import { CHROMA_NAMES } from "@domain/audio/tonal-fields.ts";
import { DETECTOR_STREAM, analysisOptionsFor } from "./audio-analysis-protocol.ts";
import { DETECTOR_EVENT_PICKER } from "./audio-features.ts";
import {
  audioReplayBaselineOf,
  captureConfigOf,
  captureKeyOf,
  polledAnalyserSize,
  polledReader,
  workletFallbackMessage,
  monitorGainLevel,
  renderAudioRequirementOf,
  syncAudioMediaElement,
  syncLeadOf,
} from "./use-audio-input.ts";

/**
 * T434: WHICH capture the session runs, pinned as a pure function.
 *
 * The precedence is the design: a BOUND file beats the microphone (a bound file is
 * deliberate authoring; a mic node is often just present), first-by-id breaks ties,
 * and the mic carries its device selection. The asset value is read with the same
 * tolerance media sources use — a plain string or `{ url }`.
 */

function graphOf(nodes: Record<string, { type: string; parameters?: Record<string, unknown> }>): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, entry]) => [
        id,
        { id, type: entry.type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: entry.parameters ?? {} },
      ]),
    ),
    edges: {},
    groups: {},
  } as never;
}

describe("captureConfigOf (T434)", () => {
  it("no audio nodes: no capture", () => {
    expect(captureConfigOf(graphOf({ n: { type: "noise" } }))).toBeNull();
  });

  it("a mic node opens the default device; its device param carries through", () => {
    expect(captureConfigOf(graphOf({ a: { type: "audioIn" } }))).toEqual({
      source: "mic",
      url: "",
      device: "",
      monitor: false,
      // T493: a mic has no playhead, so there is no node whose transport drives it.
      nodeId: null,
      detector: { threshold: 0.05, retrigger: 0.032 },
      // T1751b: no tonal node in the document, no tonal pass.
      tonal: false,
      // T1769b: the node that supplied the capture, and its Input Gain at rest (0 dB unstored).
      sourceNodeId: "a",
      inputGainDb: 0,
      // T1776b: the raw device unless the node asks for voice processing.
      voiceProcessing: false,
    });
    expect(
      captureConfigOf(graphOf({ a: { type: "audioIn", parameters: { device: "dev-42" } } }))?.device,
    ).toBe("dev-42");
  });

  it("a BOUND file beats the microphone; an UNBOUND audioFileIn does not", () => {
    const bound = captureConfigOf(
      graphOf({
        z: { type: "audioIn" },
        a: { type: "audioFileIn", parameters: { file: "blob:track" } },
      }),
    );
    // T493: the config names WHICH node's transport drives the capture — the session has
    // one capture, so it has one transport, and it belongs to the node that supplied it.
    expect(bound).toEqual({
      source: "file",
      url: "blob:track",
      device: "",
      monitor: true,
      nodeId: "a",
      detector: { threshold: 0.05, retrigger: 0.032 },
      tonal: false,
      sourceNodeId: "a",
      inputGainDb: 0,
      voiceProcessing: false,
    });
    // No file chosen yet: the node is waiting, not capturing — the mic keeps the session.
    const unbound = captureConfigOf(
      graphOf({
        z: { type: "audioIn" },
        a: { type: "audioFileIn" },
      }),
    );
    expect(unbound?.source).toBe("mic");
  });

  it("reads the asset value with media-source tolerance: string or { url }", () => {
    const wrapped = captureConfigOf(
      graphOf({ a: { type: "audioFileIn", parameters: { file: { url: "https://x/track.mp3" } } } }),
    );
    expect(wrapped?.url).toBe("https://x/track.mp3");
  });

  it("monitor: false carries through for a file capture", () => {
    const config = captureConfigOf(
      graphOf({ a: { type: "audioFileIn", parameters: { file: "blob:t", monitor: false } } }),
    );
    expect(config?.monitor).toBe(false);
  });
});

describe("audible offline export requirements", () => {
  it("accepts a bound timeline file and refuses sources no deterministic take can replay", () => {
    expect(renderAudioRequirementOf(graphOf({ n: { type: "noise" } }))).toEqual({ kind: "none" });
    expect(renderAudioRequirementOf(graphOf({ a: { type: "audioIn" } }))).toMatchObject({ kind: "invalid" });
    expect(renderAudioRequirementOf(graphOf({
      a: { type: "audioFileIn", parameters: { file: "blob:t" } },
    }))).toMatchObject({ kind: "invalid" });
    expect(renderAudioRequirementOf(graphOf({
      a: { type: "audioFileIn", parameters: { file: "blob:t", playMode: "timeline" } },
    }))).toEqual({ kind: "required" });
  });
});

it("mutes only the speaker monitor while an offline take is active", () => {
  expect(monitorGainLevel(0.65, false)).toBe(0.65);
  expect(monitorGainLevel(0.65, true)).toBe(0);
});

it("does not seek or play the browser audio element while offline PCM drives a take", () => {
  let currentTime = 9;
  let currentTimeWrites = 0;
  let paused = false;
  let plays = 0;
  let pauses = 0;
  const element = {
    get currentTime() { return currentTime; },
    set currentTime(value: number) { currentTime = value; currentTimeWrites += 1; },
    playbackRate: 1,
    duration: 60,
    get paused() { return paused; },
    play() { plays += 1; paused = false; },
    pause() { pauses += 1; paused = true; },
  };
  const transport = {
    playMode: "timeline",
    play: true,
    speed: 1,
    cue: false,
    cuePoint: 0,
    trimStart: 0,
    trimEnd: 60,
    extend: "loop",
  } as const;
  const head = {
    position: 1,
    start: 0,
    end: 60,
    visible: true,
    done: false,
    cued: false,
    laps: 0,
  };

  for (let frame = 0; frame < 600; frame += 1) {
    expect(syncAudioMediaElement(element, transport, { ...head, position: frame / 60 }, true)).toBe(false);
  }
  expect({ currentTime, currentTimeWrites, plays, pauses, paused }).toEqual({
    currentTime: 9,
    currentTimeWrites: 0,
    plays: 0,
    pauses: 1,
    paused: true,
  });

  expect(syncAudioMediaElement(element, { ...transport, playMode: "freeRun" }, head, false)).toBe(true);
  expect({ currentTimeWrites, plays }).toEqual({ currentTimeWrites: 1, plays: 1 });
});

describe("audio replay baseline", () => {
  it("starts a replay from retained static values instead of the preceding live frame", () => {
    const graph = graphOf({
      a: {
        type: "audioFileIn",
        parameters: {
          playMode: "timeline",
          speed: { bindings: { static: { value: 1.5 }, expression: { value: "chan.speed" } } },
          trimStart: 2,
          syncOffset: 0.125,
        },
      },
    });

    expect(audioReplayBaselineOf(graph, "a")).toEqual({
      transport: {
        playMode: "timeline",
        play: true,
        speed: 1.5,
        cue: false,
        cuePoint: 0,
        trimStart: 2,
        trimEnd: 0,
        extend: "loop",
      },
      leadSeconds: 0.125,
    });
  });
});

/**
 * T1230 — the source node's Analysis knobs reach the engine, and only through a rebuild.
 *
 * Two things are pinned. The DEFAULTS reproduce `DETECTOR_EVENT_PICKER` to the hop at
 * 48 kHz — that equality is why adding the knobs was not a `FEATURE_TRACK_VERSION` bump: a
 * document that never touched them counts what the contract counts. And a changed knob
 * changes the capture KEY, because the picker is built into the engine at acquire time and
 * the config poll is the one door a structural change goes through.
 */
describe("detector knobs on the source node (T1230)", () => {
  const defaults = captureConfigOf(graphOf({ a: { type: "audioIn" } }))?.detector;

  it("the defaults ARE the recorded contract's picker, to the hop, at 48 kHz", () => {
    expect(defaults).toBeDefined();
    expect(analysisOptionsFor(defaults!, 48_000, false).picker).toEqual(DETECTOR_EVENT_PICKER);
    // 44.1 kHz: 0.032 s is 2.76 hops, and the gap rounds to the same 3 rather than a shorter 2.
    expect(analysisOptionsFor(defaults!, 44_100, false).picker.minGapHops).toBe(3);
  });

  it("the knobs carry through from either door, in seconds, and become hops on the context's grid", () => {
    const mic = captureConfigOf(graphOf({ a: { type: "audioIn", parameters: { threshold: 0.12, retrigger: 0.05 } } }));
    expect(mic?.detector).toEqual({ threshold: 0.12, retrigger: 0.05 });
    const file = captureConfigOf(
      graphOf({ a: { type: "audioFileIn", parameters: { file: "blob:t", threshold: 0.12, retrigger: 0.05 } } }),
    );
    expect(file?.detector).toEqual({ threshold: 0.12, retrigger: 0.05 });
    // 0.05 s at 48 kHz is 4.69 hops of 512: 5.
    expect(analysisOptionsFor(file!.detector, 48_000, false).picker).toEqual({ historyHops: 96, delta: 0.12, minGapHops: 5 });
  });

  it("a changed knob changes the capture key — the rebuild door — and an unchanged one does not", () => {
    const base = captureConfigOf(graphOf({ a: { type: "audioIn" } }));
    const same = captureConfigOf(graphOf({ a: { type: "audioIn", parameters: { threshold: 0.05 } } }));
    const raised = captureConfigOf(graphOf({ a: { type: "audioIn", parameters: { threshold: 0.2 } } }));
    const slower = captureConfigOf(graphOf({ a: { type: "audioIn", parameters: { retrigger: 0.1 } } }));
    expect(captureKeyOf(same, 0)).toBe(captureKeyOf(base, 0));
    expect(captureKeyOf(raised, 0)).not.toBe(captureKeyOf(base, 0));
    expect(captureKeyOf(slower, 0)).not.toBe(captureKeyOf(base, 0));
    expect(captureKeyOf(null, 0)).toBe("");
  });

  it("a file analysis rebuilds when the project frame grid changes, while a microphone does not", () => {
    const file = captureConfigOf(graphOf({ a: { type: "audioFileIn", parameters: { file: "blob:track" } } }));
    const mic = captureConfigOf(graphOf({ a: { type: "audioIn" } }));
    expect(captureKeyOf(file, 0, 30)).not.toBe(captureKeyOf(file, 0, 60));
    expect(captureKeyOf(mic, 0, 30)).toBe(captureKeyOf(mic, 0, 60));
  });

  it("T1312b — the sync offset is NOT a rebuild door: it must not re-analyse the file", () => {
    // The detector knobs above rebuild the capture on purpose. The offset must not: it only
    // says which frame of the ALREADY analysed track to read, so routing it through this
    // door would re-decode and re-analyse the whole file on every drag of the slider.
    const base = captureConfigOf(graphOf({ a: { type: "audioFileIn", parameters: { file: "blob:track" } } }));
    const led = captureConfigOf(
      graphOf({ a: { type: "audioFileIn", parameters: { file: "blob:track", syncOffset: 0.12 } } }),
    );
    expect(captureKeyOf(led, 0)).toBe(captureKeyOf(base, 0));
    expect(led).toEqual(base);
  });

  it("T1312b — the lead reads as seconds, and anything that is not a number is OFF", () => {
    expect(syncLeadOf(() => 0.25)).toBe(0.25);
    expect(syncLeadOf(() => -0.1)).toBe(-0.1);
    // A document that never stored it, and every non-number a slot can hand back, are 0 —
    // which is what makes the parameter's default invisible to every shipped document.
    expect(syncLeadOf(() => undefined)).toBe(0);
    expect(syncLeadOf(() => Number.NaN)).toBe(0);
    expect(syncLeadOf(() => Number.POSITIVE_INFINITY)).toBe(0);
    expect(syncLeadOf(() => "0.2" as never)).toBe(0);
  });

  it("what the knob changes: a kick-band tone the default counts as a hit is not one at a raised threshold", () => {
    // The hop-analyser test's shape: a −60 dB bin-aligned sine on bin 5 (117 Hz at 48 kHz)
    // lands inside the kick band and nowhere else, over two hops of silence. Its four lines
    // inside the band's five bins read 0.216 mean SuperFlux — over the default bar, under
    // the slider's top.
    const fftSize = 2048;
    const silence = new Float64Array(fftSize);
    const tone = new Float64Array(fftSize);
    for (let n = 0; n < fftSize; n += 1) tone[n] = 0.001 * Math.sin((2 * Math.PI * 5 * n) / fftSize);
    const kickEvents = (threshold: number): number => {
      const options = analysisOptionsFor({ threshold, retrigger: 0.032 }, 48_000, false);
      const engine = createHopAnalyser({ ...options, sampleRate: 48_000 });
      engine.analyse(silence);
      engine.analyse(silence);
      return engine.analyse(tone).bandEvents[DETECTOR_STREAM.kick] as number;
    };
    expect(kickEvents(0.05)).toBe(1);
    expect(kickEvents(0.3)).toBe(0);
  });
});

describe("T1751b — the tonal pass runs only while the document holds a tonal node", () => {
  it("a Chroma node turns it on for the mic and for a file; a muted one does not; and it is part of the capture's key", () => {
    const mic = captureConfigOf(graphOf({ a: { type: "audioIn" } }));
    const micTonal = captureConfigOf(graphOf({ a: { type: "audioIn" }, c: { type: "audioChroma" } }));
    const fileTonal = captureConfigOf(
      graphOf({ a: { type: "audioFileIn", parameters: { file: "blob:track" } }, c: { type: "audioChroma" } }),
    );
    expect([mic?.tonal, micTonal?.tonal, fileTonal?.tonal]).toEqual([false, true, true]);
    // A silenced tonal node asks for nothing, as a silenced source captures nothing (T555).
    const muted = graphOf({ a: { type: "audioIn" }, c: { type: "audioChroma" } });
    (muted.nodes["c"] as { ui?: { muted: boolean } }).ui = { muted: true };
    expect(captureConfigOf(muted)?.tonal).toBe(false);
    // Adding the first tonal node must REBUILD the capture: the pass is built into the engine.
    expect(captureKeyOf(micTonal, 0)).not.toBe(captureKeyOf(mic, 0));
    // A tonal node alone captures nothing: it reads a capture, it does not open one.
    expect(captureConfigOf(graphOf({ c: { type: "audioChroma" } }))).toBeNull();
  });

  it("the engine's options carry the tonal window only when asked", () => {
    expect(analysisOptionsFor({ threshold: 0.05, retrigger: 0.032 }, 48_000, false).tonal).toBeUndefined();
    expect(analysisOptionsFor({ threshold: 0.05, retrigger: 0.032 }, 48_000, true).tonal).toEqual({ windowSize: 8192, hop: 2048, pitchEveryHops: 2 });
  });

  it("T1752b — the polled fallback's message is the one sentence again: the tonal channels are no longer missing there", () => {
    expect(workletFallbackMessage("no worklet")).toBe(
      "Analysis worklet unavailable (no worklet); polling the analyser's window once per frame.",
    );
  });
});

describe("T1752b — the polled fallback runs the tonal pass on the same core", () => {
  const SAMPLE_RATE = 48_000;
  const options = analysisOptionsFor({ threshold: 0.05, retrigger: 0.032 }, SAMPLE_RATE, true);
  /** An analyser holding the last `fftSize` samples of `signal` at `clock.currentTime`. */
  function rig(signal: (index: number) => number, fftSize = polledAnalyserSize(options)) {
    const clock = { sampleRate: SAMPLE_RATE, currentTime: 1 };
    const analyser = {
      fftSize,
      getFloatTimeDomainData(array: Float32Array): void {
        const end = Math.round(clock.currentTime * SAMPLE_RATE);
        for (let i = 0; i < array.length; i += 1) array[i] = signal(end - array.length + i);
      },
    };
    return { clock, analyser };
  }
  const a4 = (index: number): number => 0.4 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE);
  const d5 = (index: number): number => 0.4 * Math.sin((2 * Math.PI * 440 * 2 ** (5 / 12) * index) / SAMPLE_RATE);

  it("opens the analyser at the tonal window when the pass is on, and at the hop window when it is not", () => {
    expect(polledAnalyserSize(options)).toBe(8192);
    expect(polledAnalyserSize(analysisOptionsFor({ threshold: 0.05, retrigger: 0.032 }, SAMPLE_RATE, false))).toBe(2048);
  });

  it("its chroma is the tonal analyser's own reading of the analyser's window — the worklet's and the offline walk's core", () => {
    const { clock, analyser } = rig(a4);
    const features = polledReader(clock, analyser, options)();
    const window = new Float32Array(8192);
    analyser.getFloatTimeDomainData(window);
    const direct = createTonalAnalyser({ sampleRate: SAMPLE_RATE, windowSize: 8192 }).analyse(Float64Array.from(window), 0);
    expect(CHROMA_NAMES.map((name) => features[name])).toEqual([...direct.chroma]);
    expect([features.chroma9, features.chromaConfidence, features.tonalLag]).toEqual([1, 1, 8192 / 2 / SAMPLE_RATE]);
  });

  it("the bands do not move: the hop core reads the last 2048 samples, as it did with a 2048 analyser", () => {
    const long = rig(a4);
    const short = rig(a4, 2048);
    const withPass = polledReader(long.clock, long.analyser, options)();
    const without = polledReader(short.clock, short.analyser, analysisOptionsFor({ threshold: 0.05, retrigger: 0.032 }, SAMPLE_RATE, false))();
    for (const name of ["level", "low", "lowMid", "highMid", "high", "centroid", "band380", "band519"] as const) expect(withPass[name], name).toBe(without[name]);
  });

  it("the tonal window is retaken once a tonal hop of samples has gone by, not every frame, and holds between", () => {
    let signal = a4;
    const { clock, analyser } = rig((index) => signal(index));
    const read = polledReader(clock, analyser, options);
    expect(read().chroma9).toBe(1);
    // The sound changes to D, but only 800 samples (one frame) pass: the reading holds.
    signal = d5;
    clock.currentTime += 800 / SAMPLE_RATE;
    expect([read().chroma9, read().chroma2]).toEqual([1, 0]);
    // Past a whole tonal hop (2048 samples) the window is retaken, and it is the D.
    clock.currentTime += 1600 / SAMPLE_RATE;
    const retaken = read();
    expect([retaken.chroma9, retaken.chroma2]).toEqual([0, 1]);
  });

  it("T1755b — the lead pitch too: a single note reads its pitch on the polled path, on the first read", () => {
    const partials = (index: number): number => [1, 2, 3].reduce((sum, h) => sum + (0.3 / h) * Math.sin((2 * Math.PI * 220 * h * index) / SAMPLE_RATE), 0);
    const { clock, analyser } = rig(partials);
    const features = polledReader(clock, analyser, options)();
    expect(Math.abs(features.pitch - 57) * 100).toBeLessThan(3);
    expect(features.pitchConfidence).toBeGreaterThan(0.99);
    expect(features.pitchOnsetCount).toBe(1);
  });

  it("refuses an analyser too short for the pass by name, instead of analysing a window it does not have", () => {
    const { clock, analyser } = rig(a4, 2048);
    expect(() => polledReader(clock, analyser, options)).toThrow(/holds 2048 samples, and the engine needs 8192/);
  });
});
