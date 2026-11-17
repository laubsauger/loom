/** Pure timeline harmony. Memoization affects cost only, never musical decisions. */
export interface HarmonyConfig {
  seed: number;
  tempo: number;
  initialKey: number;
  initialMode: string;
  harmonicComplexity: number;
  evolutionRate: number;
  musicalEnergy: number;
}

export interface HarmonyNote {
  id: number;
  pitch: number;
  velocity: number;
  startTime: number;
  /** Total lifetime including the release tail, at most HARMONY_NOTE_DURATION. */
  duration: number;
  /** Time the key is held; omitted callers infer max(.01, duration - 6). */
  holdDuration?: number;
}

export const HARMONY_NOTE_DURATION = 18;
export const NOTE_ATTACK_SECONDS = 0.004;
export const PIANO_PARTIAL_GAIN = 0.16;
export const NOTE_GAIN_FLOOR = 0.00001;

/** Analytic recorded-piano envelope, shared by audio and visual mappings.
 * duration is total lifetime; holdDuration is key-down time, capped at 12 seconds.
 * Finite evaluation times may precede onset. Zero velocity is silent.
 */
export function noteEnvelope(note: HarmonyNote, timeSeconds: number): number {
  if (!Number.isFinite(timeSeconds)) throw new RangeError("timeSeconds must be finite");
  if (!note || !Number.isFinite(note.startTime)) throw new RangeError("note.startTime must be finite");
  if (!Number.isFinite(note.pitch) || note.pitch < 0 || note.pitch > 127) throw new RangeError("note.pitch must be in [0,127]");
  if (!Number.isFinite(note.duration) || note.duration <= NOTE_ATTACK_SECONDS || note.duration > HARMONY_NOTE_DURATION) {
    throw new RangeError("note.duration must exceed attack and be at most HARMONY_NOTE_DURATION");
  }
  if (!Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) throw new RangeError("note.velocity must be in [0,1]");
  const hold = note.holdDuration === undefined ? Math.max(0.01, note.duration - 6) : note.holdDuration;
  if (!Number.isFinite(hold) || hold <= 0 || hold > 12 || (note.holdDuration !== undefined && hold >= note.duration)) throw new RangeError("note.holdDuration must be positive, at most 12, and below total duration");
  const age = timeSeconds - note.startTime;
  if (age < 0 || age >= note.duration) return 0;
  const decay = 2.8 + Math.max(0, 65 - note.pitch) * 0.055;
  const attack = (1 - Math.exp(-age / NOTE_ATTACK_SECONDS)) ** 2;
  const release = Math.exp(-Math.max(0, age - hold) / 0.95);
  const taper = Math.min(1, (note.duration - age) / 0.12);
  return note.velocity * attack * Math.exp(-age / decay) * release * taper;
}

export interface HarmonyState {
  index: number;
  startTime: number;
  duration: number;
  beats: number;
  root: number;
  tonalCenter: number;
  tension: number;
  brightness: number;
  complexity: number;
  energy: number;
  phraseProgress: number;
  notes: readonly HarmonyNote[];
}

