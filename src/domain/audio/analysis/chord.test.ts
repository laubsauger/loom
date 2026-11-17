import { describe, expect, it } from "vitest";

import {
  CHORD_NONE_SCORE,
  CHORD_PENALTY,
  CHORD_STATES,
  chordLead,
  chordQualityOf,
  chordRootOf,
  chordScores,
  chordStateOf,
  createChordEstimator,
  createKeyEstimator,
  stickyDecoder,
  decodeChords,
  decodeKeys,
  KEY_FILE_SECONDS,
  KEY_PROFILE_MAJOR,
  KEY_STATES,
  keyScores,
  stickyPath,
} from "./chord.ts";

/**
 * T1753b — chord and key on pitch-class profiles whose answer is known. The profiles are
 * written by hand (a triad is three ones), so every score is closed-form and the decode's
 * timing is arithmetic: a state takes over when it has out-scored the holder by the penalty.
 */
const DT = 2048 / 48000;
const triad = (root: number, quality: 1 | 2): number[] => {
  const profile = new Array<number>(12).fill(0);
  for (const interval of [0, quality === 1 ? 4 : 3, 7]) profile[(root + interval) % 12] = 1;
  return profile;
};
const classes = (...sounding: number[]): number[] => Array.from({ length: 12 }, (_, index) => (sounding.includes(index) ? 1 : 0));
const C = triad(0, 1);
const F = triad(5, 1);
const Am = triad(9, 2);

