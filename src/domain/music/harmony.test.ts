import { describe, expect, it, vi } from "vitest";
import {
  exportHarmonyCheckpoint, importHarmonyCheckpoint, harmonyAt, harmonyNotesBetween,
  noteEnvelope, HARMONY_NOTE_DURATION, NOTE_ATTACK_SECONDS,
  type HarmonyConfig, type HarmonyNote,
} from "./harmony.ts";

const config: HarmonyConfig = {
  seed: 42, tempo: 120, initialKey: 0, initialMode: "major",
  harmonicComplexity: 0.8, evolutionRate: 0.5, musicalEnergy: 0.6,
};
function evict(): void {
  for (let seed = 100; seed < 110; seed += 1) harmonyAt(0, { ...config, seed });
}

describe("shared piano envelope", () => {
  const note: HarmonyNote = { id: 0, pitch: 60, velocity: 0.8, startTime: 0, holdDuration: 2, duration: 8 };
  it("is silent before onset, at onset and at/after total lifetime", () => {
    for (const t of [-1, 0, 8, 9]) expect(noteEnvelope(note, t)).toBe(0);
    expect(noteEnvelope(note, 8 - 1e-8)).toBeLessThan(1e-8);
  });
  it("matches recorded-piano attack, pitch-dependent decay, release and taper", () => {
    const expected = (age: number) => 0.8 * (1 - Math.exp(-age / 0.004)) ** 2
      * Math.exp(-age / (2.8 + 5 * 0.055)) * Math.exp(-Math.max(0, age - 2) / 0.95) * Math.min(1, (8 - age) / 0.12);
    for (const t of [0.002, NOTE_ATTACK_SECONDS, 0.03, 1, 2, 2.5, 7.94]) expect(noteEnvelope(note, t)).toBeCloseTo(expected(t), 14);
    expect(noteEnvelope(note, 0.03)).toBeGreaterThan(noteEnvelope(note, 0.004));
    expect(noteEnvelope({ ...note, pitch: 36 }, 1)).toBeGreaterThan(noteEnvelope({ ...note, pitch: 79 }, 1));
    expect(noteEnvelope({ ...note, holdDuration: 1 }, 1.5)).toBeLessThan(noteEnvelope(note, 1.5));
    expect(noteEnvelope({ ...note, startTime: 2 }, 2.5)).toBeCloseTo(noteEnvelope(note, 0.5), 14);
  });
  it("supports inferred hold and silent zero velocity", () => {
    const inferred = { ...note };
    delete inferred.holdDuration;
    expect(noteEnvelope(inferred, 3)).toBe(noteEnvelope(note, 3));
    expect(noteEnvelope({ ...note, velocity: 0 }, 1)).toBe(0);
    expect(HARMONY_NOTE_DURATION).toBe(18);
  });
  it("rejects invalid fields even outside the audible interval", () => {
    for (const t of [NaN, Infinity, -Infinity]) expect(() => noteEnvelope(note, t)).toThrow(RangeError);
    const invalid: Partial<HarmonyNote>[] = [
      ...[NaN, Infinity, -Infinity].map(startTime => ({ startTime })),
      ...[NaN, Infinity, -1, 0, NOTE_ATTACK_SECONDS, 19].map(duration => ({ duration })),
      ...[NaN, Infinity, -0.01, 1.01].map(velocity => ({ velocity })),
      ...[NaN, Infinity, 0, -1, 13, 8].map(holdDuration => ({ holdDuration })),
      ...[NaN, Infinity, -1, 128].map(pitch => ({ pitch })),
    ];
    for (const patch of invalid) for (const t of [-1, 1, 100]) expect(() => noteEnvelope({ ...note, ...patch }, t)).toThrow(RangeError);
  });
});

function chords(count: number, c: HarmonyConfig = config) {
  const states = [harmonyAt(0, c)];
  for (let i = 1; i < count; i += 1) {
    const previous = states[i - 1]!;
    states.push(harmonyAt(previous.startTime + previous.duration, c));
  }
  return states;
}