const MODES: Record<string, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11], ionian: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};
const pc = (n: number): number => ((n % 12) + 12) % 12;
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
/** Stateless seeded sample; includes high index bits for long timelines. */
function sample(seed: number, index: number): number {
  let n = (seed ^ Math.imul(index >>> 0, 0x45d9f3b) ^ Math.imul(Math.floor(index / 4294967296), 0x27d4eb2d)) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Smooth seeded movement between targets 32 chords apart. */
function macro(index: number, seed: number): number {
  const block = Math.floor(index / 32);
  const phase = (index % 32) / 32;
  const smooth = phase * phase * (3 - 2 * phase);
  return 2 * (sample(seed, block) * (1 - smooth) + sample(seed, block + 1) * smooth) - 1;
}

function energy(c: Cursor, config: HarmonyConfig): number {
  return clamp(config.musicalEnergy + 0.1 * macro(c.index, config.seed ^ 0x4e524759)
    + 0.025 * (2 * sample(c.random, c.index) - 1)
    + 0.07 * Math.sin(Math.PI * c.phraseAge / c.phraseLength));
}
const MAX_INDEX = Math.floor((Number.MAX_SAFE_INTEGER - 63) / 64) - 1;
/** Complete continuation state; random is the uint32 Mulberry32 PRNG state. */
export interface HarmonyCheckpointState {
  index: number;
  time: number;
  duration: number;
  beats: number;
  phraseIndex: number;
  phraseAge: number;
  phraseLength: number;
  motif: readonly number[];
  motifRhythm: readonly number[];
  motifPosition: number;
  melodyEnd: number;
  melody: readonly HarmonyNote[];
  random: number;
  key: number;
  degree: number;
  pending: number | null;
  memory: readonly number[];
  pitches: readonly number[];
  root: number;
  tension: number;
  complexity: number;
}
export interface HarmonyCheckpoint {
  version: 3;
  config: HarmonyConfig;
  state: HarmonyCheckpointState;
}
type Cursor = HarmonyCheckpointState;
interface Timeline {
  config: HarmonyConfig;
  checkpoints: Cursor[];
  live: Cursor[];
  anchor?: Cursor;
}
// At most eight configurations: 32 sparse/anchor cursors plus two recent live cursors.
const cache = new Map<string, Timeline>();

function timeline(config: HarmonyConfig): Timeline {
  if (!config || typeof config !== "object") throw new RangeError("HarmonyConfig is required");
  const { seed, tempo, initialKey, initialMode, harmonicComplexity, evolutionRate, musicalEnergy } = config;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError("seed must be a uint32");
  if (!Number.isFinite(tempo) || tempo < 1 || tempo > 1000) throw new RangeError("tempo must be in [1,1000] BPM");
  if (!Number.isInteger(initialKey) || initialKey < 0 || initialKey > 11) throw new RangeError("initialKey must be an integer in [0,11]");
  if (typeof initialMode !== "string" || !Object.hasOwn(MODES, initialMode)) throw new RangeError("Unsupported initialMode");
  for (const [name, value] of Object.entries({ harmonicComplexity, evolutionRate, musicalEnergy })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be in [0,1]`);
  }
  const key = JSON.stringify([seed, tempo, initialKey, initialMode, harmonicComplexity, evolutionRate, musicalEnergy]);
  let result = cache.get(key);
  if (!result) {
    result = { config: { ...config }, checkpoints: [], live: [] };
    if (cache.size === 8) cache.delete(cache.keys().next().value!);
  }
  cache.delete(key);
  cache.set(key, result);
  return result;
}

function draw(cursor: Cursor): number {
  // Mulberry32: explicit uint32 state, seed zero is valid.
  cursor.random = (cursor.random + 0x6d2b79f5) >>> 0;
  let x = cursor.random;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

interface ChordCandidate {
  root: number;
  key: number;
  degree: number;
  intervals: readonly number[];
  device: "diatonic" | "secondary" | "borrowed" | "pivot";
  pending: number | null;
}
const harmonicFunction = (degree: number): number => [0, 2, 5].includes(degree) ? 0 : [1, 3].includes(degree) ? 1 : 2;
// Static legal voicings only; bounded independently of timeline/checkpoint caches.
const voicings = new Map<string, readonly (readonly number[])[]>();

function legalVoicings(chord: ChordCandidate): readonly (readonly number[])[] {
  const identity = `${chord.root}:${chord.intervals.join(",")}`;
  const cached = voicings.get(identity);
  if (cached) return cached;
  const pcs = chord.intervals.map(n => pc(chord.root + n));
  const result: number[][] = [];
  const seen = new Set<string>();
  for (let inversion = 0; inversion < 3; inversion += 1) {
    if (chord.intervals[2] === 6 && inversion === 0) continue; // do not double a diminished root
    const bass = 36 + pcs[inversion]!;
    const upper = pcs.length === 5 ? pcs.filter((_, i) => i !== inversion)
      : pcs.length === 4 ? pcs
      : [...pcs, chord.intervals[2] === 6 ? pcs[1]! : inversion === 0 ? pcs[2]! : pcs[0]!];
    const options = upper.map(tone => [tone + 48, tone + 60, tone + 72].filter(n => n >= 50 && n <= 79));
    for (const a of options[0]!) for (const b of options[1]!) for (const c of options[2]!) for (const d of options[3]!) {
      const hand = [a, b, c, d].sort((x, y) => x - y);
      if (hand[3]! - hand[0]! > 17 || hand.some((n, i) => i > 0 && (n - hand[i - 1]! > 12 || n === hand[i - 1]! || (hand[i - 1]! < 60 && n - hand[i - 1]! < 3)))) continue;
      const notes = [bass, ...hand];
      const key = notes.join(",");
      if (!seen.has(key)) { seen.add(key); result.push(notes); }
    }
  }
  if (!result.length) throw new Error(`No legal piano voicing for ${identity}`);
  if (voicings.size === 512) voicings.delete(voicings.keys().next().value!);
  voicings.set(identity, result);
  return result;
}

function voice(chord: ChordCandidate, previous: Cursor): { pitches: readonly number[]; cost: number } {
  let best: readonly number[] | undefined;
  let bestCost = Infinity;
  const dominant = previous.pending !== null || (harmonicFunction(previous.degree) === 2
    && previous.pitches.some(n => pc(n - previous.root) === 4));
  const leading = pc(previous.root + 4);
  const seventh = pc(previous.root + 10);
  for (const pitches of legalVoicings(chord)) {
    let cost = 0;
    for (let i = 0; i < 5; i += 1) {
      const old = previous.pitches[i]!;
      const motion = pitches[i]! - old;
      cost += Math.abs(motion) / 5 + Math.max(0, Math.abs(motion) - 7) * 0.3;
      if (i === 4) cost += Math.abs(motion) * 0.25;
      if (previous.index >= 0 && dominant && i > 0) {
        if (pc(old) === leading) cost += motion === 1 ? -0.6 : 5;
        if (pc(old) === seventh) cost += motion === -1 || motion === -2 ? -0.6 : 4;
      }
      if (i > 0 && previous.index >= 0) {
        const oldInterval = pc(old - previous.pitches[i - 1]!);
        const newInterval = pc(pitches[i]! - pitches[i - 1]!);
        if ((newInterval === 0 || newInterval === 7) && newInterval === oldInterval
          && motion * (pitches[i - 1]! - previous.pitches[i - 1]!) > 0) cost += 1.2;
      }
    }
    cost += 0.08 * Math.abs((pitches[1]! + pitches[2]! + pitches[3]! + pitches[4]!) / 4 - 64);
    cost += pc(pitches[0]! - chord.root) === 0 ? 0 : 0.35;
    if (cost < bestCost) { bestCost = cost; best = pitches; }
  }
  if (!best) throw new Error("No scored piano voicing");
  return { pitches: best, cost: bestCost };
}

function advance(previous: Cursor, config: HarmonyConfig): Cursor {
  if (previous.index >= MAX_INDEX) throw new RangeError("time exceeds safe numeric note identities");
  const c: Cursor = { ...previous, index: previous.index + 1, time: previous.time + previous.duration };
  if (c.index > 0) c.phraseAge += 1;
  if (c.phraseAge >= c.phraseLength) {
    c.phraseAge = 0;
    c.phraseIndex += 1;
    c.phraseLength = 4 + Math.floor(draw(c) * 4);
    c.motifPosition = 0;
    // Retain the opening three cells; develop the answer, or invert the whole
    // gesture every fourth phrase. Identity persists instead of restarting.
    c.motif = c.phraseIndex % 4 === 0 ? previous.motif.map(n => -n)
      : [...previous.motif.slice(0, 3), (draw(c) < 0.5 ? -1 : 1) * (1 + Math.floor(draw(c) * 2))];
  }
  const scale = MODES[config.initialMode]!;
  const complexity = clamp(config.harmonicComplexity + 0.12 * macro(c.index, config.seed ^ 0x434d504c));
  const candidates: ChordCandidate[] = [];
  const diatonic = (key: number, degree: number, count: number, mode: readonly number[], device: ChordCandidate["device"]): void => {
    const intervals = Array.from({ length: count }, (_, j) => {
      const d = degree + 2 * j;
      return mode[d % 7]! + 12 * Math.floor(d / 7) - mode[degree]!;
    });
    candidates.push({ root: pc(key + mode[degree]!), key, degree, intervals, device, pending: null });
  };
  for (let degree = 0; degree < 7; degree += 1) {
    if ((c.index === 0 && degree !== 0) || (previous.pending !== null && degree !== previous.pending)) continue;
    diatonic(c.key, degree, 3, scale, "diatonic");
    if (complexity > 0.25) diatonic(c.key, degree, 4, scale, "diatonic");
    if (complexity > 0.7 && [0, 1, 3, 4, 5].includes(degree)) diatonic(c.key, degree, 5, scale, "diatonic");
  }
  if (c.index > 0 && previous.pending === null) {
    // Functional raised leading tone, including in minor/modal tonalities.
    candidates.push({ root: pc(c.key + 7), key: c.key, degree: 4, intervals: [0, 4, 7, 10], device: "secondary", pending: 0 });
    if (complexity > 0.4) {
      for (const degree of [1, 3, 5]) candidates.push({ root: pc(c.key + scale[degree]! + 7), key: c.key, degree, intervals: [0, 4, 7, 10], device: "secondary", pending: degree });
      const parallel = scale[2] === 4 ? MODES.minor! : MODES.major!;
      for (const degree of [3, 5]) diatonic(c.key, degree, 3, parallel, "borrowed");
      if (c.phraseAge === 0 && c.phraseIndex > 0 && config.evolutionRate > 0) {
        for (const offset of [5, 7]) {
          const key = pc(c.key + offset);
          const common = previous.pitches.filter(n => scale.some(tone => pc(key + tone) === pc(n))).length;
          if (common >= 3) diatonic(key, 0, 4, scale, "pivot");
        }
      }
    }
  }
  const desired = 0.15 + 0.42 * Math.sin(Math.PI * c.phraseAge / c.phraseLength) ** 2 + 0.18 * energy(c, config);
  const oldFunction = previous.pending !== null ? 2 : harmonicFunction(previous.degree);
  const scored = candidates.map(chord => {
    const fn = chord.pending !== null ? 2 : harmonicFunction(chord.degree);
    const tension = Math.min(1, [0.12, 0.37, 0.73][fn]! + (chord.intervals.length - 3) * 0.06 + (chord.device === "borrowed" ? 0.12 : 0));
    const pcs = chord.intervals.map(n => pc(n + chord.root));
    const common = new Set(previous.pitches.filter(n => pcs.includes(pc(n))).map(pc)).size;
    const outside = pcs.filter(n => !scale.some(tone => pc(c.key + tone) === n)).length;
    const repeats = previous.memory.filter(d => d === chord.degree).length;
    let functional = [[0.1, 0.65, 0.1], [-0.2, 0.05, 0.95], [0.9, -0.3, -0.45]][oldFunction]![fn]!;
    if (oldFunction === 2 && chord.degree === 0) functional += 0.8;
    if (pc(previous.root - chord.root) === 7) functional += 0.3;
    if (previous.pending !== null) functional += 1;
    const deviceCost = chord.device === "secondary" ? 0.65 : chord.device === "borrowed" ? 1.1 : chord.device === "pivot" ? 0.9 / Math.max(0.1, config.evolutionRate) : 0;
    const score = 2.1 * functional - 3 * Math.abs(tension - desired) + 0.14 * common - 0.2 * outside
      - deviceCost * (1.25 - complexity) - (chord.intervals.length - 3) * (1.25 - complexity)
      - 0.65 * repeats - (chord.degree === previous.degree ? 0.8 : 0)
      - (previous.memory[previous.memory.length - 2] === chord.degree ? 0.7 : 0)
      + (chord.device === "pivot" ? 0.7 * config.evolutionRate : 0)
      + (c.phraseAge === c.phraseLength - 1 && chord.degree === 0 && chord.pending === null ? 1.8 : 0);
    return { chord, tension, score };
  });
  // Harmonic shortlist bounds replay cost; final choice includes actual voicing cost.
  scored.sort((a, b) => b.score - a.score);
  const finalists = scored.slice(0, 6).map(candidate => {
    const voiced = voice(candidate.chord, previous);
    return { ...candidate, pitches: voiced.pitches, score: candidate.score - 0.45 * voiced.cost };
  });
  const maximum = Math.max(...finalists.map(x => x.score));
  const weights = finalists.map(x => Math.exp((x.score - maximum) / (0.56 + 0.23 * complexity)));
  let choice = draw(c) * weights.reduce((a, b) => a + b, 0);
  let selected = finalists[finalists.length - 1]!;
  for (let i = 0; i < finalists.length; i += 1) { choice -= weights[i]!; if (choice < 0) { selected = finalists[i]!; break; } }
  c.key = selected.chord.key;
  c.root = selected.chord.root;
  c.degree = selected.chord.degree;
  c.pending = selected.chord.pending;
  c.pitches = [...selected.pitches];
  c.memory = [...previous.memory.slice(-3), c.degree];
  c.tension = selected.tension;
  c.complexity = complexity;
  // Harmonic rhythm is functional: pressure moves, consonance has room.
  // Phrase endings broaden; a tense dominant cannot sit for eight beats.
  const durationChoice = draw(c);
  c.beats = c.pending !== null || c.tension >= 0.65 ? (durationChoice < 0.75 ? 2 : 3)
    : c.tension < 0.3 ? (durationChoice < 0.4 ? 6 : 8) : (durationChoice < 0.7 ? 4 : 6);
  if (c.phraseAge === c.phraseLength - 1 && c.tension < 0.3) c.beats = 8;
  c.duration = c.beats * 60 / config.tempo;
  if (!Number.isFinite(c.time + c.duration) || c.time + c.duration <= c.time) throw new RangeError("harmony timeline exceeds numeric time precision");
  c.melody = composeMelody(c, config);
  if (c.melody.length) c.melodyEnd = c.melody[c.melody.length - 1]!.pitch;
  return c;
}

function initialCursor(config: HarmonyConfig): Cursor {
  const motif = Array.from({ length: 4 }, (_, i) => {
    const n = sample(config.seed ^ 0x4d4f5446, i);
    return (n < 0.5 ? -1 : 1) * (1 + Math.floor((n * 2 % 1) * 3));
  });
  // A recognizable question turns back toward its starting register.
  motif[3] = motif.slice(0, 3).reduce((a, b) => a + b, 0) > 0 ? -2 : 2;
  return { index: -1, time: 0, duration: 0, beats: 0, random: config.seed,
    key: config.initialKey, degree: 0, pending: null, memory: [],
    pitches: [36, 55, 60, 64, 67], root: 0, tension: 0, complexity: 0,
    phraseIndex: 0, phraseAge: 0, phraseLength: 4 + Math.floor(sample(config.seed, 7) * 4),
    motif, motifRhythm: Array.from({ length: 4 }, (_, i) => [0.5, 1, 1.5][Math.floor(sample(config.seed ^ 0x52485954, i) * 3)]!),
    motifPosition: 0, melodyEnd: 72, melody: [] };
}

function remember(c: Cursor, t: Timeline): void {
  if (c.index % 256 === 0) {
    if (!t.checkpoints.some(old => old.index === c.index) && c.index !== t.anchor?.index) {
      t.checkpoints.push(c);
      if (t.checkpoints.length > (t.anchor ? 31 : 32)) t.checkpoints.shift();
    }
  } else if (c.index !== t.anchor?.index) {
    t.live = t.live.filter(old => old.index !== c.index);
    t.live.push(c);
    if (t.live.length > 2) t.live.shift();
  }
}

function atTime(time: number, t: Timeline): Cursor {
  checkTime(time, t);
  let cursor = initialCursor(t.config);
  if (t.anchor && t.anchor.time <= time) cursor = t.anchor;
  for (const c of t.checkpoints) if (c.time <= time && c.index > cursor.index) cursor = c;
  for (const c of t.live) if (c.time <= time && c.index > cursor.index) cursor = c;
  while (cursor.index < 0 || cursor.time + cursor.duration <= time) {
    if (cursor.index >= 0) remember(cursor, t);
    cursor = advance(cursor, t.config);
  }
  remember(cursor, t);
  return cursor;
}

function copyCursor(c: Cursor): Cursor {
  return { ...c, pitches: [...c.pitches], memory: [...c.memory], motif: [...c.motif], motifRhythm: [...c.motifRhythm], melody: c.melody.map(n => ({ ...n })) };
}

/** JSON-safe snapshot at the chord containing timeSeconds. Detached from the cache. */
export function exportHarmonyCheckpoint(timeSeconds: number, config: HarmonyConfig): HarmonyCheckpoint {
  const t = timeline(config);
  return { version: 3, config: { ...t.config }, state: copyCursor(atTime(timeSeconds, t)) };
}

/** Restore a trusted snapshot after JSON.parse, without replay from zero.
 * Validates structure/ranges, not provenance: callers must not edit snapshot values.
 * Replaces this configuration's cached history; earlier seeks still replay from zero.
 * Imported anchors survive earlier seeks until configuration eviction (eight-config LRU).
 */
export function importHarmonyCheckpoint(checkpoint: unknown): void {
  const fail = (): never => { throw new RangeError("Malformed harmony checkpoint"); };
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
  };
  const integer = (value: unknown, low: number, high: number): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < low || value > high) return fail();
    return value;
  };
  const normalized = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return fail();
    return value;
  };
  const finite = (value: unknown, low: number, high: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) return fail();
    return value;
  };
  const data = record(checkpoint);
  if (data.version !== 3) fail();
  const s = record(data.state);
  const index = integer(s.index, 0, MAX_INDEX);
  if (!Array.isArray(s.memory) || s.memory.length !== Math.min(index + 1, 4)) return fail();
  if (!Array.isArray(s.pitches) || s.pitches.length !== 5) return fail();
  const pitches = s.pitches.map(p => integer(p, 0, 127));
  if (pitches.some((p, i) => i > 0 && p <= pitches[i - 1]!)) fail();
  if (!Array.isArray(s.motif) || s.motif.length !== 4 || !Array.isArray(s.motifRhythm) || s.motifRhythm.length !== 4) return fail();
  if (!Array.isArray(s.melody) || s.melody.length > 48) return fail();
  const time = finite(s.time, 0, Number.MAX_VALUE);
  const duration = finite(s.duration, Number.MIN_VALUE, 640);
  const phraseLength = integer(s.phraseLength, 4, 7);
  const melody = s.melody.map((value, i): HarmonyNote => {
    const n = record(value);
    const holdDuration = finite(n.holdDuration, 0.01, 12);
    const note: HarmonyNote = {
      id: integer(n.id, index * 64 + 5 + i, index * 64 + 5 + i),
      pitch: integer(n.pitch, 60, 83), velocity: normalized(n.velocity),
      startTime: finite(n.startTime, time, time + duration),
      holdDuration, duration: finite(n.duration, 6.01, HARMONY_NOTE_DURATION),
    };
    if (note.startTime >= time + duration || Math.abs(note.duration - holdDuration - 6) > 1e-9) fail();
    return note;
  });
  if (melody.some((n, i) => i > 0 && n.startTime <= melody[i - 1]!.startTime)) fail();
  const state: Cursor = {
    time, duration, beats: integer(s.beats, 2, 8),
    phraseIndex: integer(s.phraseIndex, 0, index), phraseAge: integer(s.phraseAge, 0, phraseLength - 1), phraseLength,
    motif: s.motif.map(n => { const step = integer(n, -3, 3); if (step === 0) fail(); return step; }),
    motifRhythm: s.motifRhythm.map(n => { const length = finite(n, 0.5, 1.5); if (![0.5, 1, 1.5].includes(length)) fail(); return length; }),
    motifPosition: integer(s.motifPosition, 0, 3), melodyEnd: integer(s.melodyEnd, 60, 83), melody,
    index, random: integer(s.random, 0, 0xffffffff), key: integer(s.key, 0, 11),
    degree: integer(s.degree, 0, 6), pending: s.pending === null ? null : integer(s.pending, 0, 6),
    memory: s.memory.map(d => integer(d, 0, 6)), pitches,
    root: integer(s.root, 0, 11), tension: normalized(s.tension), complexity: normalized(s.complexity),
  };
  if (state.memory[state.memory.length - 1] !== state.degree) fail();
  if ((index === 0 && time !== 0) || (index > 0 && time === 0) || ![2, 3, 4, 6, 8].includes(state.beats)
    || (melody.length && melody[melody.length - 1]!.pitch !== state.melodyEnd)) fail();
  const config = record(data.config);
  // Select known fields only: no caller-owned objects enter cached configuration.
  const t = timeline({
    seed: config.seed, tempo: config.tempo, initialKey: config.initialKey, initialMode: config.initialMode,
    harmonicComplexity: config.harmonicComplexity, evolutionRate: config.evolutionRate, musicalEnergy: config.musicalEnergy,
  } as HarmonyConfig);
  if (duration !== state.beats * 60 / t.config.tempo
    || time + duration <= time || !Number.isFinite(time + duration)) fail();
  checkTime(time, t);
  t.anchor = state;
  t.checkpoints = [];
  t.live = [];
}

function checkTime(time: number, t: Timeline): void {
  if (!Number.isFinite(time) || time < 0) throw new RangeError("time must be finite and nonnegative");
  // Eight quarter-note beats is the largest possible harmonic event.
  if (time > MAX_INDEX * 8 * 60 / t.config.tempo) throw new RangeError("time exceeds safe numeric note identities");
}

function makeNote(id: number, pitch: number, velocity: number, startTime: number, hold: number): HarmonyNote {
  const holdDuration = Math.min(12, Math.max(0.01, hold));
  return { id, pitch, velocity: clamp(velocity), startTime, holdDuration, duration: holdDuration + 6 };
}

function notes(c: Cursor, t: Timeline): HarmonyNote[] {
  const level = energy(c, t.config);
  const beat = c.duration / c.beats;
  const gesture = sample(c.random ^ 0x47455354, c.index);
  const spread = Math.min(c.duration * 0.12, 0.03 + 0.12 * sample(c.random ^ 0x524f4c4c, c.index));
  const roles = [0.1, -0.22, -0.16, -0.1, 0.38]; // sum zero: energy remains mean chord velocity
  return c.pitches.map((pitch, voice) => {
    const delay = voice === 0 ? 0 : gesture < 0.33 ? spread * voice / 4
      : gesture < 0.66 ? Math.min(c.duration * 0.45, beat * (voice === 4 ? 0.12 : voice * 0.22))
      : spread * (5 - voice) / 4;
    const velocity = level + Math.min(level, 1 - level) * roles[voice]!;
    const articulation = voice === 0 ? 0.92 : voice === 4 ? 0.55 : 0.65;
    return makeNote(c.index * 64 + voice, pitch, velocity, c.time + delay,
      (c.duration - delay) * articulation);
  });
}

/** A persistent four-cell interval/rhythm motif, developed in phrase-sized answers.
 * Weak-beat dissonance is always paired with its stepwise chord-tone resolution.
 * Phrase endings leave air, rather than filling every available subdivision.
 */
function composeMelody(c: Cursor, config: HarmonyConfig): readonly HarmonyNote[] {
  const result: HarmonyNote[] = [];
  const beat = c.duration / c.beats;
  const scale = MODES[config.initialMode]!;
  const chordPcs = new Set(c.pitches.map(pc));
  const chordTones = Array.from({ length: 24 }, (_, i) => i + 60).filter(n => chordPcs.has(pc(n)));
  const scaleTones = Array.from({ length: 24 }, (_, i) => i + 60).filter(n => scale.some(d => pc(c.key + d) === pc(n)) || chordPcs.has(pc(n)));
  const nearest = (pool: readonly number[], target: number): number => {
    if (!pool.length) throw new Error("Empty melodic register");
    let best = pool[0]!;
    for (const pitch of pool) if (Math.abs(pitch - target) < Math.abs(best - target)) best = pitch;
    return best;
  };
  const level = energy(c, config);
  const phraseEnd = c.phraseAge === c.phraseLength - 1;
  const limit = c.beats * (phraseEnd ? 0.7 : 0.94);
  let position = c.phraseAge === 0 ? 0.5 : c.phraseAge % 2 === 0 ? 0.25 : 0.75;
  let last = c.melodyEnd;
  let cell = c.motifPosition;
  const emit = (pitch: number, when: number, length: number, accent: number): void => {
    if (result.length >= 48) throw new Error("Melodic event budget exceeded");
    result.push(makeNote(c.index * 64 + 5 + result.length, pitch,
      level * (1.06 + accent) + 0.02, c.time + when * beat, length * beat * 0.8));
    last = pitch;
  };
  while (position < limit && result.length < 40) {
    const slot = cell % 4;
    const length = c.motifRhythm[slot]! * (phraseEnd ? 1.5 : 1);
    const interval = c.motif[slot]!;
    // The same gesture rises toward the phrase apex, then answers below it.
    const contour = c.phraseAge < c.phraseLength / 2 ? 1 : -1;
    const scaleIndex = scaleTones.indexOf(nearest(scaleTones, last));
    const target = scaleTones[Math.max(0, Math.min(scaleTones.length - 1, scaleIndex + interval * contour))]!;
    const cadentialTones = chordTones.filter(n => pc(n) === c.root);
    const anchor = nearest(phraseEnd && position + length >= limit ? cadentialTones : chordTones, target);
    const rest = slot === 3 && c.phraseAge % 2 === 1 && !phraseEnd;
    if (!rest) {
      // Prepared suspension at a chord change, or a neighboring/passing tone
      // into a real harmonic anchor. No orphaned non-chord tones at the edge.
      const prepared = result.length === 0 && !chordPcs.has(pc(last)) && Math.abs(last - anchor) <= 2 ? last : null;
      const step = Math.sign(anchor - last) || -contour;
      const passing = prepared ?? (anchor - step);
      const dissonance = !chordPcs.has(pc(passing)) && passing >= 60 && passing <= 83
        && (prepared !== null || (scaleTones.includes(passing) && Math.abs(passing - last) <= 2))
        && position + length * 0.45 < limit;
      if (dissonance) {
        emit(passing, position, length * 0.35, -0.08);
        emit(anchor, position + length * 0.4, length * 0.6, 0.08);
      } else emit(anchor, position, length, slot === 0 ? 0.1 : 0);
    }
    cell += 1;
    position += length;
  }
  c.motifPosition = cell % 4;
  return result;
}

/** Current harmonic visual slots. Their first onset is the exact chord boundary.
 * duration/beats describe variable harmonic rhythm; notes have their own holds.
 * Warm frame lookup uses two live cursors; cold seeks replay sparse checkpoints.
 */
export function harmonyAt(timeSeconds: number, config: HarmonyConfig): HarmonyState {
  const t = timeline(config);
  const c = atTime(timeSeconds, t);
  return {
    index: c.index, startTime: c.time, duration: c.duration, beats: c.beats,
    root: c.root, tonalCenter: c.key, tension: c.tension,
    brightness: c.pitches.reduce((sum, p) => sum + p, 0) / 5 / 127,
    complexity: c.complexity, energy: energy(c, t.config),
    phraseProgress: (c.phraseAge + (timeSeconds - c.time) / c.duration) / c.phraseLength,
    notes: notes(c, t),
  };
}

/** Onsets in [from,to), with harmonic and motif notes, sorted by onset/id.
 * Every onset belongs inside its chord, so no heuristic lookback is needed.
 * Use HARMONY_NOTE_DURATION externally to collect still-ringing tails.
 */
export function harmonyNotesBetween(from: number, to: number, config: HarmonyConfig): readonly HarmonyNote[] {
  const t = timeline(config);
  checkTime(from, t);
  checkTime(to, t);
  if (to < from) throw new RangeError("to must be >= from");
  if (to === from) return [];
  let c = atTime(from, t);
  const result: HarmonyNote[] = [];
  while (c.time < to) {
    for (const note of [...notes(c, t), ...c.melody]) if (note.startTime >= from && note.startTime < to) result.push({ ...note });
    const next = c.time + c.duration;
    if (next >= to) break;
    c = atTime(next, t);
  }
  return result.sort((a, b) => a.startTime - b.startTime || a.id - b.id);
}
