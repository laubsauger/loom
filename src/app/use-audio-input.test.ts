import { describe, expect, it } from "vitest";

import type { GraphDocument } from "@domain/types/graph.ts";
import { createHopAnalyser } from "@domain/audio/analysis/hop-analyser.ts";
import { DETECTOR_STREAM, analysisOptionsFor } from "./audio-analysis-protocol.ts";
import { DETECTOR_EVENT_PICKER } from "./audio-features.ts";
import { captureConfigOf, captureKeyOf } from "./use-audio-input.ts";

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
    expect(analysisOptionsFor(defaults!, 48_000).picker).toEqual(DETECTOR_EVENT_PICKER);
    // 44.1 kHz: 0.032 s is 2.76 hops, and the gap rounds to the same 3 rather than a shorter 2.
    expect(analysisOptionsFor(defaults!, 44_100).picker.minGapHops).toBe(3);
  });

  it("the knobs carry through from either door, in seconds, and become hops on the context's grid", () => {
    const mic = captureConfigOf(graphOf({ a: { type: "audioIn", parameters: { threshold: 0.12, retrigger: 0.05 } } }));
    expect(mic?.detector).toEqual({ threshold: 0.12, retrigger: 0.05 });
    const file = captureConfigOf(
      graphOf({ a: { type: "audioFileIn", parameters: { file: "blob:t", threshold: 0.12, retrigger: 0.05 } } }),
    );
    expect(file?.detector).toEqual({ threshold: 0.12, retrigger: 0.05 });
    // 0.05 s at 48 kHz is 4.69 hops of 512: 5.
    expect(analysisOptionsFor(file!.detector, 48_000).picker).toEqual({ historyHops: 96, delta: 0.12, minGapHops: 5 });
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
      const options = analysisOptionsFor({ threshold, retrigger: 0.032 }, 48_000);
      const engine = createHopAnalyser({ ...options, sampleRate: 48_000 });
      engine.analyse(silence);
      engine.analyse(silence);
      return engine.analyse(tone).bandEvents[DETECTOR_STREAM.kick] as number;
    };
    expect(kickEvents(0.05)).toBe(1);
    expect(kickEvents(0.3)).toBe(0);
  });
});
