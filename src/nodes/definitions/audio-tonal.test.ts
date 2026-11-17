import { describe, expect, it } from "vitest";

import { FEATURE_TRACK_FIELDS, SILENCE } from "../../domain/audio/feature-track.ts";
import { distinctSpectrumBands } from "../../domain/audio/spectrum-bands.fixture.ts";
import { distinctTonalFields } from "../../domain/audio/tonal-fields.fixture.ts";
import { CHROMA_NAMES, TONAL_NODE_TYPES, VOICE_FIELD_NAMES } from "../../domain/audio/tonal-fields.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { flatDocument } from "../../compiler/test-support.ts";
import { NO_FLATTENING } from "../../domain/parameters/node-references.ts";
import type { AudioFeatures, FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { CHORD_LIVE_DECODE_SECONDS, CHROMA_GATE } from "./audio-tonal.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1751b — the Chroma node: a projection of the record's tonal fields, with a gate and a
 * follower. The analysis is tested where it lives (`chroma.test.ts`,
 * `tonal-analyser.test.ts`); here the record is given and the claims are about what a
 * consumer of the node reads back.
 */
const registry = createNodeRegistry(allNodeDefinitions).view();
const DELTA = 1 / 60;

const frame = (frameIndex: number, deltaSeconds = DELTA): FrameEvaluationInput => ({
  timeSeconds: frameIndex * deltaSeconds,
  deltaSeconds,
  frameIndex,
  mode: "offline",
  randomSeed: 7,
});

/** A record with a full-confidence tonal half: `chroma9` 1, `chroma4` 0.5, the rest 0. */
function record(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return { ...SILENCE, chroma9: 1, chroma4: 0.5, chromaConfidence: 1, tuning: 12, tonalLag: 0.085, ...overrides };
}

const RAW = { attack: 0, release: 0 } as const;

function evaluator(values: Readonly<Record<string, ParameterValue>>) {
  const definition = registry.get("audioChroma");
  if (definition?.valueEvaluate === undefined) throw new Error("audioChroma has no value hook");
  const hook = definition.valueEvaluate;
  const state: Record<string, unknown> = {};
  return (audio: AudioFeatures | undefined, at: FrameEvaluationInput = frame(0)) => hook({ inputs: {}, values, frame: at, state, ...(audio === undefined ? {} : { audio }) });
}

describe("audioChroma (T1751b)", () => {
  it("publishes the twelve classes, the confidence, the tuning and the lag, by name", () => {
    const bag = evaluator(RAW)(record());
    expect(Object.keys(bag)).toEqual([...CHROMA_NAMES, "chromaConfidence", "tuning", "lagSeconds", "lagFrames"]);
    expect(CHROMA_NAMES.map((name) => bag[name])).toEqual([0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0]);
    expect(bag["chromaConfidence"]).toBe(1);
    expect(bag["tuning"]).toBe(12);
  });

  it("the lag is the record's, in seconds, and in frames at this frame's step", () => {
    const read = evaluator(RAW);
    expect(read(record(), frame(1, 1 / 60))["lagSeconds"]).toBe(0.085);
    expect(read(record(), frame(1, 1 / 60))["lagFrames"]).toBeCloseTo(0.085 * 60, 12);
    expect(read(record(), frame(1, 1 / 30))["lagFrames"]).toBeCloseTo(0.085 * 30, 12);
    // A paused frame has no step to count in.
    expect(read(record(), frame(1, 0))["lagFrames"]).toBe(0);
  });

  it("is SILENT — every channel present and 0 — with no audio, as Audio In is (§V329)", () => {
    const bag = evaluator({})(undefined);
    expect(Object.values(bag)).toEqual(new Array(16).fill(0));
  });

  it("GATE: input with no pitch in it reads as no notes; half-open at the middle of the step; Gate off publishes the profile as measured", () => {
    const profile = [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0];
    const classes = (bag: Record<string, number>): number[] => CHROMA_NAMES.map((name) => bag[name] as number);
    expect(classes(evaluator(RAW)(record({ chromaConfidence: CHROMA_GATE.closed })))).toEqual(new Array(12).fill(0));
    expect(classes(evaluator(RAW)(record({ chromaConfidence: CHROMA_GATE.open })))).toEqual(profile);
    // The Hermite step is exactly one half at its midpoint.
    const middle = (CHROMA_GATE.closed + CHROMA_GATE.open) / 2;
    const half = classes(evaluator(RAW)(record({ chromaConfidence: middle })));
    expect(half[9]).toBeCloseTo(0.5, 12);
    expect(half[4]).toBeCloseTo(0.25, 12);
    expect(classes(evaluator({ ...RAW, gate: false })(record({ chromaConfidence: 0 })))).toEqual(profile);
    // The confidence itself is published ungated either way: it is the thing to believe or not.
    expect(evaluator(RAW)(record({ chromaConfidence: 0.1 }))["chromaConfidence"]).toBe(0.1);
  });

  it("SMOOTHS by default — unlike the sources — and the step it takes is the follower's own arithmetic", () => {
    // Defaults: attack 0.03 s, release 0.25 s.
    const read = evaluator({});
    // First sight starts ON the reading: no swoop-in from zero.
    expect(read(record({ chroma9: 0 }), frame(0))["chroma9"]).toBe(0);
    const risen = read(record({ chroma9: 1 }), frame(1))["chroma9"] as number;
    expect(risen).toBeCloseTo(1 - Math.exp(-DELTA / 0.03), 12);
    const fallen = read(record({ chroma9: 0 }), frame(2))["chroma9"] as number;
    expect(fallen).toBeCloseTo(risen * Math.exp(-DELTA / 0.25), 12);
    // A note lights faster than it fades: that is what the two defaults are for.
    expect(risen).toBeGreaterThan(risen - fallen);
    // A paused frame holds.
    expect(read(record({ chroma9: 1 }), frame(3, 0))["chroma9"]).toBe(fallen);
  });

  it("Attack 0 and Release 0 are the readings exactly as they arrive", () => {
    const read = evaluator(RAW);
    expect(read(record({ chroma9: 0 }), frame(0))["chroma9"]).toBe(0);
    expect(read(record({ chroma9: 1 }), frame(1))["chroma9"]).toBe(1);
    expect(read(record({ chroma9: 0.25 }), frame(2))["chroma9"]).toBe(0.25);
  });
});

describe("T1751b — one record, published by exactly one family per field", () => {
  const graph = (type: string): GraphDocument =>
    ({
    revision: 1,
    nodes: { node: { id: "node", type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { attack: 0, release: 0, gate: false }, label: "node1" } },
    edges: {},
    groups: {},
  }) as never;
  const FEATURES: AudioFeatures = { ...SILENCE, level: 0.5, ...distinctSpectrumBands(0.01), ...distinctTonalFields(0.2) };
  const evaluate = (type: string, values: Readonly<Record<string, ParameterValue>>): Record<string, number> =>
    registry.get(type)!.valueEvaluate!({ inputs: {}, values, frame: frame(1), state: {}, audio: FEATURES });
  const published = (type: string): Record<string, number> => {
    const session = createValueGraphSession(registry);
    const result = session.evaluate(flatDocument(graph(type)), frame(1), { flattening: NO_FLATTENING, audio: FEATURES });
    return result.byName.get("node1") ?? {};
  };

  it("the sources publish no tonal field, the tonal nodes no source field, and together they publish the whole record", () => {
    const source = Object.keys(published("audioIn"));
    const tonal = TONAL_NODE_TYPES.flatMap((type) => Object.keys(published(type)));
    expect(source.filter((name) => tonal.includes(name))).toEqual([]);
    // Three record fields go out under the name a consumer of the harmony bag or of a lag reads.
    // (`pitchLag` is Notes' `lagSeconds`, as `tonalLag` is Chroma's; a voice's level is its
    // Envelope and its age is its Start, the harmony bag's two names for them.)
    const publishedAs = (name: string): string =>
      ({ tonalLag: "lagSeconds", pitchLag: "lagSeconds", chordRoot: "root", keyTonic: "tonalCenter" })[name] ?? name.replace(/^(voice\d)Level$/, "$1Envelope").replace(/^(voice\d)Age$/, "$1Start");
    // Notes publishes four voices by default; the record's fifth is one parameter away.
    const five = Object.keys(evaluate("audioNotes", { voices: 5 }));
    const unpublished = FEATURE_TRACK_FIELDS.filter((name) => !source.includes(name) && !tonal.includes(publishedAs(name)) && !five.includes(publishedAs(name)));
    expect(unpublished).toEqual([]);
    expect(VOICE_FIELD_NAMES.filter((name) => name.startsWith("voice4")).every((name) => !tonal.includes(publishedAs(name)))).toBe(true);
    expect(published("audioChroma")["lagSeconds"]).toBe(FEATURES.tonalLag);
  });

  it("through the value graph, Chroma reads the session's record: a different record is a different bag, and a muted node publishes nothing", () => {
    const session = createValueGraphSession(registry);
    const document = graph("audioChroma");
    const a = session.evaluate(flatDocument(document), frame(1), { flattening: NO_FLATTENING, audio: FEATURES });
    const b = session.evaluate(flatDocument(document), frame(2), { flattening: NO_FLATTENING, audio: { ...FEATURES, chroma7: 0.9 } });
    expect(a.byName.get("node1")?.["chroma7"]).toBe(FEATURES.chroma7);
    expect(b.byName.get("node1")?.["chroma7"]).toBe(0.9);
    const node = document.nodes["node"]!;
    const muted: GraphDocument = { ...document, nodes: { node: { ...node, ui: { ...node.ui, muted: true } } } };
    const c = createValueGraphSession(registry).evaluate(flatDocument(muted), frame(1), { flattening: NO_FLATTENING, audio: FEATURES });
    expect(c.byName.get("node1")).toBeUndefined();
  });
});

describe("audioChord (T1753b)", () => {
  const chordOf = (values: Readonly<Record<string, ParameterValue>> = {}) => {
    const definition = registry.get("audioChord");
    if (definition?.valueEvaluate === undefined) throw new Error("audioChord has no value hook");
    const hook = definition.valueEvaluate;
    return (audio: AudioFeatures | undefined, at: FrameEvaluationInput = frame(1)) => hook({ inputs: {}, values, frame: at, state: {}, ...(audio === undefined ? {} : { audio }) });
  };
  const claimed = (overrides: Partial<AudioFeatures> = {}): AudioFeatures => ({
    ...SILENCE,
    chordRoot: 5,
    chordQuality: 2,
    chordConfidence: 0.8,
    chordChangeCount: 1,
    chordAge: 1.5,
    keyTonic: 8,
    keyMode: 1,
    keyConfidence: 0.6,
    tonalLag: 0.085,
    ...overrides,
  });

  it("publishes the record's chord and key under the names the harmony bag uses for the root and the tonal centre", () => {
    expect(chordOf()(claimed())).toEqual({
      root: 5,
      chordQuality: 2,
      chordConfidence: 0.8,
      chordChangeCount: 1,
      chordAge: 1.5,
      tonalCenter: 8,
      keyMode: 1,
      keyConfidence: 0.6,
      lagSeconds: 0.085 + CHORD_LIVE_DECODE_SECONDS,
      lagFrames: (0.085 + CHORD_LIVE_DECODE_SECONDS) * 60,
    });
  });

  it("a pre-analysed file (a lag of 0 in the record) was decoded ahead: no lag to wait for", () => {
    const bag = chordOf()(claimed({ tonalLag: 0 }));
    expect([bag["lagSeconds"], bag["lagFrames"]]).toEqual([0, 0]);
  });

  it("Min Confidence hides a weaker chord as NO CHORD — root, quality, confidence and age 0 — and leaves the key and the change event alone", () => {
    const bag = chordOf({ minConfidence: 0.9 })(claimed());
    expect([bag["root"], bag["chordQuality"], bag["chordConfidence"], bag["chordAge"]]).toEqual([0, 0, 0, 0]);
    expect([bag["chordChangeCount"], bag["tonalCenter"], bag["keyMode"], bag["keyConfidence"]]).toEqual([1, 8, 1, 0.6]);
    // At exactly the threshold the chord shows; at 0 every claim does.
    expect(chordOf({ minConfidence: 0.8 })(claimed())["root"]).toBe(5);
    // And 0 is the default: every claim the analysis makes is published.
    expect(chordOf()(claimed({ chordConfidence: 0.01 }))["root"]).toBe(5);
  });

  it("is SILENT — every channel present and 0 — with no audio, and with no claim in the record", () => {
    expect(Object.values(chordOf()(undefined))).toEqual(new Array(10).fill(0));
    expect(Object.values(chordOf()(SILENCE))).toEqual(new Array(10).fill(0));
  });
});

describe("audioNotes (T1755b) — the lead pitch", () => {
  const notesOf = (values: Readonly<Record<string, ParameterValue>> = {}) => {
    const definition = registry.get("audioNotes");
    if (definition?.valueEvaluate === undefined) throw new Error("audioNotes has no value hook");
    const hook = definition.valueEvaluate;
    const state: Record<string, unknown> = {};
    return (audio: AudioFeatures | undefined, at: FrameEvaluationInput = frame(1)) => hook({ inputs: {}, values, frame: at, state, ...(audio === undefined ? {} : { audio }) });
  };
  const heard = (pitch: number, confidence = 0.97, onsets = 0): AudioFeatures => ({ ...SILENCE, pitch, pitchConfidence: confidence, pitchOnsetCount: onsets, pitchLag: 0.043 });

  it("publishes the pitch, its class, the confidence, the onsets and the lag", () => {
    expect(notesOf({ glide: 0 })(heard(61.4, 0.97, 1))).toMatchObject({
      pitch: 61.4,
      pitchClass: 1,
      pitchConfidence: 0.97,
      pitchOnsetCount: 1,
      lagSeconds: 0.043,
      lagFrames: 0.043 * 60,
    });
    // The class is the NEAREST note's: 59.6 is a flat C, not a B.
    expect(notesOf({ glide: 0 })(heard(59.6))["pitchClass"]).toBe(0);
  });

  it("HOLD (the default): through a rest the pitch stays where the last note left it, and the confidence says there is no note", () => {
    const read = notesOf({ glide: 0 });
    read(heard(64));
    const rest = read(heard(0, 0));
    expect([rest["pitch"], rest["pitchClass"], rest["pitchConfidence"]]).toEqual([64, 4, 0]);
    // Hold off: 0 with no claim. And before any note at all there is nothing to hold.
    const raw = notesOf({ glide: 0, hold: false });
    raw(heard(64));
    expect([raw(heard(0, 0))["pitch"], notesOf()(heard(0, 0))["pitch"]]).toEqual([0, 0]);
  });

  it("GLIDE (on by default — unlike the sources): pitch eases between notes by the frame step, and a note after a rest starts ON its pitch", () => {
    const read = notesOf({ glide: 0.03 });
    expect(read(heard(60), frame(0))["pitch"]).toBe(60);
    const moved = read(heard(62), frame(1))["pitch"] as number;
    expect(moved).toBeCloseTo(60 + 2 * (1 - Math.exp(-DELTA / 0.03)), 12);
    // A rest, then a note a fifth away: no slide up from the held pitch.
    read(heard(0, 0), frame(2));
    expect(read(heard(67), frame(3))["pitch"]).toBe(67);
    // A paused frame holds.
    expect(read(heard(72), frame(4, 0))["pitch"]).toBe(67);
  });

  it("is SILENT — every channel present and 0 — with no audio", () => {
    const bag = notesOf()(undefined);
    expect(["pitch", "pitchClass", "pitchConfidence", "pitchOnsetCount", "lagSeconds", "lagFrames"].map((name) => bag[name])).toEqual(new Array(6).fill(0));
  });
});

describe("audioNotes (T1756b) — the voices", () => {
  const notesOf = (values: Readonly<Record<string, ParameterValue>> = {}) => {
    const hook = registry.get("audioNotes")!.valueEvaluate!;
    const state: Record<string, unknown> = {};
    return (audio: AudioFeatures | undefined, at: FrameEvaluationInput = frame(1)) => hook({ inputs: {}, values, frame: at, state, ...(audio === undefined ? {} : { audio }) });
  };
  /** A record with voice 0 on `pitch`. */
  const voice0 = (pitch: number, fields: { level?: number; confidence?: number; age?: number; id?: number; onsets?: number } = {}): AudioFeatures => ({
    ...SILENCE,
    tonalLag: 0.085,
    voiceCount: (fields.confidence ?? 0.9) > 0 ? 1 : 0,
    voice0Pitch: pitch,
    voice0Level: fields.level ?? 0.7,
    voice0Confidence: fields.confidence ?? 0.9,
    voice0Age: fields.age ?? 0,
    voice0Id: fields.id ?? 1,
    voice0OnsetCount: fields.onsets ?? 0,
  });
  const RAW = { glide: 0, attack: 0, release: 0 } as const;

  it("publishes four voices by default, five when asked, each under the harmony bag's names", () => {
    const names = (bag: Record<string, number>): string[] => Object.keys(bag).filter((name) => /^voice\d/.test(name));
    expect(names(notesOf()(voice0(60)))).toHaveLength(4 * 9);
    expect(names(notesOf({ voices: 5 })(voice0(60)))).toHaveLength(5 * 9);
    expect(names(notesOf({ voices: 1 })(voice0(60)))).toEqual(["voice0Pitch", "voice0PitchClass", "voice0PositionPitch", "voice0Velocity", "voice0Envelope", "voice0Start", "voice0Id", "voice0OnsetCount", "voice0Confidence"]);
  });

  it("a note: the nearest MIDI note and its class, the exact pitch as the position, its level as velocity and envelope, when it began, its id", () => {
    const at = frame(120);
    const bag = notesOf(RAW)(voice0(61.2, { level: 0.6, age: 0.5, id: 7, onsets: 1 }), at);
    expect([bag["voice0Pitch"], bag["voice0PitchClass"], bag["voice0PositionPitch"]]).toEqual([61, 1, 61.2]);
    expect([bag["voice0Velocity"], bag["voice0Envelope"], bag["voice0Id"], bag["voice0OnsetCount"], bag["voice0Confidence"]]).toEqual([0.6, 0.6, 7, 1, 0.9]);
    expect(bag["voice0Start"]).toBeCloseTo(at.timeSeconds - 0.5, 12);
    expect([bag["voiceCount"], bag["noteDensity"]]).toEqual([1, 1]);
    // An empty slot beside it: nothing sounding, and no start.
    expect([bag["voice1Envelope"], bag["voice1Confidence"], bag["voice1Start"]]).toEqual([0, 0, -1]);
  });

  it("the velocity and the start are the NOTE's: they hold while its level decays, and change when its id does", () => {
    const read = notesOf(RAW);
    const first = read(voice0(60, { level: 0.8, id: 1 }), frame(10));
    const later = read(voice0(60, { level: 0.5, id: 1, age: 0.5 }), frame(40));
    expect([later["voice0Velocity"], later["voice0Envelope"], later["voice0Start"]]).toEqual([0.8, 0.5, first["voice0Start"]]);
    const next = read(voice0(64, { level: 0.6, id: 2 }), frame(41));
    expect([next["voice0Velocity"], next["voice0Start"]]).toEqual([0.6, frame(41).timeSeconds]);
  });

  it("an EMPTY slot keeps the last note's pitch and id, at envelope 0 — a picture placed by pitch does not snap to the floor", () => {
    const read = notesOf(RAW);
    read(voice0(67, { id: 3 }));
    const ended = read(voice0(67, { id: 3, confidence: 0, level: 0 }));
    expect([ended["voice0Pitch"], ended["voice0PositionPitch"], ended["voice0Id"], ended["voice0Envelope"], ended["voice0Confidence"], ended["voiceCount"]]).toEqual([67, 67, 3, 0, 0, 0]);
  });

  it("EASES by default: the envelope rises over Attack and falls over Release, the position glides within a note and jumps to a new one", () => {
    const read = notesOf({ glide: 0.03, attack: 0.01, release: 0.3 });
    const struck = read(voice0(60, { level: 0.8, id: 1 }), frame(0))["voice0Envelope"] as number;
    expect(struck).toBeCloseTo(0.8 * (1 - Math.exp(-DELTA / 0.01)), 12);
    const bent = read(voice0(60.5, { level: 0.8, id: 1 }), frame(1));
    expect(bent["voice0PositionPitch"]).toBeCloseTo(60 + 0.5 * (1 - Math.exp(-DELTA / 0.03)), 12);
    const ended = read(voice0(60.5, { level: 0, confidence: 0, id: 1 }), frame(2))["voice0Envelope"] as number;
    expect(ended).toBeCloseTo((bent["voice0Envelope"] as number) * Math.exp(-DELTA / 0.3), 12);
    // A new note a fifth up starts ON its pitch.
    expect(read(voice0(67, { id: 2 }), frame(3))["voice0PositionPitch"]).toBe(67);
  });

  it("the voices' lag is the long window's plus the step that confirms a note; a pre-analysed file's is the step alone", () => {
    expect(notesOf(RAW)(voice0(60))["voiceLagSeconds"]).toBeCloseTo(0.085 + 2048 / 48000, 12);
    expect(notesOf(RAW)({ ...voice0(60), tonalLag: 0 })["voiceLagSeconds"]).toBeCloseTo(2048 / 48000, 12);
    expect(notesOf(RAW)(undefined)["voiceLagSeconds"]).toBe(0);
  });
});

describe("tonePattern (T1757b) — the tonal nodes' understudy", () => {
  const hook = registry.get("tonePattern")!.valueEvaluate!;
  const at = (seconds: number, values: Readonly<Record<string, ParameterValue>> = {}, deltaSeconds = DELTA): Record<string, number> =>
    hook({ inputs: {}, values, frame: { timeSeconds: seconds, deltaSeconds, frameIndex: Math.round(seconds * 60), mode: "offline", randomSeed: 7 }, state: {} });
  // 120 BPM: a beat is half a second and a chord two seconds.
  const FAST = { bpm: 120 } as const;

  it("publishes EXACTLY the union of Chroma's, Chord's and Notes' channels: a real analysis is one node per family away", () => {
    const names = (type: string): string[] => Object.keys(registry.get(type)!.valueEvaluate!({ inputs: {}, values: {}, frame: frame(1), state: {} }));
    const union = new Set([...names("audioChroma"), ...names("audioChord"), ...names("audioNotes")]);
    expect(new Set(Object.keys(at(0.5)))).toEqual(union);
  });

  it("plays I, V, vi, IV in a major key and i, VI, III, VII in a minor one, a bar each, and names the key", () => {
    const chords = (values: Readonly<Record<string, ParameterValue>>): number[][] => [0.5, 2.5, 4.5, 6.5, 8.5].map((seconds) => [at(seconds, values)["root"]!, at(seconds, values)["chordQuality"]!]);
    expect(chords(FAST)).toEqual([[0, 1], [7, 1], [9, 2], [5, 1], [0, 1]]);
    expect(chords({ ...FAST, mode: "minor" })).toEqual([[0, 2], [8, 1], [3, 1], [10, 1], [0, 2]]);
    // Transposed whole: D major is the same shape two semitones up, and says it is D major.
    expect(chords({ ...FAST, key: 2 })).toEqual([[2, 1], [9, 1], [11, 2], [7, 1], [2, 1]]);
    const d = at(0.5, { ...FAST, key: 2 });
    expect([d["tonalCenter"], d["keyMode"], d["keyConfidence"], d["chordConfidence"], d["chromaConfidence"]]).toEqual([2, 1, 1, 1, 1]);
    expect(at(0.5, { ...FAST, mode: "minor" })["keyMode"]).toBe(2);
  });

  it("the voices are the chord — a bass and its triad — and agree with the root, the quality and the pitch classes", () => {
    const bag = at(2.5, FAST); // the G major bar
    expect([bag["voice0Pitch"], bag["voice1Pitch"], bag["voice2Pitch"], bag["voice3Pitch"]]).toEqual([55, 67, 71, 74]);
    expect([bag["voice0PitchClass"], bag["voice2PitchClass"], bag["voice3PitchClass"]]).toEqual([7, 11, 2]);
    expect([bag["voiceCount"], bag["noteDensity"], bag["voice1Confidence"]]).toEqual([4, 4, 1]);
    // The chord's own three classes lead the profile, the root's the strongest (two notes sound it).
    const classes = CHROMA_NAMES.map((name) => bag[name]!);
    const leaders = [...classes.keys()].sort((a, b) => classes[b]! - classes[a]!).slice(0, 3).sort((a, b) => a - b);
    expect(leaders).toEqual([2, 7, 11]);
    expect(classes[7]).toBe(1);
    // And a class no note or partial lands on is exactly silent: A flat, under G major.
    expect(classes[8]).toBe(0);
  });

  it("a voice's envelope is its velocity falling from the bar line, and its start and id are the bar's", () => {
    const struck = at(2, FAST);
    expect([struck["voice0Envelope"], struck["voice0Velocity"], struck["voice0Start"], struck["voice0Id"], struck["chordAge"]]).toEqual([0.8, 0.8, 2, 5, 0]);
    const later = at(3, FAST);
    expect(later["voice0Envelope"]).toBeCloseTo(0.8 * Math.exp(-1 / 2.5), 12);
    expect([later["voice0Start"], later["voice0Id"], later["chordAge"]]).toEqual([2, 5, 1]);
    expect(at(4, FAST)["voice0Id"]).toBe(9);
  });

  it("the lead plays one chord tone a beat: root, third, fifth, third, an octave over the triad", () => {
    const pitches = [0.25, 0.75, 1.25, 1.75, 2.25].map((seconds) => at(seconds, FAST)["pitch"]);
    expect(pitches).toEqual([72, 76, 79, 76, 79]);
    expect([at(0.75, FAST)["pitchClass"], at(0.75, FAST)["pitchConfidence"]]).toEqual([4, 1]);
  });

  it("events are counted over the frame INTERVAL: one chord change and one lead onset on the frame that crosses the line, none between, several under a slow frame", () => {
    const crossing = at(2 + DELTA / 2, FAST);
    expect([crossing["chordChangeCount"], crossing["voice0OnsetCount"], crossing["pitchOnsetCount"]]).toEqual([1, 1, 1]);
    const between = at(2.25, FAST);
    expect([between["chordChangeCount"], between["voice0OnsetCount"], between["pitchOnsetCount"]]).toEqual([0, 0, 0]);
    // A beat line that is not a bar line: a lead onset and no chord change.
    expect([at(2.5 + DELTA / 2, FAST)["pitchOnsetCount"], at(2.5 + DELTA / 2, FAST)["chordChangeCount"]]).toEqual([1, 0]);
    // A frame 2.5 s long, from 1.75 s to 4.25 s, holds two bar lines (2 s, 4 s) and five beat lines.
    const slow = at(4.25, FAST, 2.5);
    expect([slow["chordChangeCount"], slow["pitchOnsetCount"]]).toEqual([2, 5]);
    // The first frame begins the piece: its first chord and its first note are onsets.
    expect([at(0, FAST)["chordChangeCount"], at(0, FAST)["pitchOnsetCount"]]).toEqual([1, 1]);
  });

  it("Amount 0 is silence — no classes, no claims, no voices — and it is TIMELINE-ANCHORED: the same second is the same bag", () => {
    const silent = at(2.5, { ...FAST, amount: 0 });
    expect(Object.entries(silent).filter(([name, value]) => value !== 0 && !name.endsWith("Start"))).toEqual([]);
    expect(silent["voice0Start"]).toBe(-1);
    expect(at(3.3, FAST)).toEqual(at(3.3, FAST));
    expect(registry.get("tonePattern")!.description).toContain("TIMELINE-ANCHORED");
  });
});

