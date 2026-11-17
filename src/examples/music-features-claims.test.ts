import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument } from "../domain/types/graph.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import type { ComponentRegistryView } from "../domain/components/index.ts";
import { frameFromClock, tempoAlong, DEFAULT_PROJECT_BPM } from "../domain/types/frame.ts";
import { createComponentSystem } from "../domain/components/registry.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { flattenComponents } from "../compiler/index.ts";
import { midiEventCountName, midiEventName, packMidiEvent } from "../domain/midi/midi-events.ts";
import { buildStarterComponents, type StarterComponent } from "./starter-components.ts";
import { contractOf, midiFeaturesSource, musicFeaturesSource, type FeatureComponentSource } from "./music-features.ts";
import { KEYS_REST_PITCH, MIDI_LANE_CHANNELS, MUSIC_FEATURE_GROUP_NAMES, MUSIC_FEATURE_GROUPS, MUSIC_VOICES, channelNames } from "./music-features-contract.ts";

/**
 * T1805b: MusicFeatures and MidiFeatures are held to ONE contract, on the shipped hosts.
 *
 * The hosts are the documents `examples/components/MusicFeatures.loom.json` and
 * `MidiFeatures.loom.json` are saved from (`component-sync.test.ts` holds the bytes to
 * them): the component, authored through the real commands, between its sources and one
 * tap an output. Everything here is read at the taps, which is where a user's network
 * reads it.
 *
 * WHAT IS CLAIMED
 *  1. The channel set. Every tap carries exactly the contract's channels on every frame,
 *     playing, in silence, with `tonal` unwired, with no keyboard and with one played.
 *  2. Ranges. Every bounded channel stays inside its bounds on every one of those frames.
 *  3. What is not known. In silence, and before any key, every channel reads the contract's
 *     rest value; the confidences are 0; `bpm` is the project's tempo; `voiceNStart` is -1.
 *  4. The fixtures, each with the figure it would read if the wire behind it were cut:
 *     the kick lands on Audio Pattern's kicks; the detected tempo is the pattern's within
 *     2 %; the root follows Tone Pattern's progression; a replayed keyboard gives the five
 *     roles, the strike times and the pedals.
 *
 * Per §V767 the fixture claims are records with a gap between what is read and what a cut
 * wire reads, not tight bands: the numbers move with the patterns, the relation does not.
 */

type Bags = Readonly<Record<string, Readonly<Record<string, number>>>>;
interface Shipped {
  readonly built: StarterComponent;
  readonly source: FeatureComponentSource;
}
/** One MIDI message at a time: `[seconds, status, data1, data2]`. */
type Played = readonly [seconds: number, status: number, data1: number, data2: number];

let nodes: NodeRegistryView;
let components: ComponentRegistryView;
let music: Shipped;
let keys: Shipped;

beforeAll(async () => {
  const built = await buildStarterComponents();
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  const shipped = (componentId: string, source: FeatureComponentSource): Shipped => {
    const found = built.find((entry) => entry.spec.componentId === componentId);
    if (found === undefined) throw new Error(`no starter component "${componentId}"`);
    system.components.register(found.definition);
    return { built: found, source };
  };
  music = shipped("musicFeatures", musicFeaturesSource);
  keys = shipped("midiFeatures", midiFeaturesSource);
  nodes = system.nodes;
  components = system.components.view();
}, 120_000);

interface RunOptions {
  readonly seconds: number;
  readonly fps?: number;
  /** An edit to the host before it runs: a parameter on a source or on the instance, a cut wire. */
  readonly edit?: (graph: GraphDocument) => void;
  readonly played?: readonly Played[];
  /** The project's tempo, stamped on every frame as the transport stamps it. */
  readonly projectBpm?: number;
}
interface Run {
  readonly fps: number;
  /** The taps' bags, frame by frame. */
  readonly frames: readonly Bags[];
  readonly diagnostics: readonly string[];
  /** The bags of the frame at `seconds`. */
  readonly at: (seconds: number) => Bags;
}