describe("the sticky decode: a state takes over when it has out-scored the holder by the penalty", () => {
  const scoresOf = (state: number): number[] => [0, 1].map((index) => (index === state ? 1 : 0));

  it("forward: the switch comes ceil(penalty / lead) frames after the evidence changes, and not one frame sooner", () => {
    const decoder = stickyDecoder(2, 0.35, 0);
    for (let frame = 0; frame < 10; frame += 1) expect(decoder.push(scoresOf(0), 0.1)).toBe(0);
    // State 1 leads by 1 per second: 0.35 is passed on the fourth frame of 0.1 s.
    expect([0, 1, 2, 3, 4].map(() => decoder.push(scoresOf(1), 0.1))).toEqual([0, 0, 0, 1, 1]);
  });

  it("forward: a blip shorter than the penalty changes nothing, and equal evidence keeps the holder", () => {
    const decoder = stickyDecoder(2, 0.35, 0);
    decoder.push(scoresOf(0), 0.1);
    expect([decoder.push(scoresOf(1), 0.1), decoder.push(scoresOf(1), 0.1), decoder.push(scoresOf(0), 0.1)]).toEqual([0, 0, 0]);
    const tied = stickyDecoder(2, 0.35, 1);
    for (let frame = 0; frame < 50; frame += 1) expect(tied.push([0.5, 0.5], 0.1)).toBe(1);
  });

  it("with the whole sequence in hand the switch is ON the frame the evidence changes, and a blip is still ignored", () => {
    const sequence = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1];
    const scores = Float64Array.from(sequence.flatMap(scoresOf));
    const path = stickyPath(scores, 2, new Float64Array(sequence.length).fill(0.1), 0.35, 0);
    // The single frame of state 0 at index 11 is not worth two switches.
    expect([...path]).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("chord scores", () => {
  it("a triad's own state scores the chroma confidence; one sharing two notes two thirds of it; none its constant", () => {
    const scores = new Float64Array(CHORD_STATES);
    chordScores(C, 0.9, scores);
    expect(scores[chordStateOf(0, 1)]).toBeCloseTo(0.9, 12);
    expect(scores[chordStateOf(9, 2)]).toBeCloseTo(0.9 * (2 / 3), 12);
    expect(scores[chordStateOf(6, 1)]).toBe(0);
    expect(scores[0]).toBe(CHORD_NONE_SCORE);
    expect(chordLead(scores, chordStateOf(0, 1))).toBeCloseTo(0.9 / 3, 12);
    expect([chordRootOf(chordStateOf(9, 2)), chordQualityOf(chordStateOf(9, 2)), chordRootOf(0), chordQualityOf(0)]).toEqual([9, 2, 0, 0]);
  });

  it("silence scores no triad at all", () => {
    const scores = new Float64Array(CHORD_STATES);
    chordScores(new Array(12).fill(0), 0, scores);
    expect([...scores.subarray(1)]).toEqual(new Array(24).fill(0));
  });
});

describe("the live chord estimate", () => {
  const run = (frames: ReadonlyArray<readonly [number[], number]>) => {
    const estimator = createChordEstimator();
    return frames.map(([profile, confidence]) => estimator.push(profile, confidence, DT));
  };
  const repeat = (profile: number[], confidence: number, count: number): Array<readonly [number[], number]> => Array.from({ length: count }, () => [profile, confidence] as const);

  it("C major is claimed once it has out-scored 'none' by the penalty: after ceil(penalty / (1 − none) / dt) frames, at full confidence", () => {
    const claims = run(repeat(C, 1, 30));
    const first = claims.findIndex((claim) => claim.quality !== 0);
    expect(first).toBe(Math.ceil(CHORD_PENALTY / (1 - CHORD_NONE_SCORE) / DT) - 1);
    expect(claims[first]).toEqual({ root: 0, quality: 1, confidence: 1, changed: true, age: 0 });
    expect(claims[first + 1]).toEqual({ root: 0, quality: 1, confidence: 1, changed: false, age: DT });
    expect(claims.filter((claim) => claim.changed)).toHaveLength(1);
  });

  it("C to F: one change, reported ceil(penalty / lead / dt) frames after it — never before — and to A minor, which shares two notes, twice as late", () => {
    const toF = run([...repeat(C, 1, 40), ...repeat(F, 1, 40)]);
    const toAm = run([...repeat(C, 1, 40), ...repeat(Am, 1, 40)]);
    const change = (claims: ReturnType<typeof run>): number => claims.findIndex((claim, index) => index >= 40 && claim.changed);
    // F against C on F's chroma: 1 − 1/3. A minor against C on A minor's: 1 − 2/3.
    expect(change(toF)).toBe(40 + Math.ceil(CHORD_PENALTY / (2 / 3) / DT) - 1);
    expect(change(toAm)).toBe(40 + Math.ceil(CHORD_PENALTY / (1 / 3) / DT) - 1);
    expect([toF[79]?.root, toF[79]?.quality, toAm[79]?.root, toAm[79]?.quality]).toEqual([5, 1, 9, 2]);
    expect(toF.filter((claim) => claim.changed)).toHaveLength(2);
  });

  it("a drum hit across two frames does not change the chord", () => {
    const hit = classes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
    const claims = run([...repeat(C, 1, 30), ...repeat(hit, 0.1, 2), ...repeat(C, 1, 30)]);
    expect(claims.filter((claim) => claim.changed)).toHaveLength(1);
    expect(claims[61]).toMatchObject({ root: 0, quality: 1 });
  });

  it("claims NOTHING where the quality is unknowable or nothing is tonal: a single note, a bare fifth, noise, silence", () => {
    for (const [profile, confidence] of [
      [classes(9), 1],
      [classes(0, 7), 1],
      [classes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11), 0.15],
      [classes(), 0],
    ] as const) {
      const claims = run(repeat(profile, confidence, 60));
      expect(claims.every((claim) => claim.quality === 0 && claim.root === 0 && claim.confidence === 0 && !claim.changed)).toBe(true);
    }
  });

  it("music then silence: the claim ends, which is a change, and the age returns to 0", () => {
    const claims = run([...repeat(C, 1, 30), ...repeat(classes(), 0, 30)]);
    expect(claims[59]).toEqual({ root: 0, quality: 0, confidence: 0, changed: false, age: 0 });
    expect(claims.filter((claim) => claim.changed)).toHaveLength(2);
  });

  it("confidence is the lead: a triad heard at chroma confidence 0.6 leads by 0.2 and reads 0.8", () => {
    const claims = run(repeat(C, 0.6, 80));
    expect(claims[79]?.confidence).toBeCloseTo(0.6 / 3 / 0.25, 9);
  });
});

describe("the whole-file chord decode", () => {
  const profilesOf = (sequence: ReadonlyArray<number[]>): Float64Array => Float64Array.from(sequence.flat());

  it("C to F: the boundary is ON the frame the chroma changes, both chords are claimed from their first frame, and there are two changes", () => {
    const sequence = [...Array.from({ length: 40 }, () => C), ...Array.from({ length: 40 }, () => F)];
    const claims = decodeChords(profilesOf(sequence), new Array(80).fill(1), DT);
    expect(claims.map((claim) => claim.root)).toEqual([...new Array(40).fill(0), ...new Array(40).fill(5)]);
    expect(claims.every((claim) => claim.quality === 1 && claim.confidence === 1)).toBe(true);
    expect(claims.flatMap((claim, index) => (claim.changed ? [index] : []))).toEqual([0, 40]);
    expect(claims[39]?.age).toBeCloseTo(39 * DT, 12);
    expect([claims[40]?.age, claims[41]?.age]).toEqual([0, DT]);
  });

  it("silence before the music is not a chord, and a two-frame hit inside it is not a change", () => {
    const hit = classes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
    const sequence = [...Array.from({ length: 20 }, () => classes()), ...Array.from({ length: 20 }, () => C), hit, hit, ...Array.from({ length: 20 }, () => C)];
    const confidences = [...new Array(20).fill(0), ...new Array(20).fill(1), 0.1, 0.1, ...new Array(20).fill(1)];
    const claims = decodeChords(profilesOf(sequence), confidences, DT);
    expect(claims.slice(0, 20).every((claim) => claim.quality === 0)).toBe(true);
    expect(claims.flatMap((claim, index) => (claim.changed ? [index] : []))).toEqual([20]);
  });
});

describe("key", () => {
  /** I, IV, V, I a second each, over and over: the scale's seven classes, weighted as a cadence weights them. */
  const cadence = (tonic: number, mode: 1 | 2): number[][] => {
    // In minor the dominant is MAJOR (the raised seventh): that leading note is what tells a
    // minor key from its relative major, whose notes are otherwise the same seven.
    const degrees = mode === 1 ? ([[0, 1], [5, 1], [7, 1], [0, 1]] as const) : ([[0, 2], [5, 2], [7, 1], [0, 2]] as const);
    return degrees.flatMap(([interval, quality]) => Array.from({ length: Math.round(1 / DT) }, () => triad((tonic + interval) % 12, quality)));
  };
  const loop = (frames: number[][], seconds: number): number[][] => Array.from({ length: Math.round(seconds / DT) }, (_, index) => frames[index % frames.length] as number[]);

  it("the key's own profile correlates 1 with it, and flat input with nothing", () => {
    const scores = new Float64Array(KEY_STATES);
    keyScores([...KEY_PROFILE_MAJOR], scores);
    expect(scores[chordStateOf(0, 1)]).toBeCloseTo(1, 12);
    keyScores(new Array(12).fill(0.4), scores);
    expect([...scores]).toEqual(new Array(KEY_STATES).fill(0));
  });

  it("live: a C major cadence is C major and an A minor one is A minor, and neither is claimed before there is evidence", () => {
    for (const [tonic, mode] of [
      [0, 1],
      [9, 2],
      [3, 1],
    ] as const) {
      const estimator = createKeyEstimator();
      const claims = loop(cadence(tonic, mode), 40).map((profile) => estimator.push(profile, 1, DT));
      expect(claims[0]).toEqual({ tonic: 0, mode: 0, confidence: 0 });
      const last = claims[claims.length - 1]!;
      expect([last.tonic, last.mode]).toEqual([tonic, mode]);
      expect(last.confidence).toBeGreaterThan(0.5);
      // The first claim is weak: confidence grows with the seconds of music heard.
      const first = claims.find((claim) => claim.mode !== 0)!;
      expect(first.confidence).toBeLessThan(last.confidence);
    }
  });

  it("live: unconfident input is not evidence — a cadence heard at weight 0 claims no key however long it runs", () => {
    const estimator = createKeyEstimator();
    const claims = loop(cadence(0, 1), 40).map((profile) => estimator.push(profile, 0, DT));
    expect(claims.every((claim) => claim.confidence === 0)).toBe(true);
  });

  it("a whole file: C major for 40 s then E flat major for 40 s is those two keys, each from its first frame to the change, give or take the window", () => {
    const frames = [...loop(cadence(0, 1), 40), ...loop(cadence(3, 1), 40)];
    const claims = decodeKeys(Float64Array.from(frames.flat()), new Array(frames.length).fill(1), DT);
    const change = Math.round(40 / DT);
    expect([claims[0]?.tonic, claims[0]?.mode]).toEqual([0, 1]);
    expect([claims[frames.length - 1]?.tonic, claims[frames.length - 1]?.mode]).toEqual([3, 1]);
    const boundary = claims.findIndex((claim) => claim.tonic === 3);
    // The centred window is 30 s: the boundary sits within a few seconds of the change, not 15 s late.
    expect(Math.abs(boundary - change) * DT).toBeLessThan(5);
    // No third key is ever named. Where the window straddles the modulation neither key may
    // lead, and such a stretch is NO CLAIM rather than a guess — inside the window's reach only.
    const named = new Set(claims.map((claim) => `${claim.tonic}/${claim.mode}`));
    named.delete("0/0");
    expect(named).toEqual(new Set(["0/1", "3/1"]));
    const unclaimed = claims.flatMap((claim, index) => (claim.mode === 0 ? [index] : []));
    expect(unclaimed.every((index) => Math.abs(index - change) * DT < KEY_FILE_SECONDS / 2)).toBe(true);
  });
});