describe("expressive harmony timeline", () => {
  it("replays variable boundaries exactly independent of sampling, seeks and eviction", () => {
    const expected = chords(520);
    evict();
    for (const current of expected) {
      expect(harmonyAt(current.startTime, { ...config })).toEqual(current);
      expect(harmonyAt(current.startTime + current.duration * 0.73, config).index).toBe(current.index);
      if (current.index) expect(harmonyAt(current.startTime - 1e-9, config).index).toBe(current.index - 1);
    }
    evict();
    expect(harmonyAt(expected[519]!.startTime, config)).toEqual(expected[519]);
    expect(harmonyAt(expected[200]!.startTime, config)).toEqual(expected[200]);
  });

  it("does no transition replay for warmed alternating current/previous lookups", () => {
    const current = chords(511)[510]!;
    const previousTime = current.startTime - 1e-9;
    harmonyAt(previousTime, config);
    const multiply = vi.spyOn(Math, "imul");
    try {
      for (let frame = 0; frame < 20; frame += 1) harmonyAt(current.startTime, config);
      const hitCost = multiply.mock.calls.length;
      multiply.mockClear();
      for (let frame = 0; frame < 10; frame += 1) {
        harmonyAt(current.startTime, config);
        harmonyAt(previousTime, config);
      }
      expect(multiply.mock.calls.length).toBe(hitCost);
    } finally { multiply.mockRestore(); }
  });

  it("makes dominant harmony shorter than repose and varies harmonic rhythm", () => {
    const states = chords(160);
    const tense = states.filter(s => s.tension >= 0.65);
    const resting = states.filter(s => s.tension < 0.3);
    expect(tense.length).toBeGreaterThan(10);
    expect(resting.length).toBeGreaterThan(10);
    expect(tense.every(s => s.beats <= 3)).toBe(true);
    expect(resting.every(s => s.beats >= 6)).toBe(true);
    expect(new Set(states.map(s => s.beats)).size).toBeGreaterThanOrEqual(4);
    for (const [i, state] of states.entries()) {
      expect(state.duration).toBe(state.beats * 60 / config.tempo);
      expect(state.notes[0]!.startTime).toBe(state.startTime);
      if (i) expect(state.startTime).toBe(states[i - 1]!.startTime + states[i - 1]!.duration);
    }
  });

  it("roundtrips version 3 timing/motif checkpoints with seed zero and pending resolution", () => {
    for (const seed of [0, 42]) {
      const c = { ...config, seed };
      const states = chords(80, c);
      const state = states.find(s => exportHarmonyCheckpoint(s.startTime, c).state.pending !== null)!;
      expect(state).toBeDefined();
      const snapshot = exportHarmonyCheckpoint(state.startTime, c);
      expect(snapshot.version).toBe(3);
      const future = harmonyAt(state.startTime + 500, c);
      const events = harmonyNotesBetween(state.startTime, state.startTime + 60, c);
      const serialized = JSON.stringify(snapshot);
      evict();
      importHarmonyCheckpoint(JSON.parse(serialized));
      expect(harmonyAt(state.startTime + 500, c)).toEqual(future);
      expect(harmonyNotesBetween(state.startTime, state.startTime + 60, c)).toEqual(events);
      harmonyAt(0, c);
      expect(harmonyAt(state.startTime + 500, c)).toEqual(future);
    }
  });

  it("detaches checkpoint arrays, melody events and configuration in both directions", () => {
    const state = harmonyAt(100, config);
    const snapshot = exportHarmonyCheckpoint(100, config);
    const expectedEvents = harmonyNotesBetween(state.startTime, state.startTime + state.duration, config);
    evict();
    importHarmonyCheckpoint(snapshot);
    (snapshot.state.pitches as number[])[0] = 1;
    (snapshot.state.motif as number[])[0] = 0;
    (snapshot.state.motifRhythm as number[])[0] = 99;
    if (snapshot.state.melody[0]) snapshot.state.melody[0].pitch = 1;
    snapshot.config.seed = 1;
    expect(harmonyAt(100, config)).toEqual(state);
    expect(harmonyNotesBetween(state.startTime, state.startTime + state.duration, config)).toEqual(expectedEvents);
    const output = harmonyAt(100, config);
    output.notes[0]!.pitch = 99;
    expect(harmonyAt(100, config)).toEqual(state);
  });

  it("rejects legacy/malformed timing, motif, event identity and phrase checkpoints", () => {
    const snapshot = exportHarmonyCheckpoint(10, config);
    const expected = harmonyAt(15, config);
    const bad: unknown[] = [null, [], {}, { ...snapshot, version: 1 }, { ...snapshot, version: 2 }, { ...snapshot, config: null }];
    for (const [field, value] of Object.entries({ index: -1, random: 2 ** 32, key: 12, degree: 7, pending: undefined,
      memory: [], pitches: [53, 57, 57, 60, 62], root: NaN, tension: Infinity, complexity: -1,
      time: -1, duration: 0, beats: 5, phraseAge: 8, phraseLength: 100, phraseIndex: -1,
      motif: [0, 1, 2, 3], motifRhythm: [0.5, 0.3, 1, 1.5], motifPosition: 4, melodyEnd: 99,
      melody: [{ id: -1 }],
    })) bad.push({ ...snapshot, state: { ...snapshot.state, [field]: value } });
    bad.push({ ...snapshot, state: { ...snapshot.state, duration: snapshot.state.duration * 2 } });
    if (snapshot.state.melody.length) {
      for (const patch of [{ id: 0 }, { startTime: snapshot.state.time - 1 }, { pitch: 84 }, { duration: 19 }, { velocity: NaN }]) {
        bad.push({ ...snapshot, state: { ...snapshot.state, melody: [{ ...snapshot.state.melody[0], ...patch }] } });
      }
    }
    for (const value of bad) expect(() => importHarmonyCheckpoint(value)).toThrow(RangeError);
    expect(harmonyAt(15, config)).toEqual(expected);
  });

  it("has a persistent interval/rhythm motif and phrase-level development/rests", () => {
    const states = chords(50);
    const checkpoints = states.map(s => exportHarmonyCheckpoint(s.startTime, config).state);
    let developments = 0;
    for (let i = 1; i < checkpoints.length; i += 1) {
      const old = checkpoints[i - 1]!;
      const current = checkpoints[i]!;
      expect(current.motifRhythm).toEqual(old.motifRhythm);
      if (current.phraseIndex === old.phraseIndex) expect(current.motif).toEqual(old.motif);
      else {
        developments += 1;
        if (current.phraseIndex % 4 === 0) expect(current.motif).toEqual(old.motif.map(n => -n));
        else expect(current.motif.slice(0, 3)).toEqual(old.motif.slice(0, 3));
      }
      if (current.phraseAge === current.phraseLength - 1) {
        expect(current.melody.every(n => n.startTime < current.time + current.duration * 0.7)).toBe(true);
        if (current.melody.length) expect(current.melody[current.melody.length - 1]!.pitch % 12).toBe(current.root);
      }
    }
    expect(developments).toBeGreaterThan(5);
    const motif = checkpoints[0]!.motif;
    expect(motif.some(n => n > 0) && motif.some(n => n < 0)).toBe(true);
    const events = harmonyNotesBetween(0, states[49]!.startTime, config).filter(n => n.id % 64 >= 5);
    expect(events.length).toBeGreaterThan(100);
    expect(new Set(events.map(n => n.pitch)).size).toBeGreaterThan(8);
  });

  it("resolves every melodic non-chord tone stepwise inside its containing harmony", () => {
    let dissonances = 0;
    for (const state of chords(80)) {
      const pcs = new Set(state.notes.map(n => n.pitch % 12));
      const line = harmonyNotesBetween(state.startTime, state.startTime + state.duration, config).filter(n => n.id % 64 >= 5);
      for (const [i, note] of line.entries()) {
        if (pcs.has(note.pitch % 12)) continue;
        const resolution = line[i + 1]!;
        expect(resolution).toBeDefined();
        expect(pcs.has(resolution.pitch % 12)).toBe(true);
        expect([1, 2]).toContain(Math.abs(resolution.pitch - note.pitch));
        expect(resolution.startTime).toBeLessThan(state.startTime + state.duration);
        dissonances += 1;
      }
    }
    expect(dissonances).toBeGreaterThan(10);
  });

  it("keeps five registered harmonic slots, distinct IDs, differentiated dynamics and finite lifetimes", () => {
    const states = chords(180);
    let movement = 0;
    const gestures = new Set<string>();
    for (const [i, state] of states.entries()) {
      expect(state.notes).toHaveLength(5);
      expect(state.notes[0]!.pitch).toBeGreaterThanOrEqual(36);
      expect(state.notes[0]!.pitch).toBeLessThanOrEqual(47);
      expect(state.notes[0]!.startTime).toBe(state.startTime);
      expect(state.notes[4]!.velocity).toBeGreaterThanOrEqual(state.notes[0]!.velocity);
      expect(state.notes[0]!.velocity).toBeGreaterThanOrEqual(state.notes[1]!.velocity);
      expect(state.notes.reduce((sum, n) => sum + n.velocity, 0) / 5).toBeCloseTo(state.energy, 14);
      gestures.add(state.notes.map(n => Math.round((n.startTime - state.startTime) * 100)).join(","));
      for (const [voice, note] of state.notes.entries()) {
        expect(note.id).toBe(i * 64 + voice);
        expect(note.startTime).toBeGreaterThanOrEqual(state.startTime);
        expect(note.startTime).toBeLessThan(state.startTime + state.duration);
        if (voice > 0) {
          expect(note.pitch).toBeGreaterThan(state.notes[voice - 1]!.pitch);
          expect(note.pitch).toBeGreaterThanOrEqual(50);
          expect(note.pitch).toBeLessThanOrEqual(79);
        }
        if (voice > 1) {
          expect(note.pitch - state.notes[voice - 1]!.pitch).toBeLessThanOrEqual(12);
          if (state.notes[voice - 1]!.pitch < 60) expect(note.pitch - state.notes[voice - 1]!.pitch).toBeGreaterThanOrEqual(3);
        }
        if (i) movement += Math.abs(note.pitch - states[i - 1]!.notes[voice]!.pitch);
      }
    }
    expect(movement / (179 * 5)).toBeLessThan(3);
    expect(gestures.size).toBeGreaterThan(15);
    const events = harmonyNotesBetween(0, states[179]!.startTime, config);
    expect(new Set(events.map(n => n.id)).size).toBe(events.length);
    for (const note of events) {
      expect(note.pitch).toBeLessThanOrEqual(83);
      expect(note.duration).toBeCloseTo(note.holdDuration! + 6, 12);
      expect(note.duration).toBeLessThanOrEqual(18);
      expect(note.velocity).toBeGreaterThanOrEqual(0);
      expect(note.velocity).toBeLessThanOrEqual(1);
    }
  });

  it("resolves secondary targets and leading-tone/seventh voices", () => {
    const states = chords(240);
    let tendencies = 0;
    let resolved = 0;
    for (let i = 0; i < states.length - 1; i += 1) {
      const old = exportHarmonyCheckpoint(states[i]!.startTime, config).state;
      if (old.pending === null) continue;
      const next = states[i + 1]!;
      expect(next.root).toBe((old.key + [0, 2, 4, 5, 7, 9, 11][old.pending]!) % 12);
      for (let voice = 1; voice < 5; voice += 1) {
        const interval = ((old.pitches[voice]! - old.root) % 12 + 12) % 12;
        const motion = next.notes[voice]!.pitch - old.pitches[voice]!;
        if (interval === 4 || interval === 10) {
          tendencies += 1;
          if (interval === 4 ? motion === 1 : motion === -1 || motion === -2) resolved += 1;
        }
      }
    }
    expect(tendencies).toBeGreaterThan(10);
    expect(resolved / tendencies).toBeGreaterThan(0.65);
  });

  it("continues to a long horizon deterministically with 64 numeric identity slots", () => {
    const state = harmonyAt(20000, config);
    expect(state.index).toBeGreaterThan(5000);
    expect(state.notes.map(n => n.id)).toEqual(Array.from({ length: 5 }, (_, voice) => state.index * 64 + voice));
    evict();
    expect(harmonyAt(20000, config)).toEqual(state);
    expect(harmonyAt(state.startTime + state.duration, config).index).toBe(state.index + 1);
  });

  it("keeps identity arithmetic safe at the last supported chord", () => {
    const snapshot = exportHarmonyCheckpoint(0, config);
    const index = Math.floor((Number.MAX_SAFE_INTEGER - 63) / 64) - 1;
    snapshot.state.index = index;
    snapshot.state.time = index * snapshot.state.duration;
    snapshot.state.memory = Array(4).fill(snapshot.state.degree) as number[];
    snapshot.state.melody = [];
    importHarmonyCheckpoint(snapshot);
    const state = harmonyAt(snapshot.state.time, config);
    expect(state.notes.every(n => Number.isSafeInteger(n.id))).toBe(true);
    expect(() => harmonyAt(snapshot.state.time + snapshot.state.duration, config)).toThrow(RangeError);
    evict();
  });

  it("changes with seeds and develops chromatic color and related tonal centers", () => {
    expect(harmonyNotesBetween(0, 60, config)).not.toEqual(harmonyNotesBetween(0, 60, { ...config, seed: 43 }));
    expect(harmonyNotesBetween(0, 30, { ...config, seed: 0 })).not.toEqual(harmonyNotesBetween(0, 30, { ...config, seed: 1 }));
    const states = chords(160, { ...config, harmonicComplexity: 1, evolutionRate: 1 });
    expect(new Set(states.map(s => s.tonalCenter)).size).toBeGreaterThan(1);
    expect(states.some(s => s.notes.some(n => ![0, 2, 4, 5, 7, 9, 11].includes(n.pitch % 12)))).toBe(true);
  });

  it("has exact half-open composable windows at arbitrary and variable chord onsets", () => {
    for (const c of [config, { ...config, tempo: 1000, evolutionRate: 1 }]) {
      const events = harmonyNotesBetween(0, 20, c);
      const boundaries = [...events.slice(0, 25).map(n => n.startTime), ...chords(8, c).map(s => s.startTime)];
      for (const boundary of boundaries) {
        if (boundary > 20) continue;
        expect([...harmonyNotesBetween(0, boundary, c), ...harmonyNotesBetween(boundary, 20, c)]).toEqual(events);
        expect(harmonyNotesBetween(boundary, boundary + 1e-9, c)).toEqual(events.filter(n => n.startTime >= boundary && n.startTime < boundary + 1e-9));
        expect(harmonyNotesBetween(boundary, boundary, c)).toEqual([]);
      }
    }
  });

  it("supports all modes/parameter endpoints without mutating caller config", () => {
    const original = { ...config };
    for (const initialMode of ["major", "minor", "ionian", "dorian", "phrygian", "lydian", "mixolydian", "aeolian", "locrian"]) {
      for (const endpoint of [0, 1]) {
        const c = { ...config, seed: endpoint ? 0xffffffff : 0, initialMode, initialKey: endpoint ? 11 : 0,
          harmonicComplexity: endpoint, evolutionRate: endpoint, musicalEnergy: endpoint, tempo: endpoint ? 1000 : 1 };
        const states = chords(8, c);
        for (const state of states) {
          expect(state.duration).toBe(state.beats * 60 / c.tempo);
          expect(state.notes).toHaveLength(5);
          expect(state.phraseProgress).toBeGreaterThanOrEqual(0);
          expect(state.phraseProgress).toBeLessThan(1);
          expect(state.notes.every(n => Number.isFinite(n.duration) && n.duration <= 18)).toBe(true);
        }
      }
    }
    expect(config).toEqual(original);
  });

  it("rejects invalid configs, times and reversed ranges explicitly", () => {
    const invalid: Partial<HarmonyConfig>[] = [
      { seed: -1 }, { seed: 2 ** 32 }, { seed: 1.1 }, { seed: NaN },
      { tempo: 0 }, { tempo: Infinity }, { tempo: 1001 },
      { initialKey: -1 }, { initialKey: 12 }, { initialKey: 0.5 },
      { initialMode: "toString" }, { initialMode: "MAJOR" },
      { harmonicComplexity: -0.1 }, { evolutionRate: 1.1 }, { musicalEnergy: NaN },
    ];
    for (const patch of invalid) {
      expect(() => harmonyAt(0, { ...config, ...patch })).toThrow(RangeError);
      expect(() => harmonyNotesBetween(0, 0, { ...config, ...patch })).toThrow(RangeError);
    }
    for (const time of [-1, Infinity, NaN, Number.MAX_VALUE]) {
      expect(() => harmonyAt(time, config)).toThrow(RangeError);
      expect(() => harmonyNotesBetween(0, time, config)).toThrow(RangeError);
    }
    expect(() => harmonyNotesBetween(2, 1, config)).toThrow(RangeError);
  });

  it("benchmarks 20 seconds of frame playback with current/previous and event windows", () => {
    evict();
    const started = performance.now();
    let eventCount = 0;
    let lastIndex = -1;
    for (let frame = 0; frame <= 20 * 60; frame += 1) {
      const time = frame / 60;
      const state = harmonyAt(time, config);
      if (state.startTime > 0) harmonyAt(state.notes[0]!.startTime - 1e-9, config);
      if (state.index !== lastIndex) {
        eventCount += harmonyNotesBetween(state.startTime, state.startTime + state.duration, config).length;
        lastIndex = state.index;
      }
    }
    const elapsed = performance.now() - started;
    console.info(`harmony 20s/60fps: ${elapsed.toFixed(2)}ms, ${lastIndex + 1} chords, ${eventCount} notes`);
    expect(eventCount).toBeGreaterThan(20);
    expect(elapsed).toBeLessThan(1000);
  });
});