const named = (graph: GraphDocument, name: string): GraphDocument["nodes"][string] => {
  const found = Object.values(graph.nodes).find((node) => (node.label ?? node.id) === name);
  if (found === undefined) throw new Error(`the host has no node "${name}"`);
  return found;
};
const instanceOf = (graph: GraphDocument): GraphDocument["nodes"][string] => {
  const found = Object.values(graph.nodes).find((node) => node.type.startsWith("component:"));
  if (found === undefined) throw new Error("the host has no component instance");
  return found;
};
const cutWiresFrom = (graph: GraphDocument, name: string): void => {
  const source = named(graph, name).id;
  for (const [id, wire] of Object.entries(graph.edges)) if (wire.source.nodeId === source) delete graph.edges[id];
};

function run(shipped: Shipped, options: RunOptions): Run {
  const fps = options.fps ?? 60;
  const graph = structuredClone(shipped.built.document.graph) as GraphDocument;
  options.edit?.(graph);
  const flattened = flattenComponents({ graph, registry: nodes, components });
  const session = createValueGraphSession(nodes);
  const played = (options.played ?? []).map(([seconds, ...bytes]) => ({ seconds, packed: packMidiEvent(new Uint8Array(bytes)) as number }));
  const frames: Bags[] = [];
  const diagnostics = new Set<string>(flattened.diagnostics.map((entry) => `${entry.severity} ${entry.code}: ${entry.message}`));
  const count = Math.round(options.seconds * fps);
  for (let index = 0; index < count; index += 1) {
    const seconds = index / fps;
    const arrived = played.filter((event) => event.seconds <= seconds + 1e-9).length;
    // The session's MIDI ring, replayed: how many messages so far, and each by its slot.
    const channels = (name: string): number | undefined => {
      if (name === midiEventCountName("")) return arrived;
      const slot = played.findIndex((_, at) => midiEventName("", at) === name);
      return slot >= 0 && slot < arrived ? played[slot]!.packed : undefined;
    };
    const clock = frameFromClock({ timeSeconds: seconds, deltaSeconds: 1 / fps, frameIndex: index, mode: "offline", randomSeed: 1, fps });
    const frame = options.projectBpm === undefined ? clock : { ...clock, tempo: tempoAlong(options.projectBpm, seconds, 1 / fps) };
    const result = session.evaluate(flattened.graph, frame, { flattening: flattened, ...(options.played === undefined ? {} : { channels }) });
    for (const entry of result.diagnostics) diagnostics.add(`${entry.severity} ${entry.code}: ${entry.message}`);
    frames.push(Object.fromEntries(Object.entries(shipped.source.taps).map(([group, tap]) => [group, { ...(result.byId.get(tap as never) ?? {}) }])));
  }
  return { fps, frames, diagnostics: [...diagnostics], at: (seconds) => frames[Math.round(seconds * fps)]! };
}

const silence = (graph: GraphDocument): void => {
  named(graph, "pattern_beat").parameters["amount"] = 0;
  named(graph, "tones_song").parameters["amount"] = 0;
};

// A small piece for the keyboard. Note on is 0x90, note off 0x80, a controller 0xB0
// (64 the sustain pedal, 67 the soft one).
const C_MAJOR = [48, 52, 60, 67, 72];
const F_MAJOR = [41, 45, 53, 60, 65];
const PIECE: readonly Played[] = [
  ...C_MAJOR.map((note): Played => [1, 0x90, note, 100]),
  [3, 0xb0, 64, 127],
  ...C_MAJOR.map((note): Played => [4, 0x80, note, 0]),
  [6, 0xb0, 64, 0],
  ...F_MAJOR.map((note): Played => [10, 0x90, note, 50]),
  [11, 0xb0, 67, 127],
  ...F_MAJOR.map((note): Played => [12, 0x80, note, 0]),
];

/** The runs every structural claim is made over: both components, sounding and not. */
const scenarios = (): { name: string; shipped: Shipped; result: Run }[] => [
  { name: "MusicFeatures, playing", shipped: music, result: run(music, { seconds: 20 }) },
  { name: "MusicFeatures, playing at 30 fps", shipped: music, result: run(music, { seconds: 20, fps: 30 }) },
  { name: "MusicFeatures, silence", shipped: music, result: run(music, { seconds: 8, edit: silence }) },
  { name: "MusicFeatures, tonal unwired", shipped: music, result: run(music, { seconds: 12, edit: (graph) => cutWiresFrom(graph, "tones_song") }) },
  { name: "MidiFeatures, no keyboard", shipped: keys, result: run(keys, { seconds: 4 }) },
  { name: "MidiFeatures, the piece", shipped: keys, result: run(keys, { seconds: 14, played: PIECE }) },
];

describe("MusicFeatures and MidiFeatures publish one contract (T1805b)", () => {
  it("the sockets are the contract's groups, in its order: six shared, and lanes on MidiFeatures", () => {
    expect(music.built.definition.inputs.map((port) => port.externalId)).toEqual(["audio", "tonal"]);
    expect(music.built.definition.outputs.map((port) => port.externalId)).toEqual([...MUSIC_FEATURE_GROUP_NAMES]);
    expect(keys.built.definition.inputs).toEqual([]);
    expect(keys.built.definition.outputs.map((port) => port.externalId)).toEqual([...MUSIC_FEATURE_GROUP_NAMES, "lanes"]);
    // The lanes are MIDI's alone, and no name is in two groups: a merged bag loses nothing.
    const every = [...MUSIC_FEATURE_GROUP_NAMES.flatMap((group) => channelNames(MUSIC_FEATURE_GROUPS[group])), ...channelNames(MIDI_LANE_CHANNELS)];
    expect(new Set(every).size).toBe(every.length);
  });

  it("every tap carries exactly the contract's channels on every frame, in range, with no diagnostic", () => {
    for (const { name, shipped, result } of scenarios()) {
      expect(result.diagnostics, `${name}: diagnostics`).toEqual([]);
      const problems: string[] = [];
      result.frames.forEach((bags, index) => {
        for (const group of Object.keys(shipped.source.taps)) {
          const contract = contractOf(group);
          const published = Object.keys(bags[group]!).sort().join(" ");
          const wanted = [...channelNames(contract)].sort().join(" ");
          if (published !== wanted && problems.length < 5) problems.push(`frame ${String(index)} ${group}: published [${published}]`);
          for (const channel of contract) {
            const value = bags[group]![channel.name];
            if (value === undefined) continue;
            const inside = Number.isFinite(value) && value >= channel.min && (channel.max === null || value <= channel.max);
            if (!inside && problems.length < 5) problems.push(`frame ${String(index)} ${group}.${channel.name} = ${String(value)}, outside ${String(channel.min)}..${String(channel.max)}`);
          }
        }
      });
      expect(problems, name).toEqual([]);
    }
  }, 120_000);

  it("the scenarios are not six silences: a channel of every group moves when the music plays", () => {
    // Sensitivity for the claim above, which a component publishing constants would pass.
    const moved = (result: Run, group: string, channel: string): number => {
      const values = result.frames.map((bags) => bags[group]![channel]!);
      return Math.max(...values) - Math.min(...values);
    };
    const playing = run(music, { seconds: 20 });
    for (const [group, channel] of [["levels", "level"], ["beats", "kick"], ["tempo", "bpmConfidence"], ["notes", "voice0Envelope"], ["harmony", "root"], ["form", "energy"]] as const) {
      expect(moved(playing, group, channel), `MusicFeatures ${group}.${channel}`).toBeGreaterThan(0.3);
    }
    const piece = run(keys, { seconds: 14, played: PIECE });
    for (const [group, channel] of [["levels", "level"], ["beats", "onset"], ["notes", "voice0Envelope"], ["harmony", "root"], ["form", "fullness"], ["lanes", "lane0Onset"]] as const) {
      expect(moved(piece, group, channel), `MidiFeatures ${group}.${channel}`).toBeGreaterThan(0.2);
    }
  }, 120_000);
});

describe("what a source does not know reads its rest value, with no confidence (T1805b)", () => {
  /** Every channel that rests, against what it reads on every frame of a run. */
  const offRest = (result: Run, shipped: Shipped, rest: (channel: { rest: number | null; restFromKeys?: number }) => number | null): string[] => {
    const problems: string[] = [];
    result.frames.forEach((bags, index) => {
      for (const group of Object.keys(shipped.source.taps)) {
        for (const channel of contractOf(group)) {
          const expected = rest(channel);
          if (expected === null) continue;
          const value = bags[group]![channel.name]!;
          if (Math.abs(value - expected) > 1e-12 && problems.length < 5) problems.push(`frame ${String(index)} ${group}.${channel.name} = ${String(value)}, rest is ${String(expected)}`);
        }
      }
    });
    return problems;
  };

  it("MusicFeatures in silence: every channel at rest from the first frame, voiceNStart -1, every confidence 0", () => {
    const quiet = run(music, { seconds: 8, edit: silence });
    expect(offRest(quiet, music, (channel) => channel.rest)).toEqual([]);
    const last = quiet.frames.at(-1)!;
    for (let voice = 0; voice < MUSIC_VOICES; voice += 1) expect(last["notes"]![`voice${String(voice)}Start`]).toBe(-1);
    expect([last["tempo"]!["bpmConfidence"], last["notes"]!["notesConfidence"], last["harmony"]!["chordConfidence"], last["harmony"]!["keyConfidence"], last["harmony"]!["chromaConfidence"]]).toEqual([0, 0, 0, 0, 0]);
    // The sensitivity: the same channels are NOT at rest while the patterns play.
    expect(offRest(run(music, { seconds: 8 }), music, (channel) => channel.rest).length).toBeGreaterThan(0);
  });

  it("MidiFeatures before any key: every channel at rest, an empty role at its place between notes 48 and 72", () => {
    const untouched = run(keys, { seconds: 4 });
    expect(offRest(untouched, keys, (channel) => channel.restFromKeys ?? channel.rest)).toEqual([]);
    const last = untouched.frames.at(-1)!;
    expect(Array.from({ length: MUSIC_VOICES }, (_, voice) => last["notes"]![`voice${String(voice)}Pitch`])).toEqual([48, 54, 60, 66, 72]);
    expect([0, 1, 2, 3, 4].map(KEYS_REST_PITCH)).toEqual([48, 54, 60, 66, 72]);
    expect(offRest(run(keys, { seconds: 4, played: PIECE }), keys, (channel) => channel.restFromKeys ?? channel.rest).length).toBeGreaterThan(0);
  });

  it("bpm is never 0: the project's tempo while nothing is detected or declared, and the beat count runs at it", () => {
    for (const shipped of [music, keys]) {
      const edit = shipped === music ? silence : undefined;
      const name = shipped.built.spec.name;
      // No tempo stamped: the default project tempo.
      const plain = run(shipped, { seconds: 4, ...(edit === undefined ? {} : { edit }) });
      expect(new Set(plain.frames.map((bags) => bags["tempo"]!["bpm"])), name).toEqual(new Set([DEFAULT_PROJECT_BPM]));
      // A project at 96: the same wire reads 96, at confidence 0, and four seconds are 6.4 beats.
      const slow = run(shipped, { seconds: 4, projectBpm: 96, ...(edit === undefined ? {} : { edit }) });
      expect(new Set(slow.frames.map((bags) => bags["tempo"]!["bpm"])), name).toEqual(new Set([96]));
      expect(slow.frames.at(-1)!["tempo"]!["bpmConfidence"], name).toBe(0);
      expect(slow.frames.at(-1)!["tempo"]!["bpmDetected"], name).toBe(0);
      expect(slow.frames.at(-1)!["tempo"]!["beats"], name).toBeCloseTo((96 / 60) * 4, 5);
      // Declared BPM on the instance wins over the project, at confidence 1.
      const declared = run(shipped, {
        seconds: 4,
        projectBpm: 96,
        edit: (graph) => {
          edit?.(graph);
          instanceOf(graph).parameters["declaredBpm"] = 150;
        },
      });
      expect(declared.frames.at(-1)!["tempo"]!["bpm"], name).toBe(150);
      expect(declared.frames.at(-1)!["tempo"]!["bpmConfidence"], name).toBe(1);
      expect(declared.frames.at(-1)!["tempo"]!["beats"], name).toBeCloseTo((150 / 60) * 4, 5);
    }
  });
});

describe("MusicFeatures on the two patterns (T1805b)", () => {
  it("kickFast fires on the pattern's kicks and reads 0 between them; kick is its pulse, with a tail", () => {
    const playing = run(music, { seconds: 24 });
    // After the warm-up (the drum presence and the range followers have charged by 8 s).
    // 120 a minute at 60 frames a second: a kick every 30 frames.
    const strikes: number[] = [];
    const between: number[] = [];
    for (let beat = 16; beat < 48; beat += 1) {
      const fast = playing.frames.slice(beat * 30, (beat + 1) * 30).map((bags) => bags["beats"]!["kickFast"]!);
      strikes.push(Math.max(...fast.slice(0, 3)));
      between.push(Math.max(...fast.slice(4)));
    }
    console.log(`kickFast within three frames of the 32 kicks from 8 s: ${strikes.map((value) => value.toFixed(2)).join(" ")}; on the 26 frames before the next: max ${String(Math.max(...between))}`);
    /*
     * MEASURED: 1.00 on thirty of the thirty-two, 0.12 on the other two, 0 between. The two
     * are the first kick of the pattern's breakdown bar (every fourth bar drops its top end,
     * T776): the level falls on the same frame the kick lands, and the fast detector reads
     * that as most of a kick gone. `kick`, with its tail, does not dip there (below).
     */
    const intoBreakdown = (at: number): boolean => (at + 16) % 16 === 12;
    expect(Math.min(...strikes.filter((_, at) => !intoBreakdown(at)))).toBeGreaterThan(0.9);
    expect(strikes.filter((_, at) => !intoBreakdown(at)).length).toBe(30);
    expect(Math.max(...between)).toBe(0);

    // The pulse peaks 0.1 s after each kick and has fallen before the next.
    const peaks: number[] = [];
    const troughs: number[] = [];
    for (let beat = 16; beat < 46; beat += 1) {
      const window = playing.frames.slice(beat * 30, (beat + 1) * 30).map((bags) => bags["beats"]!["kick"]!);
      peaks.push(Math.max(...window.slice(0, 12)));
      troughs.push(window[29]!);
    }
    console.log(`kick: peaks ${Math.min(...peaks).toFixed(3)}..${Math.max(...peaks).toFixed(3)}, just before the next kick ${Math.min(...troughs).toFixed(3)}..${Math.max(...troughs).toFixed(3)}`);
    expect(Math.min(...peaks)).toBeGreaterThan(0.7);
    expect(Math.max(...troughs)).toBeLessThan(0.5);

    // The wire cut: the same host with no sound has no kick at all.
    const quiet = run(music, { seconds: 12, edit: silence });
    expect(Math.max(...quiet.frames.map((bags) => Math.max(bags["beats"]!["kick"]!, bags["beats"]!["kickFast"]!)))).toBe(0);
  }, 120_000);

  it("the detected tempo is the pattern's within 2 % after the warm-up, at three tempos and two frame rates", () => {
    for (const fps of [60, 30]) {
      for (const bpm of [96, 120, 140]) {
        const playing = run(music, { seconds: 20, fps, edit: (graph) => (named(graph, "pattern_beat").parameters["bpm"] = bpm) });
        const settled = playing.frames.slice(12 * fps).map((bags) => bags["tempo"]!);
        const detected = settled.map((tempo) => tempo["bpmDetected"]!);
        const worst = Math.max(...detected.map((value) => Math.abs(value - bpm) / bpm));
        console.log(`pattern ${String(bpm)} at ${String(fps)} fps: bpmDetected ${Math.min(...detected).toFixed(2)}..${Math.max(...detected).toFixed(2)}, confidence from ${Math.min(...settled.map((tempo) => tempo["bpmConfidence"]!)).toFixed(2)}`);
        expect(worst, `pattern ${String(bpm)} at ${String(fps)} fps`).toBeLessThan(0.02);
        // The claim comes with a confidence, and `bpm` takes the detected tempo, not the project's 120.
        expect(Math.min(...settled.map((tempo) => tempo["bpmConfidence"]!))).toBeGreaterThan(0.3);
        expect(Math.max(...settled.map((tempo) => Math.abs(tempo["bpm"]! - bpm) / bpm))).toBeLessThan(0.02);
        // Before five kicks have been heard there is no claim: 0, not a guess.
        expect(playing.at(1)["tempo"]!["bpmDetected"]).toBe(0);
        expect(playing.at(1)["tempo"]!["bpmConfidence"]).toBe(0);
      }
    }
  }, 240_000);

  it("root follows the progression, a chord late by one frame at most, and chordIndex counts the changes", () => {
    // Tone Pattern at 60: a chord every 4 s. D major's I, V, vi, IV are D, A, B minor, G.
    const inD = run(music, { seconds: 33 });
    const roots = (result: Run): number[] => [0, 1, 2, 3, 4, 5, 6, 7].map((bar) => result.at(bar * 4 + 1)["harmony"]!["root"]!);
    expect(roots(inD)).toEqual([2, 9, 11, 7, 2, 9, 11, 7]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((bar) => inD.at(bar * 4 + 1)["harmony"]!["chordIndex"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([0, 1, 2, 3].map((bar) => inD.at(bar * 4 + 1)["harmony"]!["chordQuality"])).toEqual([1, 1, 2, 1]);
    expect(inD.at(5)["harmony"]!["pitchSource"]).toBe(4);
    // The bass voice is the root, and the top voice the highest tracked note: the fifth.
    expect(inD.at(5)["notes"]!["voice0PitchClass"]).toBe(9);
    expect(inD.at(5)["notes"]!["voice4PitchClass"]).toBe(4);
    expect(inD.at(5)["notes"]!["voice0Pitch"]).toBe(57);

    // The same host with the song in F: the roots are F's. They follow the wire, not the file.
    const inF = run(music, { seconds: 17, edit: (graph) => (named(graph, "tones_song").parameters["key"] = 5) });
    expect([0, 1, 2, 3].map((bar) => inF.at(bar * 4 + 1)["harmony"]!["root"])).toEqual([5, 0, 2, 10]);

    // The wire cut: nothing tonal is known, and the root says so rather than guessing.
    const unwired = run(music, { seconds: 17, edit: (graph) => cutWiresFrom(graph, "tones_song") });
    expect([0, 1, 2, 3].map((bar) => unwired.at(bar * 4 + 1)["harmony"]!["root"])).toEqual([0, 0, 0, 0]);
    expect(unwired.at(13)["harmony"]!["pitchSource"]).toBe(0);
    expect(unwired.at(13)["harmony"]!["chordConfidence"]).toBe(0);
  }, 120_000);

  it("voiceNOnset is 0 at rest and 1 while a strike is up, so a Count at its default threshold counts the strikes", () => {
    const playing = run(music, { seconds: 33 });
    for (let voice = 0; voice < MUSIC_VOICES; voice += 1) {
      const onsets = playing.frames.map((bags) => bags["notes"]![`voice${String(voice)}Onset`]!);
      // The project's signal sat near -0.5 at rest and peaked at 0.5 or less.
      expect(new Set(onsets), `voice ${String(voice)}`).toEqual(new Set([0, 1]));
      expect(onsets.filter((value) => value === 0).length / onsets.length, `voice ${String(voice)}`).toBeGreaterThan(0.9);
    }
    // The bass is struck when the progression comes round to its first chord (measured: one
    // accepted strike, at 16.017 s): its onset rises on that frame, and `voice0Start` is its time.
    const bass = playing.frames.map((bags) => bags["notes"]!["voice0Onset"]!);
    const rises = bass.flatMap((value, index) => (value === 1 && bass[index - 1] === 0 ? [index / playing.fps] : []));
    expect(rises.length).toBeGreaterThan(0);
    expect(playing.frames.at(-1)!["notes"]!["voice0Start"]).toBeCloseTo(rises.at(-1)!, 6);
  }, 120_000);
});

describe("MidiFeatures on a replayed keyboard (T1805b)", () => {
  it("five keys become the five roles, struck when they were played, at the velocity they were played with", () => {
    const piece = run(keys, { seconds: 14, played: PIECE });
    // C major, struck at 1 s, velocity 100: bass, three inner voices low to high, top.
    const afterC = piece.at(2)["notes"]!;
    expect(Array.from({ length: MUSIC_VOICES }, (_, voice) => afterC[`voice${String(voice)}Pitch`])).toEqual(C_MAJOR);
    expect(Array.from({ length: MUSIC_VOICES }, (_, voice) => afterC[`voice${String(voice)}PitchClass`])).toEqual(C_MAJOR.map((note) => note % 12));
    for (let voice = 0; voice < MUSIC_VOICES; voice += 1) {
      // The message is read on the first frame at or after it arrived.
      expect(afterC[`voice${String(voice)}Start`], `voice ${String(voice)} start`).toBeCloseTo(1, 9);
      // Sensitivity 0.5 is a straight touch curve: the velocity as played.
      expect(afterC[`voice${String(voice)}Velocity`], `voice ${String(voice)} velocity`).toBeCloseTo(100 / 127, 9);
      expect(afterC[`voice${String(voice)}Envelope`], `voice ${String(voice)} envelope`).toBeGreaterThan(0.2);
      expect(piece.at(0.9)["notes"]![`voice${String(voice)}Start`]).toBe(-1);
    }
    expect(piece.at(2)["harmony"]!["root"]).toBe(0);
    expect(piece.at(2)["harmony"]!["chordQuality"]).toBe(1);
    expect(piece.at(2)["levels"]!["gate"]).toBe(1);
    expect(piece.at(2)["notes"]!["noteDensity"]).toBe(5);

    // F major at 10 s, velocity 50: every role moves to its new key, and says when.
    const afterF = piece.at(11)["notes"]!;
    expect(Array.from({ length: MUSIC_VOICES }, (_, voice) => afterF[`voice${String(voice)}Pitch`])).toEqual(F_MAJOR);
    expect(afterF["voice0Start"]).toBeCloseTo(10, 9);
    expect(afterF["voice0Velocity"]).toBeCloseTo(50 / 127, 9);
    expect(piece.at(11)["harmony"]!["root"]).toBe(5);
    // Three accepted changes: C major, the chord ending when the pedal lifts, F major.
    expect([0.9, 2, 9, 11].map((seconds) => piece.at(seconds)["harmony"]!["chordIndex"])).toEqual([0, 1, 2, 3]);

    // Strikes as beats: every strike is an onset, and only the F chord has keys below 48.
    expect(piece.at(1)["beats"]!["onset"]).toBe(1);
    expect(piece.at(1)["beats"]!["onsetLow"]).toBe(0);
    expect(piece.at(10)["beats"]!["onsetLow"]).toBeCloseTo(2 * (50 / 127), 9);
    // Lanes: the bass strikes lane 0 and the top lane 4, on the strike's frame only.
    expect([piece.at(1)["lanes"]!["lane0Onset"], piece.at(1)["lanes"]!["lane4Onset"]]).toEqual([1, 1]);
    expect([piece.at(1.1)["lanes"]!["lane0Onset"], piece.at(1.1)["lanes"]!["lane4Onset"]]).toEqual([0, 0]);
  });

  it("the pedals are published raw and slow, and a pedalled chord rings on after its keys are up", () => {
    const piece = run(keys, { seconds: 14, played: PIECE });
    const notes = (seconds: number): Readonly<Record<string, number>> => piece.at(seconds)["notes"]!;
    // Sustain goes down at 3 s and up at 6 s; the soft pedal goes down at 11 s.
    expect([notes(2.9)["sustain"], notes(3)["sustain"], notes(5.9)["sustain"], notes(6)["sustain"]]).toEqual([0, 1, 1, 0]);
    expect([notes(10.9)["soft"], notes(11)["soft"]]).toEqual([0, 1]);
    // The slow ones follow over 1.5 s: part of the way after half a second, most of it after three.
    expect(notes(3.5)["sustainSlow"]).toBeGreaterThan(0.15);
    expect(notes(3.5)["sustainSlow"]).toBeLessThan(0.5);
    expect(notes(5.9)["sustainSlow"]).toBeGreaterThan(0.8);
    expect(notes(12)["softSlow"]).toBeGreaterThan(0.3);
    expect(notes(12)["softSlow"]).toBeLessThan(0.7);

    // The keys come up at 4 s under the pedal: the chord still sounds at 5.5 s, and stops when the pedal lifts.
    expect(piece.at(5.5)["levels"]!["gate"]).toBe(1);
    expect(notes(5.5)["noteDensity"]).toBe(5);
    expect(piece.at(7.9)["levels"]!["gate"]).toBe(0);

    // The same piece with the pedal messages taken out: the chord is gone by 5.5 s.
    const dry = run(keys, { seconds: 12, played: PIECE.filter(([, status]) => status !== 0xb0) });
    expect(dry.at(5.5)["levels"]!["gate"]).toBe(0);
    expect(new Set(dry.frames.map((bags) => bags["notes"]!["sustain"]))).toEqual(new Set([0]));
  });
});
